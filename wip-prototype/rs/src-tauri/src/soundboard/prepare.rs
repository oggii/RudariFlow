//! Adding a sound: the file is copied into `sounds\<id>.<ext>`, decoded once
//! to 48 kHz stereo and written to `cache\<id>.wav` (16-bit PCM), the copy
//! playback reads. Whatever fails leaves no file behind.

use std::path::{Path, PathBuf};

use super::library::Sound;
use crate::media;

/// The formats that can be added.
pub const EXTENSIONS: [&str; 8] = ["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"];
/// Longest sound: 30 minutes.
pub const MAX_SECS: u64 = 30 * 60;
/// Prepared sounds are 48 kHz stereo.
pub const RATE: u32 = 48_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Prepared {
    /// The copied original, relative to the soundboard folder.
    pub file: String,
    pub duration_ms: u64,
}

/// The playback copy of sound `id`.
pub fn cache_path(dir: &Path, id: &str) -> PathBuf {
    dir.join("cache").join(format!("{}.wav", id))
}

/// Copy `src` into the soundboard folder `dir` as sound `id` and prepare
/// its playback copy. Errors: "unsupported", "too_long", "no_audio",
/// "unreadable: …", "disk: …".
pub fn prepare(dir: &Path, src: &Path, id: &str) -> Result<Prepared, String> {
    prepare_limited(dir, src, id, MAX_SECS)
}

fn prepare_limited(dir: &Path, src: &Path, id: &str, max_secs: u64) -> Result<Prepared, String> {
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    if !EXTENSIONS.contains(&ext.as_str()) {
        return Err("unsupported".to_string());
    }
    let file = format!("sounds/{}.{}", id, ext);
    let (original, cache) = (dir.join(&file), cache_path(dir, id));
    let result = std::fs::create_dir_all(dir.join("sounds"))
        .and_then(|_| std::fs::create_dir_all(dir.join("cache")))
        .and_then(|_| std::fs::copy(src, &original))
        .map_err(disk)
        .and_then(|_| write_cache(&original, &cache, max_secs));
    match result {
        Ok(frames) => Ok(Prepared { file, duration_ms: frames * 1000 / RATE as u64 }),
        Err(e) => {
            let _ = std::fs::remove_file(&original);
            let _ = std::fs::remove_file(&cache);
            Err(e)
        }
    }
}

/// Decode `original` and write the playback copy through a temp file.
/// Returns its length in frames.
fn write_cache(original: &Path, cache: &Path, max_secs: u64) -> Result<u64, String> {
    let samples = media::decode_48k_stereo(original, max_secs).map_err(|e| reason(&e, max_secs))?;
    let frames = (samples.len() / 2) as u64;
    if frames > max_secs * RATE as u64 {
        return Err("too_long".to_string());
    }
    let tmp = cache.with_extension("wav.tmp");
    let spec = hound::WavSpec { channels: 2, sample_rate: RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let written = (|| -> Result<(), hound::Error> {
        let mut writer = hound::WavWriter::create(&tmp, spec)?;
        // In blocks of a second: the writer's buffer is as large as a block.
        for chunk in samples.chunks(96_000) {
            let mut block = writer.get_i16_writer(chunk.len() as u32);
            for &s in chunk {
                block.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
            }
            block.flush()?;
        }
        writer.finalize()
    })();
    let saved = written.map_err(|e| e.to_string()).and_then(|_| std::fs::rename(&tmp, cache).map_err(|e| e.to_string()));
    if let Err(e) = saved {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("disk: {}", e));
    }
    Ok(frames)
}

/// The decoder's error as a reason the UI knows.
fn reason(error: &str, max_secs: u64) -> String {
    if error == media::NO_AUDIO {
        "no_audio".to_string()
    } else if error == media::too_long(max_secs) {
        "too_long".to_string()
    } else {
        format!("unreadable: {}", error)
    }
}

fn disk(e: std::io::Error) -> String {
    format!("disk: {}", e)
}

/// The copied original of `sound`: `sounds/<plain file name>` only. `file`
/// comes from a hand-editable JSON, so anything else (separators, `..`,
/// absolute paths) is None and never touched.
fn original_path(dir: &Path, sound: &Sound) -> Option<PathBuf> {
    let name = sound.file.strip_prefix("sounds/")?;
    let plain = !name.is_empty() && name != "." && name != ".." && Path::new(name).file_name() == Some(std::ffi::OsStr::new(name));
    plain.then(|| dir.join("sounds").join(name))
}

/// The playback copy of `sound`, made again from the original when only
/// the copy is gone. "missing" when both are.
pub fn ensure_cache(dir: &Path, sound: &Sound) -> Result<PathBuf, String> {
    let cache = cache_path(dir, &sound.id);
    if cache.exists() {
        return Ok(cache);
    }
    let original = match original_path(dir, sound) {
        Some(p) if p.exists() => p,
        _ => return Err("missing".to_string()),
    };
    std::fs::create_dir_all(dir.join("cache")).map_err(disk)?;
    write_cache(&original, &cache, MAX_SECS)?;
    Ok(cache)
}

/// Both files of `sound` were deleted by hand.
pub fn is_missing(dir: &Path, sound: &Sound) -> bool {
    !cache_path(dir, &sound.id).exists() && !original_path(dir, sound).is_some_and(|p| p.exists())
}

/// Delete both files of `sound`.
pub fn remove_files(dir: &Path, sound: &Sound) {
    if let Some(original) = original_path(dir, sound) {
        let _ = std::fs::remove_file(original);
    }
    let _ = std::fs::remove_file(cache_path(dir, &sound.id));
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/soundboard").join(name)
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rudariflow_sb_prepare_{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// Files left in `sounds\` and `cache\`.
    fn left_over(dir: &Path) -> usize {
        ["sounds", "cache"].iter().map(|d| std::fs::read_dir(dir.join(d)).map(|r| r.count()).unwrap_or(0)).sum()
    }

    fn sound_for(p: &Prepared, id: &str) -> Sound {
        Sound {
            id: id.into(),
            name: "tone".into(),
            file: p.file.clone(),
            category: String::new(),
            hotkey: String::new(),
            volume: 1.0,
            duration_ms: p.duration_ms,
            looping: false,
        }
    }

    #[test]
    fn an_added_file_is_copied_and_prepared_for_playback() {
        let dir = temp("add");
        let p = prepare(&dir, &fixture("tone.mp3"), "s-test").unwrap();
        assert_eq!(p.file, "sounds/s-test.mp3");
        assert_eq!(std::fs::read(dir.join(&p.file)).unwrap(), std::fs::read(fixture("tone.mp3")).unwrap());
        assert!((950..=1100).contains(&p.duration_ms), "{} ms", p.duration_ms);
        let wav = hound::WavReader::open(cache_path(&dir, "s-test")).unwrap();
        let spec = wav.spec();
        assert_eq!((spec.channels, spec.sample_rate, spec.bits_per_sample), (2, 48_000, 16));
        assert!((wav.duration() as u64).abs_diff(p.duration_ms * 48) < 48);
        assert!(!dir.join("cache").join("s-test.wav.tmp").exists());
        // The same file again is a second sound.
        assert!(prepare(&dir, &fixture("tone.mp3"), "s-again").is_ok());
    }

    #[test]
    fn unsupported_long_silent_and_broken_files_leave_nothing_behind() {
        let dir = temp("refused");
        std::fs::create_dir_all(&dir).unwrap();
        let text = dir.join("notes.txt");
        std::fs::write(&text, "hello").unwrap();
        assert_eq!(prepare(&dir, &text, "s-1").unwrap_err(), "unsupported");
        assert_eq!(prepare_limited(&dir, &fixture("tone.wav"), "s-2", 0).unwrap_err(), "too_long");
        assert_eq!(prepare(&dir, &fixture("video-only.m4a"), "s-3").unwrap_err(), "no_audio");
        let broken = dir.join("broken.mp3");
        std::fs::write(&broken, vec![7u8; 4096]).unwrap();
        let e = prepare(&dir, &broken, "s-4").unwrap_err();
        // Media Foundation refuses the bytes, or finds no audio in them.
        assert!(e.starts_with("unreadable: ") || e == "no_audio", "{}", e);
        assert_eq!(left_over(&dir), 0);
    }

    #[test]
    fn a_missing_cache_is_rebuilt_and_a_missing_original_is_reported() {
        let dir = temp("cache");
        let p = prepare(&dir, &fixture("tone.wav"), "s-1").unwrap();
        let sound = sound_for(&p, "s-1");
        std::fs::remove_file(cache_path(&dir, "s-1")).unwrap();
        assert!(!is_missing(&dir, &sound), "the original is still there");
        assert_eq!(ensure_cache(&dir, &sound).unwrap(), cache_path(&dir, "s-1"));
        assert!(cache_path(&dir, "s-1").exists());
        remove_files(&dir, &sound);
        assert!(is_missing(&dir, &sound));
        assert_eq!(ensure_cache(&dir, &sound).unwrap_err(), "missing");
        assert_eq!(left_over(&dir), 0);
    }

    #[test]
    fn a_file_name_that_leaves_the_sounds_folder_is_missing_and_never_deleted() {
        let dir = temp("escape");
        std::fs::create_dir_all(dir.join("sounds")).unwrap();
        let outside = dir.join("outside.txt");
        std::fs::write(&outside, "keep").unwrap();
        for file in ["..\\outside.txt", "sounds/../outside.txt", "sounds/..\\outside.txt", "../outside.txt"] {
            let sound = Sound {
                id: "s-x".into(),
                name: "x".into(),
                file: file.into(),
                category: String::new(),
                hotkey: String::new(),
                volume: 1.0,
                duration_ms: 0,
                looping: false,
            };
            assert!(is_missing(&dir, &sound), "{}", file);
            assert_eq!(ensure_cache(&dir, &sound).unwrap_err(), "missing");
            remove_files(&dir, &sound);
            assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep", "{}", file);
        }
    }
}
