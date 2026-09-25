//! Exports of the Files tab: text, subtitles (SRT, VTT), Word, and the HTML
//! the PDF is printed from. They take what the tab shows: the times switch,
//! the speaker names, the summary if there is one.

use crate::file_transcribe::{format, speaker_name};
use crate::whisper_engine::Segment;

/// What an export contains, sent by the Files tab. `meta` is the line under
/// the title ("2:52 · English · 2 speakers · 24.09.2026") and the headings
/// are in the UI language.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ExportDoc {
    pub title: String,
    pub meta: String,
    pub segments: Vec<Segment>,
    pub names: Vec<String>,
    pub times: bool,
    pub summary: Option<String>,
    #[serde(rename = "summaryTitle")]
    pub summary_title: String,
    #[serde(rename = "transcriptTitle")]
    pub transcript_title: String,
}

/// The transcript as the text box shows it, the summary above it.
pub fn text(doc: &ExportDoc) -> String {
    let transcript = format(&doc.segments, &doc.names, doc.times);
    match doc.summary.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(summary) => format!("{}\n\n{}\n\n{}\n\n{}", doc.summary_title, summary, doc.transcript_title, transcript),
        None => transcript,
    }
}

/// A subtitle: its time, one or two lines of text, the speaker.
#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub speaker: Option<u8>,
}

const LINE_CHARS: usize = 42;
const CUE_CHARS: usize = 2 * LINE_CHARS;
const MIN_CUE_MS: u64 = 1_000;

/// The segments as cues of at most two lines: a longer segment is split at
/// a sentence end, else a comma, else a space, and its time is shared out by
/// characters. A cue lasts at least a second unless the next one starts.
pub fn cues(segments: &[Segment]) -> Vec<Cue> {
    let mut out: Vec<Cue> = Vec::new();
    for segment in segments {
        let parts = split_text(segment.text.trim(), CUE_CHARS);
        let total: usize = parts.iter().map(|p| p.chars().count()).sum::<usize>().max(1);
        let span = segment.end_ms.saturating_sub(segment.start_ms);
        let mut start = segment.start_ms;
        let mut chars_before = 0;
        for (i, part) in parts.iter().enumerate() {
            chars_before += part.chars().count();
            let end = if i + 1 == parts.len() {
                segment.end_ms
            } else {
                segment.start_ms + span * chars_before as u64 / total as u64
            };
            out.push(Cue { start_ms: start, end_ms: end, text: part.clone(), speaker: segment.speaker });
            start = end;
        }
    }
    for i in 0..out.len() {
        let next_start = out.get(i + 1).map(|c| c.start_ms);
        let cue = &mut out[i];
        if cue.end_ms < cue.start_ms + MIN_CUE_MS {
            cue.end_ms = match next_start {
                Some(next) => (cue.start_ms + MIN_CUE_MS).min(next.max(cue.end_ms)),
                None => cue.start_ms + MIN_CUE_MS,
            };
        }
    }
    out
}

/// `text` in parts of at most `max` characters.
fn split_text(text: &str, max: usize) -> Vec<String> {
    let mut parts = Vec::new();
    let mut rest = text;
    while rest.chars().count() > max {
        let window_end = rest.char_indices().nth(max).map_or(rest.len(), |(i, _)| i);
        let window = &rest[..window_end];
        let cut = best_cut(window).unwrap_or(window_end);
        let (head, tail) = rest.split_at(cut);
        if !head.trim().is_empty() {
            parts.push(head.trim().to_string());
        }
        rest = tail.trim_start();
    }
    if !rest.is_empty() {
        parts.push(rest.to_string());
    }
    parts
}

/// Where to cut `window` (a byte index): after the last sentence end, else
/// after the last comma, else at the last space; ends in the first third
/// of the window do not count, so no part is a word or two.
fn best_cut(window: &str) -> Option<usize> {
    let min = window.len() / 3;
    let after = |marks: &[char]| {
        window
            .char_indices()
            .filter(|&(i, c)| marks.contains(&c) && i >= min)
            .map(|(i, c)| i + c.len_utf8())
            .last()
    };
    after(&['.', '!', '?']).or_else(|| after(&[',', ';', ':'])).or_else(|| window.rfind(' ').filter(|&i| i > 0))
}

/// A cue's text in at most two lines, broken at the space nearest the middle.
fn two_lines(text: &str) -> String {
    if text.chars().count() <= LINE_CHARS {
        return text.to_string();
    }
    let middle = text.len() / 2;
    match text.char_indices().filter(|&(_, c)| c == ' ').min_by_key(|&(i, _)| i.abs_diff(middle)) {
        Some((i, _)) => format!("{}\n{}", &text[..i], &text[i + 1..]),
        None => text.to_string(),
    }
}

fn hms(ms: u64) -> (u64, u64, u64, u64) {
    (ms / 3_600_000, ms / 60_000 % 60, ms / 1_000 % 60, ms % 1_000)
}

fn srt_time(ms: u64) -> String {
    let (h, m, s, f) = hms(ms);
    format!("{h:02}:{m:02}:{s:02},{f:03}")
}

fn vtt_time(ms: u64) -> String {
    let (h, m, s, f) = hms(ms);
    format!("{h:02}:{m:02}:{s:02}.{f:03}")
}

/// SubRip: numbered cues, the speaker as "Name: " before the text.
pub fn srt(segments: &[Segment], names: &[String]) -> String {
    cues(segments)
        .iter()
        .enumerate()
        .map(|(i, cue)| {
            let who = cue.speaker.map_or(String::new(), |s| format!("{}: ", speaker_name(names, s)));
            format!("{}\n{} --> {}\n{}\n", i + 1, srt_time(cue.start_ms), srt_time(cue.end_ms), two_lines(&format!("{who}{}", cue.text)))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn vtt_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// WebVTT: the speaker as a voice tag (`<v Name>`).
pub fn vtt(segments: &[Segment], names: &[String]) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for cue in cues(segments) {
        let who = cue.speaker.map_or(String::new(), |s| {
            let name: String = speaker_name(names, s).chars().filter(|c| !matches!(c, '<' | '>' | '&')).collect();
            format!("<v {name}>")
        });
        out.push_str(&format!(
            "{} --> {}\n{}{}\n\n",
            vtt_time(cue.start_ms),
            vtt_time(cue.end_ms),
            who,
            two_lines(&vtt_escape(&cue.text))
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn said(start_s: f32, end_s: f32, speaker: Option<u8>, text: &str) -> Segment {
        Segment { start_ms: (start_s * 1000.0) as u64, end_ms: (end_s * 1000.0) as u64, text: text.to_string(), speaker }
    }

    fn doc(summary: Option<&str>) -> ExportDoc {
        ExportDoc {
            title: "meeting.mp3".into(),
            meta: "2:52 · English · 2 speakers".into(),
            segments: vec![said(0.0, 3.0, Some(0), "Welcome to the meeting."), said(14.0, 18.0, Some(1), "Version ten is out.")],
            names: vec!["Saad".into()],
            times: true,
            summary: summary.map(str::to_string),
            summary_title: "Summary".into(),
            transcript_title: "Transcript".into(),
        }
    }

    #[test]
    fn text_is_the_shown_transcript_with_the_summary_on_top() {
        assert_eq!(text(&doc(None)), "[0:00] Saad: Welcome to the meeting.\n\n[0:14] Speaker 2: Version ten is out.");
        assert!(text(&doc(Some("- One point"))).starts_with("Summary\n\n- One point\n\nTranscript\n\n[0:00] Saad:"));
    }

    #[test]
    fn subtitle_times_are_formatted_for_srt_and_vtt() {
        assert_eq!(srt_time(3_723_456), "01:02:03,456");
        assert_eq!(vtt_time(3_723_456), "01:02:03.456");
        assert_eq!(srt_time(0), "00:00:00,000");
    }

    #[test]
    fn long_segments_are_split_into_two_line_cues_with_shared_time() {
        let long = "This is the first sentence of a long answer. And this is the second one, which goes on for quite a while longer than the first.";
        let cues = cues(&[said(10.0, 20.0, None, long)]);
        assert!(cues.len() >= 2, "{cues:?}");
        assert!(cues.iter().all(|c| c.text.chars().count() <= CUE_CHARS + 1), "{cues:?}");
        assert!(cues[0].text.ends_with("answer."), "split at the sentence end: {cues:?}");
        assert_eq!(cues[0].start_ms, 10_000);
        assert_eq!(cues.last().unwrap().end_ms, 20_000);
        for pair in cues.windows(2) {
            assert!(pair[0].end_ms <= pair[1].start_ms, "{cues:?}");
        }
    }

    #[test]
    fn short_cues_last_a_second_unless_the_next_one_starts() {
        let cues = cues(&[said(0.0, 0.3, None, "Hi."), said(0.5, 2.0, None, "Hello there."), said(5.0, 5.2, None, "Bye.")]);
        assert_eq!((cues[0].start_ms, cues[0].end_ms), (0, 500));
        assert_eq!((cues[2].start_ms, cues[2].end_ms), (5_000, 6_000));
    }

    #[test]
    fn srt_and_vtt_carry_the_speaker() {
        let d = doc(None);
        let s = srt(&d.segments, &d.names);
        assert!(s.starts_with("1\n00:00:00,000 --> 00:00:03,000\nSaad: Welcome to the meeting.\n\n2\n"), "{s}");
        let v = vtt(&d.segments, &d.names);
        assert!(v.starts_with("WEBVTT\n\n00:00:00.000 --> 00:00:03.000\n<v Saad>Welcome to the meeting.\n\n"), "{v}");
        assert!(v.contains("<v Speaker 2>Version ten is out."), "{v}");
        let tricky = vtt(&[said(0.0, 2.0, Some(0), "a < b & c")], &["A<B>".into()]);
        assert!(tricky.contains("<v AB>a &lt; b &amp; c"), "{tricky}");
    }
}
