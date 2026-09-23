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
