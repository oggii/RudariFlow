//! A dictionary that learns from corrections: after a dictation the text
//! field is read once more, and words the user corrected by hand that look
//! like names or terms become dictionary suggestions ("Glyfert" corrected
//! to "Gleifert"). Only those words are kept, never the field's text, and
//! nothing reaches the dictionary without the user.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::dictionary::{fold, levenshtein};

/// A corrected word and what the dictation had written there.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Suggestion {
    pub word: String,
    pub heard: String,
    /// How often the same correction was seen.
    pub count: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    suggestions: Vec<Suggestion>,
    /// Words the user said no to; never suggested again.
    #[serde(default)]
    dismissed: Vec<String>,
}

fn store_path(app_dir: &Path) -> PathBuf {
    app_dir.join("dictionary-suggestions.json")
}

fn load(app_dir: &Path) -> Store {
    std::fs::read_to_string(store_path(app_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(app_dir: &Path, store: &Store) {
    if let Ok(json) = serde_json::to_string_pretty(store) {
        let _ = std::fs::write(store_path(app_dir), json);
    }
}

pub fn suggestions(app_dir: &Path) -> Vec<Suggestion> {
    load(app_dir).suggestions
}

/// Keep new corrections as suggestions, except words already in the
/// dictionary or dismissed before. Returns how many were new or seen again.
pub fn record(app_dir: &Path, corrections: &[(String, String)], dictionary: &[String]) -> usize {
    let mut store = load(app_dir);
    let known = |w: &str| {
        dictionary.iter().any(|d| d.eq_ignore_ascii_case(w)) || store.dismissed.iter().any(|d| d.eq_ignore_ascii_case(w))
    };
    let mut changed = 0;
    for (heard, word) in corrections {
        if known(word) {
            continue;
        }
        match store.suggestions.iter_mut().find(|s| s.word.eq_ignore_ascii_case(word)) {
            Some(s) => s.count += 1,
            None => store.suggestions.push(Suggestion { word: word.clone(), heard: heard.clone(), count: 1 }),
        }
        changed += 1;
    }
    if changed > 0 {
        save(app_dir, &store);
    }
    changed
}

/// The user added (`dismiss` false) or dismissed a suggestion.
pub fn resolve(app_dir: &Path, word: &str, dismiss: bool) {
    let mut store = load(app_dir);
    store.suggestions.retain(|s| !s.word.eq_ignore_ascii_case(word));
    if dismiss && !store.dismissed.iter().any(|d| d.eq_ignore_ascii_case(word)) {
        store.dismissed.push(word.to_string());
    }
    save(app_dir, &store);
}

/// A word without the punctuation around it.
fn core(word: &str) -> &str {
    word.trim_matches(|c: char| !c.is_alphanumeric())
}

/// Whether a word is worth a dictionary entry: a name, brand or term.
fn name_like(word: &str) -> bool {
    word.chars().filter(|c| c.is_alphabetic()).count() >= 3 && crate::screen_context::term_score(word) > 0
}

/// Mixed case beyond the first letter, as in "GitHub" or "iPhone".
fn has_inner_capital(word: &str) -> bool {
    word.chars().skip(1).any(char::is_uppercase)
}

/// Endings grammar changes; "Tisch" corrected to "Tische" is no spelling.
const ENDINGS: &[&str] = &["", "e", "n", "s", "en", "er", "es", "em", "ern", "ed", "ing", "'s"];

/// Two folded words that differ only in such an ending.
fn inflection(a: &str, b: &str) -> bool {
    let common = a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
    let rest = |w: &str| w.chars().skip(common).collect::<String>();
    common >= 3 && ENDINGS.contains(&rest(a).as_str()) && ENDINGS.contains(&rest(b).as_str())
}

/// Words the user corrected in `field` after the dictation `pasted` went
/// in: the pasted words are aligned with the part of the field that
/// matches them best (words compared folded, like the dictionary), and
/// single-word spelling corrections of name-like words are returned as
/// (heard, corrected). Nothing when the dictation cannot be found (more
/// than a third of its words changed, or it is gone).
pub fn corrections(pasted: &str, field: &str) -> Vec<(String, String)> {
    let p: Vec<&str> = pasted.split_whitespace().map(core).filter(|w| !w.is_empty()).collect();
    let f: Vec<&str> = field.split_whitespace().map(core).filter(|w| !w.is_empty()).collect();
    if p.is_empty() || f.is_empty() {
        return Vec::new();
    }
    let pf: Vec<String> = p.iter().map(|w| fold(w)).collect();
    let ff: Vec<String> = f.iter().map(|w| fold(w)).collect();
    // Words differ when they fold differently, or when the field's has
    // brand capitals the dictation lacked ("github" -> "GitHub").
    let differs = |a: usize, b: usize| pf[a] != ff[b] || p[a] != f[b] && has_inner_capital(f[b]);

    // Semi-global alignment: all of the dictation against any stretch of
    // the field (free start and end in the field).
    let (n, m) = (p.len(), f.len());
    let mut cost = vec![vec![0usize; m + 1]; n + 1];
    for (i, row) in cost.iter_mut().enumerate() {
        row[0] = i;
    }
    for i in 1..=n {
        for j in 1..=m {
            let sub = cost[i - 1][j - 1] + usize::from(differs(i - 1, j - 1));
            cost[i][j] = sub.min(cost[i - 1][j] + 1).min(cost[i][j - 1] + 1);
        }
    }
    // On a tie the longest stretch, so a corrected last word counts as
    // changed rather than as dropped.
    let (end, total) = (0..=m).rev().map(|j| (j, cost[n][j])).min_by_key(|&(_, c)| c).unwrap_or((0, n));
    if total * 3 > n {
        return Vec::new();
    }

    // Walk back and collect the substitutions.
    let mut out = Vec::new();
    let (mut i, mut j) = (n, end);
    while i > 0 && j > 0 {
        let changed = differs(i - 1, j - 1);
        if cost[i][j] == cost[i - 1][j - 1] + usize::from(changed) {
            if changed {
                let (heard, word) = (p[i - 1], f[j - 1]);
                let (fh, fw) = (&pf[i - 1], &ff[j - 1]);
                let close = levenshtein(fh, fw) <= (fw.chars().count() / 2).max(2);
                if close && !(fh != fw && inflection(fh, fw)) && name_like(word) && !out.iter().any(|(_, w): &(String, String)| w == word) {
                    out.push((heard.to_string(), word.to_string()));
                }
            }
            i -= 1;
            j -= 1;
        } else if cost[i][j] == cost[i - 1][j] + 1 {
            i -= 1;
        } else {
            j -= 1;
        }
    }
    out.reverse();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrected_names_become_suggestions() {
        let pasted = "Done, I booked Glyfert plus 6 at the Red Bull. Let's check with Umit tomorrow.";
        let field = "Hi team,\nDone, I booked Gleifert plus 6 at the Red Bull. Let's check with Ümit tomorrow.\nCheers";
        // "Umit" -> "Ümit" folds to the same word: nothing to learn there.
        assert_eq!(corrections(pasted, field), vec![("Glyfert".to_string(), "Gleifert".to_string())]);
    }

    #[test]
    fn brand_capitals_count_but_ordinary_words_do_not() {
        let pasted = "Push it to github and tell the team the sales are good.";
        let field = "Push it to GitHub and tell the team the numbers are good.";
        // "github" -> "GitHub" is kept; "sales" -> "numbers" is a rewrite, not a spelling.
        assert_eq!(corrections(pasted, field), vec![("github".to_string(), "GitHub".to_string())]);
    }

    #[test]
    fn grammar_is_not_spelling() {
        let pasted = "Wir stellen den Tisch in die Küche von Herrn Schmid.";
        let field = "Wir stellen die Tische in die Küche von Herrn Schmidt.";
        // "Tisch" -> "Tische" is grammar; "Schmid" -> "Schmidt" a name.
        assert_eq!(corrections(pasted, field), vec![("Schmid".to_string(), "Schmidt".to_string())]);
    }

    #[test]
    fn nothing_when_the_dictation_is_gone_or_rewritten() {
        let pasted = "Please send the invoice to Anna by Friday.";
        assert!(corrections(pasted, "Something completely different was typed here instead.").is_empty());
        assert!(corrections(pasted, "").is_empty());
        assert!(corrections(pasted, pasted).is_empty(), "unchanged");
    }

    #[test]
    fn suggestions_are_stored_counted_and_dismissed() {
        let dir = std::env::temp_dir().join("rudariflow_learn");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fix = vec![("Glyfert".to_string(), "Gleifert".to_string())];
        assert_eq!(record(&dir, &fix, &[]), 1);
        assert_eq!(record(&dir, &fix, &[]), 1);
        assert_eq!(suggestions(&dir), vec![Suggestion { word: "Gleifert".into(), heard: "Glyfert".into(), count: 2 }]);
        // Already in the dictionary: not suggested.
        assert_eq!(record(&dir, &[("x".into(), "Yılmaz".into())], &["yılmaz".into()]), 0);
        resolve(&dir, "Gleifert", true);
        assert!(suggestions(&dir).is_empty());
        assert_eq!(record(&dir, &fix, &[]), 0, "dismissed words stay away");
    }
}
