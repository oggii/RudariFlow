//! Speaker separation for the Files tab: who speaks when, with sherpa-onnx
//! (pyannote segmentation 3.0 and the 3D-Speaker ERes2Net voice embedding).

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::downloader::{download_file, DownloadProgress};

/// sherpa-onnx's C API, next to rudariflow.exe (delay-loaded, see build.rs).
const RUNTIME_DLL: &str = "sherpa-onnx-c-api.dll";

/// Whether the sherpa-onnx runtime loads. Checked before every call into
/// it: a delay-loaded DLL that is missing would end the process.
pub fn runtime_available() -> bool {
    imp::load(RUNTIME_DLL)
}

/// Who speaks from `start_ms` to `end_ms`, as sherpa-onnx numbers the
/// speakers (0-based, in no particular order).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Turn {
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker: u32,
}

/// How many speakers to separate: found by the model, or a given number.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SpeakerCount {
    Auto,
    Exactly(u32),
}

/// The Files tab's setting: "off", "auto" or "2" … "8". `None` means off
/// (and anything unknown).
pub fn parse_setting(value: &str) -> Option<SpeakerCount> {
    match value.trim() {
        "auto" => Some(SpeakerCount::Auto),
        other => other.parse::<u32>().ok().filter(|n| (2..=8).contains(n)).map(SpeakerCount::Exactly),
    }
}

/// The speaker of each span (a Whisper segment, start and end in ms): the
/// one that talks most during it; a span no turn overlaps gets the nearest
/// turn's speaker; a tie goes to the voice heard first. Speakers are then
/// numbered by their first span, so the first voice is 0.
pub fn assign(spans: &[(u64, u64)], turns: &[Turn]) -> Vec<Option<u8>> {
    if turns.is_empty() {
        return vec![None; spans.len()];
    }
    let first_heard = |speaker: u32| {
        turns.iter().filter(|t| t.speaker == speaker).map(|t| t.start_ms).min().unwrap_or(u64::MAX)
    };
    let mut speakers: Vec<u32> = turns.iter().map(|t| t.speaker).collect();
    speakers.sort_unstable();
    speakers.dedup();
    // Earliest voice first, so the fold below keeps it on a tie.
    speakers.sort_by_key(|&s| first_heard(s));

    let raw: Vec<u32> = spans
        .iter()
        .map(|&(start, end)| {
            let overlap = |s: u32| -> u64 {
                turns
                    .iter()
                    .filter(|t| t.speaker == s)
                    .map(|t| end.min(t.end_ms).saturating_sub(start.max(t.start_ms)))
                    .sum()
            };
            let distance = |s: u32| -> u64 {
                turns
                    .iter()
                    .filter(|t| t.speaker == s)
                    .map(|t| {
                        if t.end_ms <= start {
                            start - t.end_ms
                        } else {
                            t.start_ms.saturating_sub(end)
                        }
                    })
                    .min()
                    .unwrap_or(u64::MAX)
            };
            // First maximum (earliest voice) on a tie.
            let best = speakers.iter().copied().fold(None::<(u32, u64)>, |best, s| {
                let o = overlap(s);
                match best {
                    Some((_, b)) if b >= o => best,
                    _ => Some((s, o)),
                }
            });
            match best {
                Some((s, o)) if o > 0 => s,
                _ => speakers.iter().copied().min_by_key(|&s| distance(s)).unwrap_or(speakers[0]),
            }
        })
        .collect();

    let mut order: Vec<u32> = Vec::new();
    raw.iter()
        .map(|&s| {
            let index = order.iter().position(|&o| o == s).unwrap_or_else(|| {
                order.push(s);
                order.len() - 1
            });
            u8::try_from(index).ok()
        })
        .collect()
}

/// A model file of the speaker separation, pinned by size and SHA-256.
pub struct ModelFile {
    pub file: &'static str,
    pub url: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

/// pyannote segmentation 3.0 (where speech and speaker changes are) and
/// 3D-Speaker ERes2Net (a voice fingerprint per stretch of speech). ERes2Net
/// labelled the probe files best of four embedding models (see the spec).
pub const MODELS: [ModelFile; 2] = [
    ModelFile {
        file: "segmentation.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx",
        bytes: 5_992_913,
        sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
    },
    ModelFile {
        file: "embedding.onnx",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
        bytes: 39_593_761,
        sha256: "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b",
    },
];

pub fn model_dir(app_dir: &Path) -> PathBuf {
    app_dir.join("speakers")
}

/// `path` exists at `m`'s pinned size (the SHA-256 is checked once, after
/// the download).
fn model_present(path: &Path, m: &ModelFile) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.len() == m.bytes)
}

/// Both model files are there with their full size.
pub fn models_ready(app_dir: &Path) -> bool {
    MODELS.iter().all(|m| model_present(&model_dir(app_dir).join(m.file), m))
}

fn sha256_of(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Download the missing model files, resumable, each checked by SHA-256.
/// `on_progress` gets the bytes of both files together.
pub async fn download_models(app_dir: &Path, mut on_progress: impl FnMut(DownloadProgress)) -> Result<(), String> {
    let dir = model_dir(app_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let total: u64 = MODELS.iter().map(|m| m.bytes).sum();
    let mut before = 0;
    for m in &MODELS {
        let dest = dir.join(m.file);
        if !model_present(&dest, m) {
            download_file(m.url, &dest, |p| {
                let downloaded = before + p.downloaded;
                on_progress(DownloadProgress { downloaded, total, percent: downloaded as f64 * 100.0 / total as f64 });
            })
            .await?;
            if sha256_of(&dest)? != m.sha256 {
                let _ = std::fs::remove_file(&dest);
                return Err(format!("{} did not download correctly; please try again", m.file));
            }
        }
        before += m.bytes;
    }
    Ok(())
}

/// Threads for separation: half the logical CPUs, 1 to 8. On a 24-thread
/// Ryzen 9 7900X 8 threads were fastest (12 were slower).
pub fn threads() -> i32 {
    let logical = std::thread::available_parallelism().map_or(2, |n| n.get());
    (logical / 2).clamp(1, 8) as i32
}

/// Who speaks when in `audio` (16 kHz mono), on the CPU. `progress(done,
/// total)` comes from sherpa-onnx while it runs (chunks of the file).
pub fn separate(
    audio: &[f32],
    count: SpeakerCount,
    app_dir: &Path,
    progress: &mut dyn FnMut(u32, u32),
) -> Result<Vec<Turn>, String> {
    if !runtime_available() {
        return Err("the speaker runtime (sherpa-onnx-c-api.dll) is missing".to_string());
    }
    let n_samples =
        i32::try_from(audio.len()).map_err(|_| "the file is too long to separate speakers".to_string())?;
    imp::separate(audio, n_samples, count, &model_dir(app_dir), progress)
}

#[cfg(windows)]
mod imp {
    use std::ffi::CString;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::{null, null_mut};

    use sherpa_rs_sys as sys;
    use windows_sys::Win32::Globalization::{GetACP, WideCharToMultiByte, CP_UTF8, WC_NO_BEST_FIT_CHARS};
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;

    use super::{threads, SpeakerCount, Turn, MODELS};

    /// With a number, clustering makes exactly that many speakers; with Auto
    /// it merges voices closer than this. 0.9 was the only value that counted
    /// the three probe files right (4, 2 and 2 speakers).
    const AUTO_THRESHOLD: f32 = 0.9;
    /// sherpa-onnx's defaults, used in the probe: shorter speech is dropped,
    /// shorter gaps of one speaker are closed.
    const MIN_DURATION_ON: f32 = 0.3;
    const MIN_DURATION_OFF: f32 = 0.5;

    pub fn load(dll: &str) -> bool {
        use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;
        let wide: Vec<u16> = dll.encode_utf16().chain(std::iter::once(0)).collect();
        // The module stays loaded; the delay-load helper then finds it.
        !unsafe { LoadLibraryW(wide.as_ptr()) }.is_null()
    }

    /// A model path as sherpa-onnx can open it. sherpa-onnx reads its models
    /// with a narrow `std::ifstream`, which takes the path in the ANSI code
    /// page (Windows-1252 on English and German Windows), not UTF-8: a UTF-8
    /// "C:\Users\Jürg" names a folder that does not exist. A path the code
    /// page holds goes in that code page; any other as its 8.3 short name,
    /// which is ASCII on volumes that keep short names.
    fn narrow_path(path: &Path) -> Result<CString, String> {
        narrow_path_in(path, unsafe { GetACP() })
    }

    pub fn narrow_path_in(path: &Path, code_page: u32) -> Result<CString, String> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        let bytes = encode(&wide, code_page)
            .or_else(|| short_path(&wide).and_then(|short| encode(&short, code_page)))
            .ok_or_else(|| "the speaker model's folder name contains characters sherpa-onnx cannot open".to_string())?;
        CString::new(bytes).map_err(|e| e.to_string())
    }

    /// `wide` in `code_page`, or `None` when a character is not in it: no
    /// best-fit stand-ins such as "a" for "ā", which would name another path.
    pub fn encode(wide: &[u16], code_page: u32) -> Option<Vec<u8>> {
        if code_page == CP_UTF8 {
            // Windows' "Use Unicode UTF-8 for worldwide language support".
            return String::from_utf16(wide).ok().map(String::into_bytes);
        }
        if wide.is_empty() {
            return Some(Vec::new());
        }
        let len = i32::try_from(wide.len()).ok()?;
        let flags = WC_NO_BEST_FIT_CHARS;
        unsafe {
            let size = WideCharToMultiByte(code_page, flags, wide.as_ptr(), len, null_mut(), 0, null(), null_mut());
            if size <= 0 {
                return None;
            }
            let mut out = vec![0u8; size as usize];
            let mut used_default = 0;
            let written =
                WideCharToMultiByte(code_page, flags, wide.as_ptr(), len, out.as_mut_ptr(), size, null(), &mut used_default);
            (written == size && used_default == 0).then_some(out)
        }
    }

    /// The 8.3 short form of an existing path.
    fn short_path(wide: &[u16]) -> Option<Vec<u16>> {
        let long: Vec<u16> = wide.iter().copied().chain(std::iter::once(0)).collect();
        unsafe {
            let needed = GetShortPathNameW(long.as_ptr(), null_mut(), 0);
            if needed == 0 {
                return None;
            }
            let mut short = vec![0u16; needed as usize];
            let len = GetShortPathNameW(long.as_ptr(), short.as_mut_ptr(), needed);
            if len == 0 || len >= needed {
                return None;
            }
            short.truncate(len as usize);
            Some(short)
        }
    }

    unsafe extern "C" fn progress_callback(done: i32, total: i32, arg: *mut std::ffi::c_void) -> i32 {
        let progress = &mut *(arg as *mut &mut dyn FnMut(u32, u32));
        progress(done.max(0) as u32, total.max(0) as u32);
        0
    }

    pub fn separate(
        audio: &[f32],
        n_samples: i32,
        count: SpeakerCount,
        dir: &Path,
        progress: &mut dyn FnMut(u32, u32),
    ) -> Result<Vec<Turn>, String> {
        let segmentation = narrow_path(&dir.join(MODELS[0].file))?;
        let embedding = narrow_path(&dir.join(MODELS[1].file))?;
        let provider = CString::new("cpu").expect("no NUL");
        let threads = threads();
        let num_clusters = match count {
            SpeakerCount::Auto => -1,
            SpeakerCount::Exactly(n) => n as i32,
        };
        let config = sys::SherpaOnnxOfflineSpeakerDiarizationConfig {
            segmentation: sys::SherpaOnnxOfflineSpeakerSegmentationModelConfig {
                pyannote: sys::SherpaOnnxOfflineSpeakerSegmentationPyannoteModelConfig { model: segmentation.as_ptr() },
                num_threads: threads,
                debug: 0,
                provider: provider.as_ptr(),
            },
            embedding: sys::SherpaOnnxSpeakerEmbeddingExtractorConfig {
                model: embedding.as_ptr(),
                num_threads: threads,
                debug: 0,
                provider: provider.as_ptr(),
            },
            clustering: sys::SherpaOnnxFastClusteringConfig { num_clusters, threshold: AUTO_THRESHOLD },
            min_duration_on: MIN_DURATION_ON,
            min_duration_off: MIN_DURATION_OFF,
        };

        struct Diarization(*const sys::SherpaOnnxOfflineSpeakerDiarization);
        impl Drop for Diarization {
            fn drop(&mut self) {
                unsafe { sys::SherpaOnnxDestroyOfflineSpeakerDiarization(self.0) }
            }
        }

        unsafe {
            let sd = sys::SherpaOnnxCreateOfflineSpeakerDiarization(&config);
            if sd.is_null() {
                return Err("the speaker model could not be loaded".to_string());
            }
            let sd = Diarization(sd);
            let rate = sys::SherpaOnnxOfflineSpeakerDiarizationGetSampleRate(sd.0);
            if rate != 16_000 {
                return Err(format!("the speaker model expects {rate} Hz"));
            }
            let mut progress: &mut dyn FnMut(u32, u32) = progress;
            let arg = &mut progress as *mut &mut dyn FnMut(u32, u32) as *mut std::ffi::c_void;
            let result = sys::SherpaOnnxOfflineSpeakerDiarizationProcessWithCallback(
                sd.0,
                audio.as_ptr(),
                n_samples,
                Some(progress_callback),
                arg,
            );
            if result.is_null() {
                return Err("speaker separation failed".to_string());
            }
            let n = sys::SherpaOnnxOfflineSpeakerDiarizationResultGetNumSegments(result);
            let segments = sys::SherpaOnnxOfflineSpeakerDiarizationResultSortByStartTime(result);
            let mut turns = Vec::new();
            if !segments.is_null() && n > 0 {
                for s in std::slice::from_raw_parts(segments, n as usize) {
                    turns.push(Turn {
                        start_ms: (s.start.max(0.0) * 1000.0) as u64,
                        end_ms: (s.end.max(0.0) * 1000.0) as u64,
                        speaker: s.speaker.max(0) as u32,
                    });
                }
                sys::SherpaOnnxOfflineSpeakerDiarizationDestroySegment(segments);
            }
            sys::SherpaOnnxOfflineSpeakerDiarizationDestroyResult(result);
            Ok(turns)
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::Path;

    use super::{SpeakerCount, Turn};

    pub fn load(_dll: &str) -> bool {
        false
    }

    pub fn separate(
        _audio: &[f32],
        _n_samples: i32,
        _count: SpeakerCount,
        _dir: &Path,
        _progress: &mut dyn FnMut(u32, u32),
    ) -> Result<Vec<Turn>, String> {
        Err("speaker separation needs Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(start_s: f32, end_s: f32, speaker: u32) -> Turn {
        Turn { start_ms: (start_s * 1000.0) as u64, end_ms: (end_s * 1000.0) as u64, speaker }
    }

    #[test]
    fn segments_take_the_speaker_with_most_overlap_numbered_by_first_voice() {
        // sherpa-onnx calls the first voice 1 here; RudariFlow calls it 0.
        let turns = [turn(0.0, 5.0, 1), turn(5.0, 9.0, 0)];
        let spans = [(0, 4_000), (4_500, 8_000), (8_500, 9_500)];
        assert_eq!(assign(&spans, &turns), vec![Some(0), Some(1), Some(1)]);
    }

    #[test]
    fn gaps_go_to_the_nearest_turn_and_ties_to_the_earlier_voice() {
        let turns = [turn(0.0, 9.0, 0), turn(12.5, 20.0, 1)];
        // 10-11 s: 1 s after the first turn, 1.5 s before the second.
        assert_eq!(assign(&[(10_000, 11_000)], &turns), vec![Some(0)]);
        // Equal overlap with both: the voice heard first wins.
        let tie = [turn(0.0, 2.0, 0), turn(2.0, 4.0, 1)];
        assert_eq!(assign(&[(1_000, 3_000)], &tie), vec![Some(0)]);
    }

    #[test]
    fn no_turns_means_no_speakers() {
        assert_eq!(assign(&[(0, 1_000), (1_000, 2_000)], &[]), vec![None, None]);
    }

    #[test]
    fn the_setting_reads_off_auto_and_two_to_eight() {
        assert_eq!(parse_setting("off"), None);
        assert_eq!(parse_setting("auto"), Some(SpeakerCount::Auto));
        assert_eq!(parse_setting("3"), Some(SpeakerCount::Exactly(3)));
        assert_eq!(parse_setting("8"), Some(SpeakerCount::Exactly(8)));
        for bad in ["1", "9", "", "two"] {
            assert_eq!(parse_setting(bad), None, "{bad}");
        }
    }

    #[test]
    fn models_are_pinned_and_threads_are_capped() {
        assert_eq!(MODELS.len(), 2);
        for m in &MODELS {
            assert_eq!(m.sha256.len(), 64, "{}", m.file);
            assert!(m.url.starts_with("https://"), "{}", m.file);
        }
        let dir = std::env::temp_dir().join("rudariflow_speakers_ready");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!models_ready(&dir));
        assert!((1..=8).contains(&threads()));
    }

    /// Windows-1252, the ANSI code page of English and German Windows.
    #[cfg(windows)]
    const WESTERN: u32 = 1252;

    #[cfg(windows)]
    #[test]
    fn model_paths_go_in_the_code_page_only_when_it_holds_every_character() {
        use super::imp::encode;
        let wide = |s: &str| s.encode_utf16().collect::<Vec<u16>>();
        assert_eq!(encode(&wide(r"C:\t\rf-tëst"), WESTERN), Some(b"C:\\t\\rf-t\xEBst".to_vec()));
        assert_eq!(encode(&wide(r"C:\t\rf-тест"), WESTERN), None);
        // Windows-1251 (Cyrillic) holds it.
        assert_eq!(encode(&wide(r"C:\t\rf-тест"), 1251), Some(b"C:\\t\\rf-\xF2\xE5\xF1\xF2".to_vec()));
        // No best-fit stand-in ("a" for "ā"): it would name another folder.
        assert_eq!(encode(&wide(r"C:\Users\Māori"), WESTERN), None);
        // Windows set to UTF-8 for all programs: the path stays UTF-8.
        assert_eq!(encode(&wide(r"C:\t\rf-тест"), 65001), Some(r"C:\t\rf-тест".as_bytes().to_vec()));
    }

    #[cfg(windows)]
    #[test]
    fn a_model_path_outside_the_code_page_goes_as_its_short_name() {
        use super::imp::narrow_path_in;
        let dir = std::env::temp_dir().join("rudariflow_тест_speakers");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("segmentation.onnx");
        std::fs::write(&file, b"model").unwrap();
        match narrow_path_in(&file, WESTERN) {
            // The 8.3 short name: ASCII, and the same file.
            Ok(short) => {
                let short = short.to_str().unwrap().to_string();
                assert!(short.is_ascii(), "{short}");
                assert_eq!(std::fs::read(&short).unwrap(), b"model", "{short}");
            }
            // A volume that keeps no short names.
            Err(e) => assert!(e.contains("cannot open"), "{e}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
        // A path the code page holds is passed as it is.
        let latin = narrow_path_in(Path::new(r"C:\t\rf-tëst\speakers\embedding.onnx"), WESTERN).unwrap();
        assert_eq!(latin.as_bytes(), b"C:\\t\\rf-t\xEBst\\speakers\\embedding.onnx");
        // No short name for a path that does not exist: a clear error.
        let missing = narrow_path_in(Path::new(r"C:\no-such-folder-тест\embedding.onnx"), WESTERN).unwrap_err();
        assert!(missing.contains("cannot open"), "{missing}");
    }
}
