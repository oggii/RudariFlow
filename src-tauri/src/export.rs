//! Exports of the Files tab: text, subtitles (SRT, VTT), Word, and the HTML
//! the PDF is printed from. They take what the tab shows: the times switch,
//! the speaker names, the summary if there is one.

use crate::file_transcribe::{clock, format, paragraphs, speaker_name};
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
                Some(next) if next > cue.start_ms => (cue.start_ms + MIN_CUE_MS).min(next),
                _ => cue.start_ms + MIN_CUE_MS,
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
    after(&['.', '!', '?', '。', '！', '？'])
        .or_else(|| after(&[',', ';', ':', '，', '、', '；', '：']))
        .or_else(|| {
            window
                .char_indices()
                .filter(|&(i, c)| c == ' ' && i >= min)
                .map(|(i, _)| i + 1)
                .last()
        })
}

/// A cue's text in at most two lines, broken at the space nearest the middle.
fn two_lines(text: &str) -> String {
    let char_count = text.chars().count();
    if char_count <= LINE_CHARS {
        return text.to_string();
    }
    let char_middle = char_count / 2;
    // Find the space nearest the character middle
    if let Some((char_pos, _)) = text
        .char_indices()
        .enumerate()
        .filter(|&(_, (_, c))| c == ' ')
        .min_by_key(|&(char_idx, _)| char_idx.abs_diff(char_middle))
    {
        let space_byte_idx = text.char_indices().nth(char_pos).map(|(i, _)| i).unwrap_or(0);
        return format!("{}\n{}", &text[..space_byte_idx], &text[space_byte_idx + 1..]);
    }
    // No space found: break at the character middle
    if let Some((byte_idx, _)) = text.char_indices().nth(char_middle) {
        format!("{}\n{}", &text[..byte_idx], &text[byte_idx..])
    } else {
        text.to_string()
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

/// Paper for PDF and Word: Letter in the US and Canada (Windows region), A4
/// elsewhere.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Paper {
    A4,
    Letter,
}

impl Paper {
    pub fn for_region() -> Paper {
        // GEOIDs: 244 United States, 39 Canada.
        match region::geo_id() {
            Some(244) | Some(39) => Paper::Letter,
            _ => Paper::A4,
        }
    }

    /// Width and height in twentieths of a point (Word).
    pub fn twips(self) -> (u32, u32) {
        match self {
            Paper::A4 => (11906, 16838),
            Paper::Letter => (12240, 15840),
        }
    }

    /// Width and height in inches (WebView2 print settings).
    pub fn inches(self) -> (f64, f64) {
        match self {
            Paper::A4 => (8.27, 11.69),
            Paper::Letter => (8.5, 11.0),
        }
    }

    /// The CSS `@page` size.
    pub fn css(self) -> &'static str {
        match self {
            Paper::A4 => "A4",
            Paper::Letter => "letter",
        }
    }
}

#[cfg(windows)]
mod region {
    pub fn geo_id() -> Option<i32> {
        use windows_sys::Win32::Globalization::{GetUserGeoID, GEOCLASS_NATION};
        let id = unsafe { GetUserGeoID(GEOCLASS_NATION) };
        (id > 0).then_some(id)
    }
}

#[cfg(not(windows))]
mod region {
    pub fn geo_id() -> Option<i32> {
        None
    }
}

/// 20 mm in twips.
const MARGIN_TWIPS: i32 = 1134;

/// The transcript as a Word document: title, the line under it, the summary,
/// the transcript paragraphs (time grey, name bold).
pub fn docx(doc: &ExportDoc, paper: Paper) -> Result<Vec<u8>, String> {
    use docx_rs::{Docx, PageMargin, Paragraph as P, Run, Style, StyleType};

    let (width, height) = paper.twips();
    let mut d = Docx::new()
        .page_size(width, height)
        .page_margin(PageMargin::new().top(MARGIN_TWIPS).bottom(MARGIN_TWIPS).left(MARGIN_TWIPS).right(MARGIN_TWIPS))
        .add_style(Style::new("Title", StyleType::Paragraph).name("Title").size(36).bold())
        .add_style(Style::new("Heading1", StyleType::Paragraph).name("Heading 1").size(28).bold())
        .add_paragraph(P::new().style("Title").add_run(Run::new().add_text(&doc.title)))
        .add_paragraph(P::new().add_run(Run::new().add_text(&doc.meta).color("666666")));
    if let Some(summary) = doc.summary.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        d = d.add_paragraph(P::new().style("Heading1").add_run(Run::new().add_text(&doc.summary_title)));
        for line in summary.lines().filter(|l| !l.trim().is_empty()) {
            d = d.add_paragraph(P::new().add_run(Run::new().add_text(line)));
        }
    }
    d = d.add_paragraph(P::new().style("Heading1").add_run(Run::new().add_text(&doc.transcript_title)));
    for p in paragraphs(&doc.segments) {
        let mut para = P::new();
        if doc.times {
            para = para.add_run(Run::new().add_text(format!("[{}] ", clock(p.start_ms))).color("808080"));
        }
        if let Some(s) = p.speaker {
            para = para.add_run(Run::new().add_text(format!("{}: ", speaker_name(&doc.names, s))).bold());
        }
        d = d.add_paragraph(para.add_run(Run::new().add_text(&p.text)));
    }
    let mut out = std::io::Cursor::new(Vec::new());
    d.build().pack(&mut out).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The page the PDF is printed from: system fonts (every script Windows can
/// show), 20 mm margins, page numbers "n / total" in the footer.
pub fn pdf_html(doc: &ExportDoc, paper: Paper) -> String {
    let mut body = format!(
        "<h1>{}</h1>\n<div class=\"meta\">{}</div>\n",
        html_escape(&doc.title),
        html_escape(&doc.meta)
    );
    if let Some(summary) = doc.summary.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        body.push_str(&format!("<h2>{}</h2>\n<div class=\"summary\">\n", html_escape(&doc.summary_title)));
        for line in summary.lines().filter(|l| !l.trim().is_empty()) {
            body.push_str(&format!("<p>{}</p>\n", html_escape(line)));
        }
        body.push_str("</div>\n");
    }
    body.push_str(&format!("<h2>{}</h2>\n", html_escape(&doc.transcript_title)));
    for p in paragraphs(&doc.segments) {
        body.push_str("<p>");
        if doc.times {
            body.push_str(&format!("<span class=\"time\">[{}]</span> ", clock(p.start_ms)));
        }
        if let Some(s) = p.speaker {
            body.push_str(&format!("<span class=\"who\">{}:</span> ", html_escape(&speaker_name(&doc.names, s))));
        }
        body.push_str(&html_escape(&p.text));
        body.push_str("</p>\n");
    }
    format!(
        r#"<!doctype html>
<html><head><meta charset="utf-8"><title>{title}</title>
<style>
@page {{ size: {size}; margin: 20mm; @bottom-center {{ content: counter(page) " / " counter(pages); font: 9pt "Segoe UI", sans-serif; color: #888; }} }}
body {{ font: 11pt/1.5 "Segoe UI", "Segoe UI Emoji", "Microsoft YaHei", "Yu Gothic", "Malgun Gothic", "Nirmala UI", "Leelawadee UI", sans-serif; color: #111; margin: 0; }}
h1 {{ font-size: 18pt; margin: 0 0 4pt; }}
.meta {{ color: #666; font-size: 9.5pt; margin-bottom: 14pt; }}
h2 {{ font-size: 13pt; margin: 16pt 0 6pt; }}
p {{ margin: 0 0 8pt; orphans: 2; widows: 2; }}
.summary p {{ margin-bottom: 4pt; }}
.time {{ color: #888; font-variant-numeric: tabular-nums; }}
.who {{ font-weight: 600; }}
</style></head>
<body>
{body}</body></html>
"#,
        title = html_escape(&doc.title),
        size = paper.css(),
        body = body
    )
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

    /// `word/document.xml` out of the .docx `docx()` builds for `doc` and `paper`.
    fn document_xml(doc: &ExportDoc, paper: Paper) -> String {
        use std::io::Read;
        let bytes = docx(doc, paper).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut xml = String::new();
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut xml).unwrap();
        xml
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

    #[test]
    fn space_less_cjk_text_breaks_at_character_middle() {
        // A Chinese sentence with no spaces, about 60 characters
        let cjk = "这是一个很长的中文句子没有任何空格但是包含很多字符用来测试两行函数是否能够正确地在字符中间进行分割而不会超过四十二个字符的限制";
        let result = two_lines(cjk);
        for line in result.split('\n') {
            assert!(line.chars().count() <= 42, "Line exceeds 42 chars: {} ({})", line, line.chars().count());
        }
        let lines: Vec<_> = result.split('\n').collect();
        assert!(lines.len() <= 2, "More than 2 lines: {:?}", lines);
    }

    #[test]
    fn first_third_rule_for_space_cut() {
        // Test that space fallback respects the first-third rule
        let text = format!("Hi {}", "x".repeat(200));
        let parts = split_text(&text, CUE_CHARS);
        assert!(parts[0].len() > 2, "First part should not be just 'Hi': {:?}", parts[0]);
        for part in &parts {
            assert!(part.chars().count() <= CUE_CHARS, "Part exceeds CUE_CHARS: {} ({})", part, part.chars().count());
        }
    }

    #[test]
    fn cjk_sentence_end_is_a_cut_point() {
        // Text long enough to split: first 30+ chars to exceed first-third, then 。, then much more
        let text = "开始这是一个很长的中文句子用来测试系统的分割功能是否正确。这是第二个句子继续测试分割功能是否能够在中文句号处正确截断文本这样能够验证我们的分割算法是否有效并且能够在中文句号处进行正确的截断并且返回两个部分来完成测试";
        let parts = split_text(text, CUE_CHARS);
        assert!(parts.len() >= 2, "Should split into at least 2 parts, text len={}, got: {:?}", text.chars().count(), parts);
        assert!(parts[0].ends_with("。"), "First part should end with 。, got: {:?}", parts[0]);
    }

    #[test]
    fn zero_length_segment_produces_positive_duration_cues() {
        let english_sentence = "This is a fairly long English sentence with multiple words and spaces that exceeds eighty-four characters to ensure it gets split into multiple cues.";
        let cues_result = cues(&[said(5.0, 5.0, None, english_sentence)]);
        assert!(cues_result.len() >= 2, "Should produce at least 2 cues: {:?}", cues_result);
        for cue in &cues_result {
            assert!(cue.end_ms > cue.start_ms, "Cue has zero or negative duration: {:?}", cue);
            assert!(cue.end_ms >= cue.start_ms + 1000, "Cue duration is less than MIN_CUE_MS: {:?}", cue);
        }
    }

    #[test]
    fn word_has_the_title_summary_names_and_times() {
        let xml = document_xml(&doc(Some("- One point")), Paper::A4);
        for expected in ["meeting.mp3", "Summary", "- One point", "Transcript", "[0:00] ", "Saad: ", "Welcome to the meeting.", "Speaker 2: "] {
            assert!(xml.contains(expected), "{expected} missing");
        }
        assert!(xml.contains(r#"w:w="11906" w:h="16838""#), "A4 width and height in twips");
        assert!(xml.contains(r#"w:pStyle w:val="Title""#), "title style missing");
        assert!(xml.contains(r#"w:pStyle w:val="Heading1""#), "Heading1 style missing");
    }

    #[test]
    fn word_page_size_follows_the_paper() {
        let letter = document_xml(&doc(None), Paper::Letter);
        assert!(letter.contains(r#"w:w="12240" w:h="15840""#), "Letter size missing: {letter}");
        let a4 = document_xml(&doc(None), Paper::A4);
        assert!(a4.contains(r#"w:w="11906" w:h="16838""#), "A4 size missing: {a4}");
    }

    #[test]
    fn paper_sizes() {
        assert_eq!(Paper::A4.twips(), (11906, 16838));
        assert_eq!(Paper::Letter.twips(), (12240, 15840));
        assert_eq!(Paper::Letter.css(), "letter");
    }

    #[test]
    fn pdf_html_has_paper_header_names_and_escapes() {
        let mut d = doc(Some("- One <point>"));
        d.title = "Q&A.mp3".into();
        let html = pdf_html(&d, Paper::Letter);
        assert!(html.contains("size: letter"));
        assert!(html.contains("<h1>Q&amp;A.mp3</h1>"));
        assert!(html.contains("- One &lt;point&gt;"));
        assert!(html.contains("<span class=\"time\">[0:14]</span>"));
        assert!(html.contains("<span class=\"who\">Speaker 2:</span>"));
        d.times = false;
        assert!(!pdf_html(&d, Paper::A4).contains("class=\"time\""));
    }
}
