//! Replacements: a short spoken phrase expands into longer text, e.g.
//! "my email" -> "info@example.com". Applied after cleanup, so the inserted
//! text keeps its own casing. With AI cleanup on, triggers are swapped for
//! placeholders before the model runs (`protect` / `restore`).

use regex::RegexBuilder;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Replacement {
    /// What you say. Matched case-insensitively as whole words.
    pub from: String,
    /// What gets inserted instead.
    pub to: String,
}

const EDGE_PUNCTUATION: &[char] = &['.', ',', '!', '?', ';', ':', '…', '。'];

/// The local date and time a replacement's variables are filled with.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Moment {
    pub year: u16,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    /// 0 = Sunday.
    pub weekday: u8,
}

impl Moment {
    pub fn now() -> Self {
        imp::local_now()
    }
}

const WEEKDAYS_EN: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_DE: [&str; 7] = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

/// Fill {date} (24.09.2026), {time} (16:45), {weekday}, {year} and
/// {iso_date} (2026-09-24) in a replacement text; other braces stay as
/// they are. `german` picks the weekday names.
pub fn fill_variables(text: &str, at: &Moment, german: bool) -> String {
    if !text.contains('{') {
        return text.to_string();
    }
    let weekdays = if german { WEEKDAYS_DE } else { WEEKDAYS_EN };
    text.replace("{date}", &format!("{:02}.{:02}.{}", at.day, at.month, at.year))
        .replace("{time}", &format!("{:02}:{:02}", at.hour, at.minute))
        .replace("{weekday}", weekdays[at.weekday as usize % 7])
        .replace("{year}", &at.year.to_string())
        .replace("{iso_date}", &format!("{}-{:02}-{:02}", at.year, at.month, at.day))
}

/// The replacements with their variables filled for this moment.
pub fn with_variables(replacements: &[Replacement], ui_language: &str) -> Vec<Replacement> {
    if !replacements.iter().any(|r| r.to.contains('{')) {
        return replacements.to_vec();
    }
    let (now, german) = (Moment::now(), ui_is_german(ui_language));
    replacements
        .iter()
        .map(|r| Replacement { from: r.from.clone(), to: fill_variables(&r.to, &now, german) })
        .collect()
}

/// The UI language setting ("de", "en", or "" for the Windows language).
fn ui_is_german(ui_language: &str) -> bool {
    match ui_language {
        "de" => true,
        "" => imp::windows_ui_is_german(),
        _ => false,
    }
}

#[cfg(windows)]
mod imp {
    use super::Moment;
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::Globalization::GetUserDefaultUILanguage;
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;

    pub fn local_now() -> Moment {
        // SAFETY: fills a plain struct.
        let t: SYSTEMTIME = unsafe {
            let mut t = std::mem::zeroed();
            GetLocalTime(&mut t);
            t
        };
        Moment {
            year: t.wYear,
            month: t.wMonth as u8,
            day: t.wDay as u8,
            hour: t.wHour as u8,
            minute: t.wMinute as u8,
            weekday: t.wDayOfWeek as u8,
        }
    }

    /// Primary language of the Windows display language: 0x07 = German.
    pub fn windows_ui_is_german() -> bool {
        // SAFETY: no arguments, returns a LANGID.
        (unsafe { GetUserDefaultUILanguage() } & 0x3ff) == 0x07
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Moment;

    pub fn local_now() -> Moment {
        Moment { year: 1970, month: 1, day: 1, hour: 0, minute: 0, weekday: 4 }
    }

    pub fn windows_ui_is_german() -> bool {
        false
    }
}

/// Replace every spoken trigger in `text`. When the whole dictation is just a
/// trigger ("My email."), the result is the replacement alone, without the
/// punctuation Whisper added around it.
pub fn apply_replacements(text: &str, replacements: &[Replacement]) -> String {
    let active = active(replacements);
    if active.is_empty() {
        return text.to_string();
    }
    if let Some(r) = whole_match(text, &active) {
        return r.to.clone();
    }
    replace_each(text, active, |r| r.to.clone())
}

/// A dictation prepared for the AI step: the model must not see (and reword)
/// trigger phrases, so each one becomes a placeholder that `restore` swaps
/// for the replacement text afterwards.
#[derive(Debug, Clone, PartialEq)]
pub enum Protected {
    /// The whole dictation is one trigger: paste this, skip the model.
    Whole(String),
    /// `values[i - 1]` replaces `placeholder(i)`.
    Text { text: String, values: Vec<String> },
}

pub fn placeholder(i: usize) -> String {
    format!("⟦{}⟧", i)
}

pub fn protect(text: &str, replacements: &[Replacement]) -> Protected {
    let active = active(replacements);
    if let Some(r) = whole_match(text, &active) {
        return Protected::Whole(r.to.clone());
    }
    let mut values = Vec::new();
    let text = replace_each(text, active, |r| {
        values.push(r.to.clone());
        placeholder(values.len())
    });
    Protected::Text { text, values }
}

pub fn restore(text: &str, values: &[String]) -> String {
    let mut out = text.to_string();
    for (i, value) in values.iter().enumerate() {
        out = out.replace(&placeholder(i + 1), value);
    }
    out
}

fn active(replacements: &[Replacement]) -> Vec<&Replacement> {
    replacements
        .iter()
        .filter(|r| !r.from.trim().is_empty())
        .collect()
}

fn whole_match<'a>(text: &str, active: &[&'a Replacement]) -> Option<&'a Replacement> {
    let bare = text
        .trim()
        .trim_matches(|c: char| c.is_whitespace() || EDGE_PUNCTUATION.contains(&c));
    active
        .iter()
        .find(|r| normalize(bare) == normalize(&r.from))
        .copied()
}

/// One pass over the text, longest trigger first, so text inserted for one
/// trigger is never matched by another. `insert` gives the text for a match.
fn replace_each<'a>(
    text: &str,
    active: Vec<&'a Replacement>,
    mut insert: impl FnMut(&'a Replacement) -> String,
) -> String {
    if active.is_empty() {
        return text.to_string();
    }
    let mut sorted = active;
    sorted.sort_by_key(|r| std::cmp::Reverse(normalize(&r.from).chars().count()));
    let parts: Vec<(String, &Replacement)> = sorted
        .into_iter()
        .filter_map(|r| trigger_pattern(&r.from).map(|p| (p, r)))
        .collect();
    let alternation = parts
        .iter()
        .map(|(p, _)| format!("({})", p))
        .collect::<Vec<_>>()
        .join("|");
    let Ok(re) = RegexBuilder::new(&alternation).case_insensitive(true).build() else {
        return text.to_string();
    };
    re.replace_all(text, |caps: &regex::Captures| {
        (1..caps.len())
            .find(|&i| caps.get(i).is_some())
            .map(|i| insert(parts[i - 1].1))
            .unwrap_or_default()
    })
    .into_owned()
}

fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Whole-word pattern for a trigger. Word boundaries are only required on
/// sides where the trigger starts or ends with a letter or digit, so a
/// trigger like "@home" still matches.
fn trigger_pattern(trigger: &str) -> Option<String> {
    let words: Vec<&str> = trigger.split_whitespace().collect();
    let first = words.first()?.chars().next()?;
    let last = words.last()?.chars().last()?;
    let body = words
        .iter()
        .map(|w| regex::escape(w))
        .collect::<Vec<_>>()
        .join(r"\s+");
    Some(format!(
        "{}{}{}",
        if first.is_alphanumeric() { r"\b" } else { "" },
        body,
        if last.is_alphanumeric() { r"\b" } else { "" },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variables_are_filled_with_the_moment() {
        let at = Moment { year: 2026, month: 9, day: 4, hour: 9, minute: 5, weekday: 4 };
        assert_eq!(
            fill_variables("Basel, {date} {time} ({weekday}, {iso_date}, {year}) {unknown}", &at, true),
            "Basel, 04.09.2026 09:05 (Donnerstag, 2026-09-04, 2026) {unknown}"
        );
        assert_eq!(fill_variables("{weekday}", &at, false), "Thursday");
        assert_eq!(fill_variables("no variables", &at, true), "no variables");
        // A snippet that is the whole dictation still pastes alone.
        let snippet = vec![Replacement { from: "today's date".into(), to: fill_variables("{date}", &at, true) }];
        assert_eq!(apply_replacements("Today's date.", &snippet), "04.09.2026");
    }

    fn r(from: &str, to: &str) -> Replacement {
        Replacement { from: from.into(), to: to.into() }
    }

    #[test]
    fn replaces_inline_and_keeps_punctuation() {
        let list = [r("my email", "info@0ggi.ch")];
        assert_eq!(
            apply_replacements("Write to my email, please.", &list),
            "Write to info@0ggi.ch, please."
        );
        assert_eq!(
            apply_replacements("My email is below.", &list),
            "info@0ggi.ch is below."
        );
    }

    #[test]
    fn whole_dictation_trigger_returns_replacement_only() {
        let list = [r("my signature", "Best regards\noggi")];
        assert_eq!(apply_replacements("My signature.", &list), "Best regards\noggi");
        assert_eq!(apply_replacements("  my   signature!  ", &list), "Best regards\noggi");
    }

    #[test]
    fn matches_whole_words_only() {
        let list = [r("cat", "dog")];
        assert_eq!(apply_replacements("The cat sat on the category.", &list), "The dog sat on the category.");
    }

    #[test]
    fn tolerates_extra_whitespace_in_speech() {
        let list = [r("zoom link", "https://zoom.us/j/1")];
        assert_eq!(
            apply_replacements("Here is the zoom  link.", &list),
            "Here is the https://zoom.us/j/1."
        );
    }

    #[test]
    fn replacement_text_is_literal() {
        let list = [r("price", "$1 and $2")];
        assert_eq!(apply_replacements("The price today.", &list), "The $1 and $2 today.");
    }

    #[test]
    fn inserted_text_is_not_replaced_again() {
        let list = [r("price", "cost"), r("cost", "xyz")];
        assert_eq!(apply_replacements("The price and cost.", &list), "The cost and xyz.");
    }

    #[test]
    fn longer_trigger_wins() {
        let list = [r("my email", "a@b.ch"), r("my email address", "c@d.ch")];
        assert_eq!(apply_replacements("Use my email address now.", &list), "Use c@d.ch now.");
    }

    #[test]
    fn empty_triggers_are_ignored() {
        let list = [r("  ", "x"), r("", "y")];
        assert_eq!(apply_replacements("Hello.", &list), "Hello.");
    }

    #[test]
    fn protect_swaps_triggers_for_placeholders() {
        let list = [r("my email", "info@0ggi.ch"), r("zoom link", "https://zoom.us/j/1")];
        let p = protect("Send the zoom link to my email and to my email again.", &list);
        let Protected::Text { text, values } = p else { panic!("expected text") };
        assert_eq!(text, "Send the ⟦1⟧ to ⟦2⟧ and to ⟦3⟧ again.");
        assert_eq!(values, ["https://zoom.us/j/1", "info@0ggi.ch", "info@0ggi.ch"]);
        assert_eq!(
            restore(&text, &values),
            "Send the https://zoom.us/j/1 to info@0ggi.ch and to info@0ggi.ch again."
        );
    }

    #[test]
    fn protect_whole_dictation_and_no_triggers() {
        let list = [r("my signature", "Best regards\noggi")];
        assert_eq!(protect("My signature.", &list), Protected::Whole("Best regards\noggi".into()));
        assert_eq!(
            protect("Nothing to see.", &list),
            Protected::Text { text: "Nothing to see.".into(), values: vec![] }
        );
        assert_eq!(
            protect("Nothing.", &[]),
            Protected::Text { text: "Nothing.".into(), values: vec![] }
        );
    }

    #[test]
    fn restore_is_literal() {
        assert_eq!(restore("Price: ⟦1⟧.", &["$1 and $2".to_string()]), "Price: $1 and $2.");
    }

    #[test]
    fn trigger_with_symbols_and_umlauts() {
        let list = [r("@home", "Zuhause"), r("grüße", "Liebe Grüße, oggi")];
        assert_eq!(apply_replacements("Bin @home.", &list), "Bin Zuhause.");
        assert_eq!(apply_replacements("Viele Grüße.", &list), "Viele Liebe Grüße, oggi.");
    }
}
