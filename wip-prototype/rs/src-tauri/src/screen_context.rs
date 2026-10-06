//! Screen context: names and terms visible in the window the user dictates
//! into, so Whisper and the AI spell them right. Read through UI Automation
//! when the hotkey is pressed; only the word list is used, nothing is stored.

use std::collections::HashMap;

/// Screen text read per dictation; more only costs time.
pub const MAX_CHARS: usize = 30_000;
/// Terms passed to the AI.
pub const MAX_TERMS: usize = 40;
/// Terms put in front of the dictionary in Whisper's prompt, which only
/// holds about 220 tokens.
pub const MAX_WHISPER_TERMS: usize = 20;

const MIN_CHARS: usize = 3;
const MAX_TERM_CHARS: usize = 40;

/// Very common English and German words. Capitalised or in capitals
/// ("MUST", "NICHT", menu labels) they are still not names.
const COMMON: &[&str] = &[
    "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was", "one", "our",
    "out", "day", "get", "has", "him", "his", "how", "new", "now", "old", "see", "two", "way", "who", "did",
    "its", "let", "put", "say", "she", "too", "use", "must", "should", "will", "would", "could", "this",
    "that", "with", "from", "have", "they", "what", "when", "where", "which", "while", "there", "their",
    "then", "than", "them", "these", "those", "into", "only", "also", "just", "like", "more", "most", "some",
    "such", "very", "your", "about", "after", "again", "before", "being", "between", "both", "each",
    "every", "here", "other", "over", "same", "under", "until", "done", "make", "made", "note", "todo",
    "info", "warning", "error", "true", "false", "none", "null", "yes", "okay", "eof", "next", "back",
    "open", "save", "close", "edit", "view", "help", "file", "find", "copy", "paste", "send", "reply",
    "cancel", "und", "oder", "aber", "nicht", "kein", "keine", "der", "die", "das", "den", "dem", "des",
    "ein", "eine", "einer", "eines", "ist", "sind", "war", "hat", "haben", "wird", "werden", "mit", "von",
    "für", "auf", "aus", "bei", "nach", "vor", "über", "unter", "auch", "noch", "schon", "nur", "sehr",
    "hier", "dort", "wenn", "dann", "weil", "dass", "wie", "wer", "wir", "ihr", "sie", "ich", "uns",
    "euch", "mein", "dein", "sein", "unser", "bitte", "danke", "hallo", "neu", "alle", "jetzt", "heute",
    "morgen",
];

/// Units after a number: "0.32s", "13h", "73k", "5min".
const UNITS: &[&str] = &["min", "sec", "mib", "gib", "kib", "fps", "rpm", "bit", "eur", "chf", "usd"];

fn is_measure(word: &str) -> bool {
    let rest = word.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ',');
    rest.len() < word.len()
        && rest.chars().all(|c| c.is_ascii_lowercase())
        && (rest.chars().count() <= 2 || UNITS.contains(&rest))
}

/// Only letters, digits and joining characters; code like `open(p` or
/// `Ctrl+Shift` is not a term.
fn is_plain_token(word: &str) -> bool {
    word.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | '\'' | '\u{2019}'))
        && word.matches('.').count() <= 2
}

/// How much a word looks like a name or term Whisper could misspell.
fn score(word: &str, sentence_start: bool) -> u8 {
    let chars: Vec<char> = word.chars().collect();
    let letters = chars.iter().filter(|c| c.is_alphabetic()).count();
    let digits = chars.iter().filter(|c| c.is_ascii_digit()).count();
    if letters == 0 || !is_plain_token(word) || is_measure(word) || COMMON.contains(&word.to_lowercase().as_str()) {
        return 0;
    }
    // whisper.cpp, next.js, snake_case, Grüssen-Shop, Paperless-ngx
    let joined = chars.windows(3).any(|w| {
        w[0].is_alphanumeric() && matches!(w[1], '.' | '_' | '-') && w[2].is_alphanumeric()
    });
    let hyphen_only = joined && !word.contains(['.', '_']);
    let camel = chars.windows(2).any(|w| w[0].is_lowercase() && w[1].is_uppercase());
    let first_upper = chars[0].is_uppercase();
    if camel || digits > 0 || (joined && !hyphen_only) || (hyphen_only && (first_upper || camel)) {
        return 4;
    }
    let all_upper = chars.iter().filter(|c| c.is_alphabetic()).all(|c| c.is_uppercase());
    if all_upper && (3..=10).contains(&letters) {
        return 3;
    }
    if first_upper && !sentence_start {
        // Letters German does not use (Yılmaz, Şükrü, Jiménez) mark names.
        let foreign = chars.iter().any(|c| !c.is_ascii() && !"äöüÄÖÜß".contains(*c));
        return if foreign { 3 } else { 2 };
    }
    0
}

/// How much a word inside a sentence looks like a name or term (0 = not).
pub(crate) fn term_score(word: &str) -> u8 {
    score(word, false)
}

/// Words from the screen text worth giving Whisper and the AI: names,
/// brands and technical terms, best first. Common words, words at the start
/// of a line or sentence, links, paths, emails and entries already in
/// `exclude` (the dictionary) are left out.
pub fn terms(text: &str, exclude: &[String], max: usize) -> Vec<String> {
    struct Seen {
        word: String,
        score: u8,
        count: u32,
        first: usize,
    }
    let excluded: Vec<String> = exclude.iter().map(|e| e.to_lowercase()).collect();
    let mut seen: HashMap<String, Seen> = HashMap::new();
    let mut order = 0;
    for line in text.lines() {
        let mut sentence_start = true;
        for raw in line.split_whitespace() {
            let word = raw.trim_matches(|c: char| !c.is_alphanumeric());
            let ends_sentence = raw.ends_with(['.', '!', '?', ':']);
            let usable = word.chars().count() >= MIN_CHARS
                && word.chars().count() <= MAX_TERM_CHARS
                && !word.contains(['@', '/', '\\', ':', '<', '>', '=', '&', '?', '#']);
            if usable {
                let s = score(word, sentence_start);
                let key = word.to_lowercase();
                if s > 0 && !excluded.contains(&key) {
                    order += 1;
                    let entry = seen.entry(key).or_insert(Seen { word: word.to_string(), score: s, count: 0, first: order });
                    entry.count += 1;
                    if s > entry.score {
                        entry.score = s;
                        entry.word = word.to_string();
                    }
                }
            }
            sentence_start = ends_sentence;
        }
    }
    let mut found: Vec<Seen> = seen.into_values().collect();
    found.sort_by(|a, b| b.score.cmp(&a.score).then(b.count.cmp(&a.count)).then(a.first.cmp(&b.first)));
    found.into_iter().take(max).map(|s| s.word).collect()
}

/// The screen terms that resemble one to three words of `transcript`
/// (folded like the dictionary; from six letters on, a letter off per
/// four). Only those can help the AI, and each term costs prompt time
/// (about 1.3 ms per token on an RX 6800).
pub fn relevant_terms(terms: &[String], transcript: &str) -> Vec<String> {
    use crate::dictionary::{fold, levenshtein};
    let words: Vec<String> = transcript.split_whitespace().map(fold).filter(|w| !w.is_empty()).collect();
    let mut spans = Vec::new();
    for len in 1..=3 {
        for window in words.windows(len) {
            spans.push(window.concat());
        }
    }
    terms
        .iter()
        .filter(|term| {
            let folded = fold(term);
            let len = folded.chars().count();
            let typos = if len >= 6 { len / 4 } else { 0 };
            !folded.is_empty()
                && spans.iter().any(|span| {
                    span == &folded
                        || (typos > 0
                            && span.chars().count().abs_diff(folded.chars().count()) <= typos
                            && levenshtein(span, &folded) <= typos)
                })
        })
        .cloned()
        .collect()
}

/// Whisper's prompt: screen terms first, the dictionary last, since Whisper
/// keeps the end of a prompt that is too long. Only name-like terms go to
/// Whisper; code terms (`whisper.cpp`, `llama_server`) only to the AI, as
/// Whisper tends to copy the style of its prompt.
pub fn whisper_prompt(screen_terms: &[String], dictionary_prompt: &str) -> String {
    let screen: Vec<&str> = screen_terms
        .iter()
        .filter(|t| !t.contains(['.', '_']))
        .take(MAX_WHISPER_TERMS)
        .map(String::as_str)
        .collect();
    match (screen.is_empty(), dictionary_prompt.trim().is_empty()) {
        (true, _) => dictionary_prompt.to_string(),
        (false, true) => screen.join(", "),
        (false, false) => format!("{}, {}", screen.join(", "), dictionary_prompt.trim()),
    }
}

/// The visible text of the window with the focus, at most `max_chars`.
/// Blocking: 20 ms for a web page, about 200 ms for VS Code.
pub fn read_window_text(max_chars: usize) -> Option<String> {
    imp::read_window_text(max_chars)
}

#[cfg(windows)]
mod imp {
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        IUIAutomationElement, IUIAutomationTextPattern, IUIAutomationValuePattern, TreeScope_Descendants,
        UIA_ControlTypePropertyId, UIA_IsOffscreenPropertyId, UIA_NamePropertyId, UIA_TextControlTypeId,
        UIA_TextPatternId, UIA_ValuePatternId,
    };

    const CONTROL_DOCUMENT: i32 = 50030;
    /// Labels read per window; VS Code with a long chat has about 1,000.
    const MAX_LABELS: i32 = 3000;

    fn push_capped(out: &mut String, text: &str, max_chars: usize) -> bool {
        let room = max_chars.saturating_sub(out.chars().count());
        if room == 0 {
            return false;
        }
        out.extend(text.chars().take(room));
        out.push('\n');
        true
    }

    /// The visible text of a native document (Notepad, Word). Chromium's
    /// takes seconds, and its text is in the labels anyway.
    unsafe fn native_document_text(el: &IUIAutomationElement, max_chars: usize) -> Option<String> {
        if el.CurrentFrameworkId().map(|b| b.to_string()).unwrap_or_default() == "Chrome" {
            return None;
        }
        if el.CurrentControlType().map(|c| c.0).unwrap_or(0) != CONTROL_DOCUMENT {
            return None;
        }
        let pattern = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId).ok()?;
        let ranges = pattern.GetVisibleRanges().ok()?;
        let mut text = String::new();
        for i in 0..ranges.Length().unwrap_or(0) {
            if let Ok(range) = ranges.GetElement(i) {
                let part = range.GetText(max_chars as i32).map(|b| b.to_string()).unwrap_or_default();
                if !push_capped(&mut text, &part, max_chars) {
                    break;
                }
            }
        }
        Some(text)
    }

    pub fn read_window_text(max_chars: usize) -> Option<String> {
        let uia = crate::uia::automation()?;
        unsafe {
            let focused = uia.GetFocusedElement().ok()?;
            let walker = uia.ControlViewWalker().ok()?;
            let root = uia.GetRootElement().ok()?;
            let mut text = String::new();

            // What the user has written in the field so far.
            if !focused.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(true) {
                if let Ok(value) = focused.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
                    let v = value.CurrentValue().map(|b| b.to_string()).unwrap_or_default();
                    push_capped(&mut text, &v, max_chars / 4);
                }
            }

            // Up to the top-level window; a native document on the way
            // gives its visible text.
            let mut top = focused.clone();
            let mut document_read = false;
            for _ in 0..60 {
                if !document_read {
                    if let Some(doc) = native_document_text(&top, max_chars) {
                        push_capped(&mut text, &doc, max_chars);
                        document_read = true;
                    }
                }
                match walker.GetParentElement(&top) {
                    Ok(parent) if !uia.CompareElements(&parent, &root).map(|b| b.as_bool()).unwrap_or(true) => {
                        top = parent
                    }
                    _ => break,
                }
            }

            // Every label on screen in the window.
            let condition = uia
                .CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_TextControlTypeId.0))
                .ok()?;
            let request = uia.CreateCacheRequest().ok()?;
            request.AddProperty(UIA_NamePropertyId).ok()?;
            request.AddProperty(UIA_IsOffscreenPropertyId).ok()?;
            if let Ok(labels) = top.FindAllBuildCache(TreeScope_Descendants, &condition, &request) {
                for i in 0..labels.Length().unwrap_or(0).min(MAX_LABELS) {
                    let Ok(label) = labels.GetElement(i) else { continue };
                    if label.CachedIsOffscreen().map(|b| b.as_bool()).unwrap_or(false) {
                        continue;
                    }
                    let name = label.CachedName().map(|b| b.to_string()).unwrap_or_default();
                    if !name.trim().is_empty() && !push_capped(&mut text, name.trim(), max_chars) {
                        break;
                    }
                }
            }
            Some(text)
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn read_window_text(_max_chars: usize) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIL: &str = "Re: Offerte Buchungssystem
From:
Ümit Yılmaz <termine@coiffeur-uemit.ch>
Hallo Oggi, danke für die Offerte. Ich habe mit Kübra und Şükrü gesprochen, wir möchten das Paket Premium nehmen. Können wir am Mittwoch um 19:00 in Pratteln die Details besprechen? Die Salon-Agenda sollte auch mit dem Grüssen-Shop verbunden werden.
Hi Ümit, the Vercel deployment is ready, and the TWINT plugin is waiting for approval. I'll send the PDF from Paperless-ngx tomorrow.
File
Edit
Selection";

    #[test]
    fn picks_names_brands_and_terms() {
        let found = terms(MAIL, &[], MAX_TERMS);
        for expected in ["Salon-Agenda", "Grüssen-Shop", "Paperless-ngx", "TWINT", "Yılmaz", "Şükrü", "Kübra", "Pratteln", "Vercel", "Oggi"] {
            assert!(found.iter().any(|t| t == expected), "{expected} missing from {found:?}");
        }
        // Special spellings rank first.
        assert!(found.iter().position(|t| t == "Grüssen-Shop") < found.iter().position(|t| t == "Pratteln"));
    }

    #[test]
    fn skips_line_starts_links_mail_and_small_words() {
        let found = terms(MAIL, &[], MAX_TERMS);
        for skipped in ["File", "Edit", "Selection", "Hallo", "From", "the", "termine@coiffeur-uemit.ch", "19:00", "Ich"] {
            assert!(!found.iter().any(|t| t == skipped), "{skipped} should be skipped: {found:?}");
        }
        assert!(terms("see https://github.com/oggii/RudariFlow and C:\\t\\rf", &[], 10).is_empty());
    }

    #[test]
    fn dictionary_entries_are_not_repeated_and_the_list_is_capped() {
        let found = terms(MAIL, &["grüssen-shop".into(), "TWINT".into()], MAX_TERMS);
        assert!(!found.iter().any(|t| t == "Grüssen-Shop" || t == "TWINT"));
        assert_eq!(terms(MAIL, &[], 3).len(), 3);
    }

    #[test]
    fn code_terms_count() {
        let found = terms("run whisper.cpp with the useState hook and RX6800 via llama_server", &[], 10);
        assert_eq!(found, ["whisper.cpp", "useState", "RX6800", "llama_server"]);
    }

    #[test]
    fn code_fragments_measures_and_shouted_words_are_skipped() {
        let chat = "Updated app_of(hwnd) and json.load(io.open(p in 0.32s, 13h ago, 73k tokens.
You MUST NOT use EOF here. The Claude-CLI-backed service runs on GitLab, see CmdOrCtrl+Shift+F9 and 0ggi.";
        let found = terms(chat, &[], MAX_TERMS);
        for skipped in ["app_of(hwnd", "json.load(io.open(p", "0.32s", "13h", "73k", "MUST", "NOT", "EOF", "CmdOrCtrl+Shift+F9"] {
            assert!(!found.iter().any(|t| t == skipped), "{skipped} should be skipped: {found:?}");
        }
        for kept in ["Claude-CLI-backed", "GitLab", "0ggi"] {
            assert!(found.iter().any(|t| t == kept), "{kept} missing from {found:?}");
        }
    }

    #[test]
    fn only_terms_the_dictation_mentions_go_to_the_ai() {
        let screen = terms(MAIL, &[], MAX_TERMS);
        let heard = "Hi Umit Yilmaz, I'll send the PDF from paperless NGX and the salon agenda tomorrow.";
        let kept = relevant_terms(&screen, heard);
        for expected in ["Yılmaz", "Paperless-ngx", "Salon-Agenda"] {
            assert!(kept.iter().any(|t| t == expected), "{expected} missing from {kept:?}");
        }
        for dropped in ["Vercel", "TWINT", "Pratteln", "Kübra", "Grüssen-Shop"] {
            assert!(!kept.iter().any(|t| t == dropped), "{dropped} should be dropped: {kept:?}");
        }
        // A letter off in a longer name still counts; short terms must match exactly.
        let list: Vec<String> = ["Kubernetes", "Anna", "RX6800"].map(String::from).to_vec();
        assert_eq!(relevant_terms(&list, "deploy it on kubernetis, ask Ana about the rx 6800"), ["Kubernetes", "RX6800"]);
        assert!(relevant_terms(&list, "").is_empty());
    }

    #[test]
    fn whisper_gets_only_name_like_terms() {
        let screen: Vec<String> = ["whisper.cpp", "Yılmaz", "llama_server", "GitHub"].map(String::from).to_vec();
        assert_eq!(whisper_prompt(&screen, ""), "Yılmaz, GitHub");
    }

    #[test]
    fn whisper_prompt_puts_the_dictionary_last() {
        let screen: Vec<String> = (1..=25).map(|i| format!("Term{i}")).collect();
        let prompt = whisper_prompt(&screen, "GitHub, Tauri");
        assert!(prompt.starts_with("Term1, Term2"));
        assert!(prompt.ends_with("Term20, GitHub, Tauri"));
        assert_eq!(whisper_prompt(&[], "GitHub"), "GitHub");
        assert_eq!(whisper_prompt(&screen[..2], "  "), "Term1, Term2");
    }
}
