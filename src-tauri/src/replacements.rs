//! Replacements: a short spoken phrase expands into longer text, e.g.
//! "my email" -> "info@example.com". Applied after cleanup, so the inserted
//! text keeps its own casing.

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

/// Replace every spoken trigger in `text`. When the whole dictation is just a
/// trigger ("My email."), the result is the replacement alone, without the
/// punctuation Whisper added around it.
pub fn apply_replacements(text: &str, replacements: &[Replacement]) -> String {
    let active: Vec<&Replacement> = replacements
        .iter()
        .filter(|r| !r.from.trim().is_empty())
        .collect();
    if active.is_empty() {
        return text.to_string();
    }

    let bare = text
        .trim()
        .trim_matches(|c: char| c.is_whitespace() || EDGE_PUNCTUATION.contains(&c));
    for r in &active {
        if normalize(bare) == normalize(&r.from) {
            return r.to.clone();
        }
    }

    // One pass over the text, longest trigger first, so text inserted by one
    // replacement is never matched by another.
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
            .map(|i| parts[i - 1].1.to.clone())
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
    fn trigger_with_symbols_and_umlauts() {
        let list = [r("@home", "Zuhause"), r("grüße", "Liebe Grüße, oggi")];
        assert_eq!(apply_replacements("Bin @home.", &list), "Bin Zuhause.");
        assert_eq!(apply_replacements("Viele Grüße.", &list), "Viele Liebe Grüße, oggi.");
    }
}
