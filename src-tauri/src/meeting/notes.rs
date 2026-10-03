//! The AI's notes on a meeting: Summary, Decisions and Action items. The
//! model answers under three fixed English headings, in the meeting's
//! language; `parse` reads them back, tolerant of what small models write
//! instead: translated or reworded headings, Markdown variations, bullets,
//! numbers, checkboxes, bold text, placeholders for empty sections, closing
//! remarks.

use super::store::{ActionItem, Notes};
use crate::file_transcribe::written_in;

/// Instructions for the notes of a meeting (or of notes on its parts).
pub fn meeting_prompt(language: Option<&str>) -> String {
    format!(
        "You write the notes of a meeting from its transcript. \"You\" is the person who recorded it; \
         the others are \"Others\" or \"Speaker 1\", \"Speaker 2\" and so on, or their names. {} \
         Answer with exactly these three sections, each starting with its heading on a line of its \
         own. Keep the three headings exactly as written here, in English, even when you write the \
         rest in another language:\n\
         ## Summary\n\
         Two to four sentences on what the meeting was about and what came out of it.\n\
         ## Decisions\n\
         What was decided, one per line, starting with \"- \".\n\
         ## Action items\n\
         Who does what by when, one per line, starting with \"- \", as far as the transcript says.\n\
         If a section has nothing, write nothing under its heading. Use only what the transcript \
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

/// Bullets and numbers in front of a line, only when followed by white
/// space (so "3.5 million" stays whole); the line without them.
fn strip_marker(text: &str, numbers: bool) -> Option<&str> {
    let mut chars = text.chars();
    let first = chars.next()?;
    let rest = if matches!(first, '-' | '*' | '+' | '•' | '–' | '—') {
        chars.as_str()
    } else if numbers {
        let digits = text.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        text[digits..].strip_prefix(['.', ')'])?
    } else {
        return None;
    };
    (rest.is_empty() || rest.starts_with(char::is_whitespace)).then(|| rest.trim_start())
}

/// Bold markup removed, its text kept.
fn unmark(text: &str) -> String {
    text.replace("**", "").replace("__", "")
}

/// The section a line names and the text after the heading on the same
/// line: "## Summary", "**Zusammenfassung:** Das Team…", "2. Next steps".
fn heading(line: &str) -> Option<(Section, &str)> {
    if strip_marker(line, false).is_some() {
        return None; // a bullet, not a heading
    }
    let mut t = line.trim_start_matches(['#', '*', '_', ' ']);
    let digits = t.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && t[digits..].starts_with(['.', ')']) {
        t = t[digits + 1..].trim_start_matches(['*', '_', ' ']);
    }
    let (name, rest) = t.split_once(':').unwrap_or((t, ""));
    let name = name.trim_matches(['*', '_', '#', ' ']).to_lowercase();
    let section = match name.as_str() {
        "summary" | "zusammenfassung" | "overview" | "überblick" | "ueberblick" => Section::Summary,
        "decisions" | "decision" | "key decisions" | "entscheidungen" | "entscheidung" | "beschlüsse"
        | "beschluesse" => Section::Decisions,
        "action items" | "action item" | "actions" | "action points" | "next steps" | "next step" | "to-dos"
        | "to-do" | "todos" | "to dos" | "tasks" | "aufgaben" | "aktionspunkte" | "nächste schritte"
        | "naechste schritte" => Section::Actions,
        _ => return None,
    };
    Some((section, rest.trim_start_matches(['*', '_', ' ']).trim()))
}

/// A line that looks like a heading whatever it says: "# …" or only bold.
fn heading_like(line: &str) -> bool {
    if strip_marker(line, false).is_some() {
        return false;
    }
    let t = line.trim_end_matches(':');
    let bold = |m: &str| t.len() > 2 * m.len() && t.starts_with(m) && t.ends_with(m) && !t[m.len()..t.len() - m.len()].contains(m);
    line.starts_with('#') || bold("**") || bold("__")
}

/// A rule line ("---", "***").
fn is_rule(line: &str) -> bool {
    line.len() >= 3 && line.chars().all(|c| matches!(c, '-' | '*' | '_' | '='))
}

/// What models write for an empty section: a short line (6 words at most)
/// that is only punctuation, or is or starts with "none", "nothing", "n/a"
/// or "nichts", or starts with "no", "kein" or "keine" and then is bare or
/// has a section word next ("No decisions were made", "Keine Aufgaben"),
/// optionally after one adjective ("No explicit decisions", "Keine
/// konkreten Aufgaben"). "Kein Release vor Montag" is a real item.
fn is_nothing(text: &str) -> bool {
    const NOTHING: [&str; 4] = ["none", "nothing", "n/a", "nichts"];
    const SECTION_WORDS: [&str; 17] = [
        "decision", "decisions", "entscheidung", "entscheidungen", "beschluss", "beschlüsse", "beschluesse",
        "action", "actions", "aufgabe", "aufgaben", "task", "tasks", "punkte", "schritte", "next", "to-dos",
    ];
    let plain = unmark(text);
    if plain.split_whitespace().count() > 6 {
        return false;
    }
    let t = plain.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
    if t.is_empty() || NOTHING.iter().any(|p| t == *p || t.strip_prefix(p).is_some_and(|r| r.starts_with(' '))) {
        return true;
    }
    let words: Vec<&str> = t.split_whitespace().map(|w| w.trim_matches(|c: char| !c.is_alphanumeric())).collect();
    matches!(words[0], "no" | "kein" | "keine")
        && (words.len() == 1 || words[1..].iter().take(2).any(|w| SECTION_WORDS.contains(w) || *w == "todos"))
}

/// A list line: its text (`None` for a placeholder), whether a checkbox
/// says done, whether it had a bullet, number or checkbox.
struct Item {
    text: Option<String>,
    done: bool,
    bulleted: bool,
}

fn item(line: &str) -> Item {
    let mut text = line.trim();
    let mut bulleted = false;
    if let Some(rest) = strip_marker(text, true) {
        text = rest;
        bulleted = true;
    }
    let mut done = false;
    for (mark, is_done) in [("[ ]", false), ("[x]", true), ("[X]", true)] {
        if let Some(rest) = text.strip_prefix(mark) {
            text = rest.trim_start();
            done = is_done;
            bulleted = true;
            break;
        }
    }
    let text = unmark(text).trim().to_string();
    Item { text: (!is_nothing(&text)).then_some(text), done, bulleted }
}

#[derive(Default)]
struct Draft {
    before: Vec<String>,
    summary: Vec<String>,
    notes: Notes,
    /// A bulleted line came in this section: lines without a bullet after
    /// it (a closing remark) are not items.
    listed: bool,
}

impl Draft {
    fn add(&mut self, section: Section, line: &str) {
        match section {
            Section::Before => self.before.push(unmark(line)),
            Section::Summary => self.summary.push(unmark(line)),
            Section::Decisions | Section::Actions => {
                let it = item(line);
                let keep = it.bulleted || !self.listed;
                self.listed |= it.bulleted;
                if let (true, Some(text)) = (keep, it.text) {
                    match section {
                        Section::Decisions => self.notes.decisions.push(text),
                        _ => self.notes.action_items.push(ActionItem { text, done: it.done }),
                    }
                }
            }
        }
    }
}

/// The model's answer as notes. Headings are found in English or German,
/// with Markdown around them or text after them. Without a known heading,
/// exactly three heading-like lines count as Summary, Decisions and Action
/// items in that order. Text before the first heading is the summary when
/// the answer has no Summary heading. In Decisions and Action items, lines
/// without a bullet count as items only until the first bulleted line:
/// after that they are closing remarks and dropped. A missing or empty
/// section stays empty.
pub fn parse(answer: &str) -> Notes {
    let lines: Vec<&str> = answer.lines().map(str::trim).filter(|l| !l.is_empty() && !is_rule(l)).collect();
    let known = lines.iter().any(|l| heading(l).is_some());
    let loose: Vec<usize> = if known {
        Vec::new()
    } else {
        let found: Vec<usize> = (0..lines.len()).filter(|&i| heading_like(lines[i])).collect();
        if found.len() == 3 {
            found
        } else {
            Vec::new()
        }
    };
    let mut draft = Draft::default();
    let mut section = Section::Before;
    let mut summary_found = false;
    for (i, line) in lines.iter().enumerate() {
        if let Some((s, rest)) = heading(line) {
            section = s;
            summary_found |= s == Section::Summary;
            draft.listed = false;
            if !rest.is_empty() {
                draft.add(s, rest);
            }
        } else if let Some(n) = loose.iter().position(|&l| l == i) {
            section = [Section::Summary, Section::Decisions, Section::Actions][n];
            summary_found |= n == 0;
            draft.listed = false;
        } else {
            draft.add(section, line);
        }
    }
    let summary = if summary_found { draft.summary } else { draft.before }.join("\n");
    let mut notes = draft.notes;
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

    #[test]
    fn what_a_small_model_really_writes() {
        let notes = parse(
            "Hier sind die Notizen zum Meeting:\n\n**Zusammenfassung:** Das Team plante die Version 10.\nDer Start ist am Freitag.\n\n### Entscheidungen\n* **Release:** Freitag um 14 Uhr\n* Ohne Beta\n\n## 3. Aufgaben\n- [ ] **Saad:** schreibt die Release-Notes bis Donnerstag\n- [x] Anna testet den Installer\n\nLet me know if you need anything else!",
        );
        assert_eq!(notes.summary, "Das Team plante die Version 10.\nDer Start ist am Freitag.", "intro dropped, markup gone");
        assert_eq!(notes.decisions, ["Release: Freitag um 14 Uhr", "Ohne Beta"]);
        let actions: Vec<(&str, bool)> = notes.action_items.iter().map(|a| (a.text.as_str(), a.done)).collect();
        assert_eq!(
            actions,
            [("Saad: schreibt die Release-Notes bis Donnerstag", false), ("Anna testet den Installer", true)],
            "checkboxes set done; the closing remark is not an item"
        );
        let notes = parse("## 1) Overview\nA call.\n## 2) Key decisions\nKeine.\n## 3) Next steps\n- Saad calls Anna\n- Ruf mich an\nHope that helps.\n---");
        assert_eq!(notes.summary, "A call.");
        assert!(notes.decisions.is_empty(), "a placeholder");
        let texts: Vec<&str> = notes.action_items.iter().map(|a| a.text.as_str()).collect();
        assert_eq!(texts, ["Saad calls Anna", "Ruf mich an"], "a closing sentence is dropped, a closing list item kept");
    }

    #[test]
    fn text_on_the_heading_line_counts() {
        let notes = parse("**Summary:** The team met.\nThey agreed.\n**Decisions**: Ship on Friday\n__Action items:__ - Saad writes");
        assert_eq!(notes.summary, "The team met.\nThey agreed.");
        assert_eq!(notes.decisions, ["Ship on Friday"]);
        assert_eq!(notes.action_items[0].text, "Saad writes");
    }

    #[test]
    fn a_number_is_not_a_bullet() {
        let notes = parse("## Decisions\n3.5 million for the launch\n## Action items\n- 3.5 million to Anna\n2) **Anna** reports\n-5 degrees is the limit");
        assert_eq!(notes.decisions, ["3.5 million for the launch"], "no bullet, nothing lost");
        let texts: Vec<&str> = notes.action_items.iter().map(|a| a.text.as_str()).collect();
        assert_eq!(texts, ["3.5 million to Anna", "Anna reports"], "after a bullet only bullets are items");
        assert_eq!(parse("## Decisions\n**Saad:** writes").decisions, ["Saad: writes"], "a bold start loses nothing");
    }

    #[test]
    fn placeholders_are_short_and_only_placeholders() {
        let notes = parse(
            "## Decisions\n- (None)\n- No decisions were made.\n- —\n- Keine Entscheidungen\n- None of the three options was chosen by the whole team in the end\n## Action items\n- N/A\n- Nothing",
        );
        assert_eq!(notes.decisions, ["None of the three options was chosen by the whole team in the end"], "over 6 words");
        assert!(notes.action_items.is_empty());
    }

    #[test]
    fn three_unknown_headings_are_summary_decisions_actions() {
        let notes = parse("# Meeting recap\nThe team met.\n**What was decided**\n- Ship\n## Who does what\n- Saad writes");
        assert_eq!(notes.summary, "The team met.");
        assert_eq!(notes.decisions, ["Ship"]);
        assert_eq!(notes.action_items[0].text, "Saad writes");
        // Not exactly three: no guessing.
        let notes = parse("# One\nText\n# Two\n- x");
        assert_eq!(notes.summary, "# One\nText\n# Two\n- x");
    }

    #[test]
    fn text_before_the_headings_is_the_summary_only_without_a_summary_heading() {
        let notes = parse("The team met on Monday.\n## Decisions\n- Ship it");
        assert_eq!(notes.summary, "The team met on Monday.");
        assert_eq!(notes.decisions, ["Ship it"]);
        assert_eq!(parse("Intro.\n## Summary\nThe call.").summary, "The call.");
        assert_eq!(parse("Intro.\n## Summary\nNone.\n## Decisions\n- A").summary, "");
    }

    #[test]
    fn no_and_kein_are_placeholders_only_before_a_section_word() {
        let kept = parse("## Decisions\n- No meeting on Friday\n- Kein Release vor Montag\n- Keine Beta-Phase\n## Action items\n- -5 degrees is the limit\n-5 degrees is the limit");
        assert_eq!(kept.decisions, ["No meeting on Friday", "Kein Release vor Montag", "Keine Beta-Phase"]);
        assert_eq!(kept.action_items.len(), 1);
        assert_eq!(kept.action_items[0].text, "-5 degrees is the limit", "stays whole as an item");
        let empty = parse(
            "## Decisions\n- No actions\n- No todos\n- No explicit decisions were made.\n- Keine konkreten Aufgaben.\n- Kein\n- No\n- No next steps\n## Action items\n- Keine Entscheidungen",
        );
        assert!(empty.decisions.is_empty(), "{:?}", empty.decisions);
        assert!(empty.action_items.is_empty());
    }
}
