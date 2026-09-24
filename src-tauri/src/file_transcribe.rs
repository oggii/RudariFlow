//! File transcription: an audio or video file to text. Whisper runs block
//! by block (about a minute each, cut in pauses), so a dictation can go in
//! between and the text shows up while it runs. The AI can summarise the
//! result.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::audio::{quiet_cut, speech_spans};
use crate::whisper_engine::{Segment, WhisperEngine};

/// A block ends once this much audio is in it...
const BLOCK_SECS: f32 = 60.0;
/// ...in the quietest spot from here on.
const BLOCK_CUT_FROM_SECS: f32 = 45.0;
/// Silence this long inside a block is left out. Whisper dates text after a
/// long silence to the start of its 30 s window (speech at 1:15 came out as
/// 0:30) and invents text in silence ("Thank you.").
const SKIP_PAUSE_SECS: f32 = 2.0;
/// The end of the text so far goes into the next stretch's prompt.
const CONTEXT_CHARS: usize = 200;
/// A pause this long starts a new paragraph.
const PARAGRAPH_PAUSE_MS: u64 = 2_000;
/// Longer paragraphs end at the next sentence end.
const PARAGRAPH_CHARS: usize = 600;
/// Transcript text per AI request: Gemma's context holds 8192 tokens, with
/// room left for the instructions and the answer.
pub const SUMMARY_CHUNK_CHARS: usize = 12_000;

pub const CANCELLED: &str = "cancelled";

/// Where the blocks of `audio` (16 kHz mono) end.
pub fn block_ends(audio: &[f32]) -> Vec<usize> {
    let block = (BLOCK_SECS * 16_000.0) as usize;
    let mut ends = Vec::new();
    let mut from = 0;
    while audio.len() - from > block {
        from += quiet_cut(&audio[from..], BLOCK_CUT_FROM_SECS, BLOCK_SECS).max(1);
        ends.push(from);
    }
    if ends.last() != Some(&audio.len()) {
        ends.push(audio.len());
    }
    ends
}

/// How far a file is, with the segments of the block just done.
pub struct Progress<'a> {
    pub done_ms: u64,
    pub total_ms: u64,
    pub segments: &'a [Segment],
}

/// Transcribe `audio` (16 kHz mono) with the loaded model. `dictionary` (the
/// dictionary's Whisper prompt) goes into every block, `spelling` fixes
/// every segment. Returns the segments and the language used;
/// `Err(CANCELLED)` once `cancel` is set.
pub fn transcribe(
    engine: &WhisperEngine,
    audio: &[f32],
    language: &str,
    dictionary: &str,
    spelling: impl Fn(&str) -> String,
    cancel: &AtomicBool,
    mut progress: impl FnMut(Progress),
) -> Result<(Vec<Segment>, String), String> {
    let mut run = engine.start_file(language)?;
    let total_ms = audio.len() as u64 / 16;
    let mut segments: Vec<Segment> = Vec::new();
    let mut start = 0;
    for end in block_ends(audio) {
        if cancel.load(Ordering::SeqCst) {
            return Err(CANCELLED.to_string());
        }
        let block = &audio[start..end];
        let mut new = Vec::new();
        for (from, to) in speech_spans(block, 16_000, SKIP_PAUSE_SECS) {
            let prompt = block_prompt(dictionary, segments.iter().chain(&new));
            let mut found = engine.file_block(&mut run, &block[from..to], (start + from) as u64 / 16, &prompt)?;
            for segment in &mut found {
                segment.text = spelling(&segment.text);
            }
            new.extend(found);
        }
        progress(Progress { done_ms: end as u64 / 16, total_ms, segments: &new });
        segments.extend(new);
        start = end;
    }
    Ok((segments, run.language))
}

/// Whisper's prompt for the next stretch: the dictionary, then the end of
/// the text so far (cut at a word), so names keep their spelling and
/// sentences run on across the cuts.
fn block_prompt<'a>(dictionary: &str, before: impl DoubleEndedIterator<Item = &'a Segment>) -> String {
    let mut tail: Vec<&str> = Vec::new();
    let mut chars = 0;
    'segments: for segment in before.rev() {
        for word in segment.text.split_whitespace().rev() {
            chars += word.chars().count() + 1;
            if chars > CONTEXT_CHARS {
                break 'segments;
            }
            tail.push(word);
        }
    }
    tail.reverse();
    let tail = tail.join(" ");
    // Whisper writes like its prompt: after the bare word list the three
    // test files came out without a single full stop, with it 12 each.
    let mut dictionary = dictionary.trim().to_string();
    if !dictionary.is_empty() && !dictionary.ends_with(['.', '!', '?']) {
        dictionary.push('.');
    }
    match (dictionary.as_str(), tail.as_str()) {
        ("", tail) => tail.to_string(),
        (dictionary, "") => dictionary.to_string(),
        (dictionary, tail) => format!("{} {}", dictionary, tail),
    }
}

/// Whisper segment text with single spaces. The capitals are Whisper's: a
/// segment can start mid-sentence ("go to the park tomorrow").
pub fn tidy_segment(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `text` with its first letter in upper case (a paragraph's start).
fn capitalize_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Parts of this many characters stay within Gemma's 8192 tokens: about 3.5
/// characters make a token in Latin script, 1 to 1.5 in Chinese, Japanese
/// and Korean.
pub fn summary_chunk_chars(text: &str) -> usize {
    let total = text.chars().filter(|c| !c.is_whitespace()).count().max(1);
    let wide = text.chars().filter(|&c| is_wide_script(c)).count();
    if wide * 5 > total { SUMMARY_CHUNK_CHARS / 3 } else { SUMMARY_CHUNK_CHARS }
}

/// Han, kana, Hangul and CJK punctuation.
fn is_wide_script(c: char) -> bool {
    matches!(c as u32, 0x3000..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF)
}

/// "4:05" or "1:02:03".
pub fn clock(ms: u64) -> String {
    let s = ms / 1000;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

/// The transcript as text: a new paragraph after a pause, or at a sentence
/// end once a paragraph is long; with `times`, each paragraph starts with
/// its time ("[4:05] ...").
pub fn format(segments: &[Segment], times: bool) -> String {
    let mut paragraphs: Vec<(u64, String)> = Vec::new();
    let mut last_end = 0;
    for segment in segments {
        let text = segment.text.trim();
        if text.is_empty() {
            continue;
        }
        let new_paragraph = match paragraphs.last() {
            None => true,
            Some((_, p)) => {
                segment.start_ms.saturating_sub(last_end) >= PARAGRAPH_PAUSE_MS
                    || (p.chars().count() >= PARAGRAPH_CHARS && p.ends_with(['.', '!', '?']))
            }
        };
        match paragraphs.last_mut() {
            Some((_, p)) if !new_paragraph => {
                p.push(' ');
                p.push_str(text);
            }
            _ => paragraphs.push((segment.start_ms, capitalize_first(text))),
        }
        last_end = segment.end_ms;
    }
    paragraphs
        .into_iter()
        .map(|(start, text)| if times { format!("[{}] {}", clock(start), text) } else { text })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// `text` in parts of at most `max` characters, split between paragraphs,
/// else after a sentence, else between words.
pub fn chunks(text: &str, max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    let push = |piece: &str, sep: &str, current: &mut String, out: &mut Vec<String>| {
        if !current.is_empty() && current.chars().count() + sep.len() + piece.chars().count() > max {
            out.push(std::mem::take(current));
        }
        if !current.is_empty() {
            current.push_str(sep);
        }
        current.push_str(piece);
    };
    for paragraph in text.split("\n\n").map(str::trim).filter(|p| !p.is_empty()) {
        if paragraph.chars().count() <= max {
            push(paragraph, "\n\n", &mut current, &mut out);
            continue;
        }
        // One paragraph too long for a part: by sentences, then words.
        for sentence in paragraph.split_inclusive(['.', '!', '?']).map(str::trim).filter(|s| !s.is_empty()) {
            if sentence.chars().count() <= max {
                push(sentence, " ", &mut current, &mut out);
            } else {
                for word in sentence.split_whitespace() {
                    push(word, " ", &mut current, &mut out);
                }
            }
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn written_in(language: Option<&str>) -> String {
    match language {
        Some(language) => format!("Write in {}, the language of the transcript.", language),
        None => "Write in the language of the transcript.".to_string(),
    }
}

/// Instructions for the summary of a transcript (or of notes on its parts).
pub fn summary_prompt(language: Option<&str>) -> String {
    format!(
        "You summarise transcripts of recordings: meetings, calls, voice messages, talks. {} \
         Start with two or three sentences on what it is about. Then the key points as a list, \
         one line each, starting with \"- \". If decisions, tasks or dates came up, end with a \
         short list of next steps: who does what by when, as far as the transcript says. Use \
         only what the transcript says, never invent anything. No title, no introduction, no \
         closing remarks, no Markdown other than the lists.",
        written_in(language)
    )
}

/// Instructions for notes on one part of a long transcript.
pub fn notes_prompt(language: Option<&str>) -> String {
    format!(
        "This is one part of a long transcript. Write compact notes on it: key points, \
         decisions, tasks, names, numbers and dates, as a list, one line each, starting with \
         \"- \". {} Use only what the part says. No introduction.",
        written_in(language)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start_s: f32, end_s: f32, text: &str) -> Segment {
        Segment { start_ms: (start_s * 1000.0) as u64, end_ms: (end_s * 1000.0) as u64, text: text.to_string() }
    }

    #[test]
    fn blocks_end_in_pauses_about_every_minute() {
        let sr = 16_000;
        // 150 s of sound with pauses at 50 s and 105 s.
        let mut audio = vec![0.3_f32; 150 * sr];
        for pause in [50, 105] {
            for s in &mut audio[pause * sr..pause * sr + sr / 2] {
                *s = 0.0;
            }
        }
        let ends = block_ends(&audio);
        assert_eq!(ends.len(), 3, "{:?}", ends);
        assert!(ends[0] > 50 * sr && ends[0] < 50 * sr + sr / 2, "{:?}", ends);
        assert!(ends[1] > 105 * sr && ends[1] < 105 * sr + sr / 2, "{:?}", ends);
        assert_eq!(ends[2], audio.len());
        // Short files are one block.
        assert_eq!(block_ends(&audio[..10 * sr]), vec![10 * sr]);
        assert_eq!(block_ends(&[]), vec![0]);
    }

    #[test]
    fn paragraphs_follow_pauses_and_times_are_optional() {
        let segments = vec![
            seg(0.0, 3.0, "Hello everyone."),
            seg(3.2, 6.0, "Let's start."),
            seg(9.0, 12.0, "First point: the budget."),
            seg(3700.0, 3702.0, "Thanks, bye."),
        ];
        assert_eq!(
            format(&segments, false),
            "Hello everyone. Let's start.\n\nFirst point: the budget.\n\nThanks, bye."
        );
        assert_eq!(
            format(&segments, true),
            "[0:00] Hello everyone. Let's start.\n\n[0:09] First point: the budget.\n\n[1:01:40] Thanks, bye."
        );
        assert_eq!(format(&[], true), "");
    }

    #[test]
    fn long_paragraphs_end_at_a_sentence() {
        let sentence = "This sentence is here to make the paragraph long enough. ";
        let segments: Vec<Segment> =
            (0..30).map(|i| seg(i as f32 * 2.0, i as f32 * 2.0 + 1.9, sentence.trim())).collect();
        let text = format(&segments, false);
        assert!(text.split("\n\n").count() >= 2);
        assert!(text.split("\n\n").all(|p| p.ends_with('.') && p.chars().count() < PARAGRAPH_CHARS + sentence.len()));
    }

    #[test]
    fn chunks_split_between_paragraphs_then_sentences() {
        let text = "One two three.\n\nFour five six.\n\nSeven eight nine.";
        assert_eq!(chunks(text, 40), vec!["One two three.\n\nFour five six.", "Seven eight nine."]);
        assert_eq!(chunks(text, 1000), vec![text]);
        let long = "First sentence here. Second sentence here. Third one.";
        assert_eq!(chunks(long, 25), vec!["First sentence here.", "Second sentence here.", "Third one."]);
        assert!(chunks("", 10).is_empty());
        for part in chunks(&"word ".repeat(100), 30) {
            assert!(part.chars().count() <= 30, "{:?}", part);
        }
    }

    #[test]
    fn prompts_carry_the_dictionary_and_the_last_words() {
        let segments = vec![seg(0.0, 2.0, "First words here."), seg(2.0, 4.0, "And then the last ones.")];
        assert_eq!(block_prompt("GitHub, Prodega.", std::iter::empty()), "GitHub, Prodega.");
        assert_eq!(block_prompt(" GitHub, Prodega ", std::iter::empty()), "GitHub, Prodega.");
        assert_eq!(block_prompt("", segments.iter()), "First words here. And then the last ones.");
        assert_eq!(
            block_prompt("Prodega", segments.iter()),
            "Prodega. First words here. And then the last ones."
        );
        let long: Vec<Segment> = (0..100).map(|i| seg(i as f32, i as f32 + 1.0, "word")).collect();
        let prompt = block_prompt("", long.iter());
        assert!(prompt.chars().count() <= CONTEXT_CHARS && prompt.starts_with("word"), "{}", prompt);
    }

    #[test]
    fn segments_keep_whispers_capitals_and_paragraphs_start_with_one() {
        assert_eq!(tidy_segment("  go to  the park "), "go to the park");
        let segments = vec![seg(0.0, 2.0, "maybe we could"), seg(2.1, 4.0, "go to the park."), seg(9.0, 10.0, "then home.")];
        assert_eq!(format(&segments, false), "Maybe we could go to the park.\n\nThen home.");
    }

    #[test]
    fn chinese_japanese_and_korean_get_smaller_summary_parts() {
        assert_eq!(summary_chunk_chars("An English transcript about the budget."), SUMMARY_CHUNK_CHARS);
        assert_eq!(summary_chunk_chars("我们下周二开会，讨论预算和新的产品发布计划。"), SUMMARY_CHUNK_CHARS / 3);
        assert_eq!(summary_chunk_chars("회의는 다음 주 화요일입니다"), SUMMARY_CHUNK_CHARS / 3);
        assert_eq!(summary_chunk_chars(""), SUMMARY_CHUNK_CHARS);
    }

    #[test]
    fn times_read_like_a_player() {
        assert_eq!(clock(0), "0:00");
        assert_eq!(clock(245_900), "4:05");
        assert_eq!(clock(3_723_000), "1:02:03");
    }
}
