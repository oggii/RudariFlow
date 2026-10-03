//! The AI's notes on a meeting: Summary, Decisions and Action items. The
//! model answers under three fixed English headings, in the meeting's
//! language; `parse` reads them back, tolerant of Markdown variations.

use super::store::{ActionItem, Notes};
use crate::file_transcribe::written_in;

/// Instructions for the notes of a meeting (or of notes on its parts).
pub fn meeting_prompt(language: Option<&str>) -> String {
    format!(
        "You write the notes of a meeting from its transcript. \"You\" is the person who recorded it; \
         the others are \"Others\" or \"Speaker 1\", \"Speaker 2\" and so on, or their names. {} \
         Answer with exactly these three sections, each starting with its heading on a line of its \
         own, the headings in English exactly as written here:\n\
         ## Summary\n\
         Two to four sentences on what the meeting was about and what came out of it.\n\
         ## Decisions\n\
         What was decided, one per line, starting with \"- \".\n\
         ## Action items\n\
         Who does what by when, one per line, starting with \"- \", as far as the transcript says.\n\
         Leave a section empty when the transcript has nothing for it. Use only what the transcript \
         says, never invent anything. No other headings, no introduction, no closing remarks.",
        written_in(language)
    )
}

#[derive(Clone, Copy, PartialEq)]
enum Section {
    Before,
    Summary,
    Decisions,
    Actions,
}

/// The section a line names: "## Summary", "**Decisions:**", "Action items".
fn heading(line: &str) -> Option<Section> {
    let name = line.trim_start_matches(['#', '*', ' ']).trim_end_matches(['*', ':', ' ']).trim().to_lowercase();
    match name.as_str() {
        "summary" => Some(Section::Summary),
        "decisions" | "decision" => Some(Section::Decisions),
        "action items" | "action item" | "actions" => Some(Section::Actions),
        _ => None,
    }
}

/// What models write for an empty section.
fn is_nothing(text: &str) -> bool {
    let t = text.trim().trim_end_matches('.').trim().to_lowercase();
    matches!(t.as_str(), "" | "none" | "none mentioned" | "nothing" | "n/a" | "-" | "keine" | "nichts" | "keine erwähnt")
}

/// A list line without its "- ", "* ", "• " or "1. " in front; `None` when
/// it says there is nothing.
fn item(line: &str) -> Option<String> {
    let mut text = line.trim();
    if let Some(rest) = text.strip_prefix(['-', '*', '•']) {
        text = rest;
    } else {
        let digits = text.chars().take_while(char::is_ascii_digit).count();
        if digits > 0 && text[digits..].starts_with(['.', ')']) {
            text = &text[digits + 1..];
        }
    }
    let text = text.trim();
    (!is_nothing(text)).then(|| text.to_string())
}

/// The model's answer as notes. A missing or empty section stays empty; an
/// answer without any heading becomes the summary.
pub fn parse(answer: &str) -> Notes {
    let mut section = Section::Before;
    let mut summary: Vec<&str> = Vec::new();
    let mut before: Vec<&str> = Vec::new();
    let mut notes = Notes::default();
    for line in answer.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if let Some(s) = heading(line) {
            section = s;
            continue;
        }
        match section {
            Section::Before => before.push(line),
            Section::Summary => summary.push(line),
            Section::Decisions => notes.decisions.extend(item(line)),
            Section::Actions => notes.action_items.extend(item(line).map(|text| ActionItem { text, done: false })),
        }
    }
    if section == Section::Before {
        summary = before;
    }
    let summary = summary.join("\n");
    notes.summary = if is_nothing(&summary) { String::new() } else { summary };
    notes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_asks_for_three_fixed_headings_in_the_meetings_language() {
        let p = meeting_prompt(Some("German"));
        for h in ["## Summary", "## Decisions", "## Action items", "Write in German"] {
            assert!(p.contains(h), "{} in {}", h, p);
        }
        assert!(meeting_prompt(None).contains("the language of the transcript"));
    }

    #[test]
    fn three_sections_become_notes() {
        let notes = parse(
            "## Summary\nThe team planned the release.\nVersion ten ships Friday.\n\n## Decisions\n- Ship on Friday\n- Drop the beta\n\n## Action items\n- Saad writes the release notes by Thursday\n* Anna tests the installer",
        );
        assert_eq!(notes.summary, "The team planned the release.\nVersion ten ships Friday.");
        assert_eq!(notes.decisions, ["Ship on Friday", "Drop the beta"]);
        let actions: Vec<(&str, bool)> = notes.action_items.iter().map(|a| (a.text.as_str(), a.done)).collect();
        assert_eq!(actions, [("Saad writes the release notes by Thursday", false), ("Anna tests the installer", false)]);
    }

    #[test]
    fn markdown_variations_are_read_too() {
        let notes = parse("**Summary:**\nKurzes Treffen.\n**Decisions:**\n1. Freitag\n2) Ohne Beta\n**Action Items:**\nSaad schreibt die Notizen");
        assert_eq!(notes.summary, "Kurzes Treffen.");
        assert_eq!(notes.decisions, ["Freitag", "Ohne Beta"]);
        assert_eq!(notes.action_items[0].text, "Saad schreibt die Notizen", "a line without a dash");
    }

    #[test]
    fn missing_and_empty_sections_stay_empty() {
        let notes = parse("## Summary\nA short call.\n## Decisions\n- None.\n## Action items\n");
        assert_eq!(notes.summary, "A short call.");
        assert!(notes.decisions.is_empty() && notes.action_items.is_empty());
        let notes = parse("## Summary\nA short call.\n## Action items\n- Keine");
        assert!(notes.decisions.is_empty(), "no Decisions heading");
        assert!(notes.action_items.is_empty());
        let notes = parse("## Summary\nNone mentioned.\n## Decisions\n- Ship it");
        assert_eq!(notes.summary, "");
        assert_eq!(notes.decisions, ["Ship it"]);
        assert_eq!(parse(""), Notes::default());
    }

    #[test]
    fn an_answer_without_headings_becomes_the_summary() {
        let notes = parse("The team met.\n- They chose Friday.");
        assert_eq!(notes.summary, "The team met.\n- They chose Friday.");
        assert!(notes.decisions.is_empty() && notes.action_items.is_empty());
    }
}
