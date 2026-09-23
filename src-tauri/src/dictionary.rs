//! The user's dictionary: names, brands and jargon. Stored as the
//! comma-separated `customPrompt` setting, which Whisper gets as its initial
//! prompt; here the entries also fix the spelling of the transcript
//! ("github" -> "GitHub") and are handed to the AI cleanup model.

use regex::RegexBuilder;

/// Split the stored setting into entries: commas or line breaks separate
/// them, blanks and case-insensitive duplicates are dropped, order is kept.
pub fn terms(custom_prompt: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in custom_prompt.split([',', '\n', '\r']) {
        let term = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if term.is_empty() || out.iter().any(|t| t.to_lowercase() == term.to_lowercase()) {
            continue;
        }
        out.push(term);
    }
    out
}

/// Write every dictionary entry found in `text` with the entry's exact
/// spelling. Matches whole words, ignoring case and extra spaces.
pub fn apply_casing(text: &str, terms: &[String]) -> String {
    let mut out = text.to_string();
    for term in terms {
        let words: Vec<&str> = term.split_whitespace().collect();
        let (Some(first), Some(last)) = (
            words.first().and_then(|w| w.chars().next()),
            words.last().and_then(|w| w.chars().last()),
        ) else {
            continue;
        };
        let pattern = format!(
            "{}{}{}",
            if first.is_alphanumeric() { r"\b" } else { "" },
            words.iter().map(|w| regex::escape(w)).collect::<Vec<_>>().join(r"\s+"),
            if last.is_alphanumeric() { r"\b" } else { "" },
        );
        let Ok(re) = RegexBuilder::new(&pattern).case_insensitive(true).build() else {
            continue;
        };
        out = re.replace_all(&out, regex::NoExpand(term.as_str())).into_owned();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_commas_and_lines_and_drops_duplicates() {
        assert_eq!(
            terms("Tauri, whisper.cpp,\n  oggi \r\n,GitHub, tauri,  ,Finn   Brown"),
            t(&["Tauri", "whisper.cpp", "oggi", "GitHub", "Finn Brown"])
        );
        assert!(terms("  ").is_empty());
    }

    #[test]
    fn fixes_spelling_of_known_terms() {
        let dict = t(&["GitHub", "oggi", "whisper.cpp", "Finn Brown", "RX 6800"]);
        assert_eq!(
            apply_casing("Push it to github and ask Oggi about Whisper.CPP.", &dict),
            "Push it to GitHub and ask oggi about whisper.cpp."
        );
        assert_eq!(apply_casing("Call finn  brown about the rx 6800.", &dict), "Call Finn Brown about the RX 6800.");
    }

    #[test]
    fn leaves_other_words_alone() {
        let dict = t(&["Polars", "cat"]);
        assert_eq!(apply_casing("The polar bear sat on the category.", &dict), "The polar bear sat on the category.");
        assert_eq!(apply_casing("CAT and polars.", &dict), "cat and Polars.");
    }
}
