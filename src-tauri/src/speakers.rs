//! Speaker separation for the Files tab: who speaks when, with sherpa-onnx
//! (pyannote segmentation 3.0 and the 3D-Speaker ERes2Net voice embedding).

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
    // Earlier voice first, so `max_by_key` keeps it on a tie when reversed.
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
                        } else if t.start_ms >= end {
                            t.start_ms - end
                        } else {
                            0
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

#[cfg(windows)]
mod imp {
    pub fn load(dll: &str) -> bool {
        use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;
        let wide: Vec<u16> = dll.encode_utf16().chain(std::iter::once(0)).collect();
        // The module stays loaded; the delay-load helper then finds it.
        !unsafe { LoadLibraryW(wide.as_ptr()) }.is_null()
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn load(_dll: &str) -> bool {
        false
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
}
