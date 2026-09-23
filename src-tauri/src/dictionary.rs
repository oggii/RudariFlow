//! The user's dictionary: names, brands and jargon. Stored as the
//! comma-separated `customPrompt` setting, which Whisper gets as its initial
//! prompt; here the entries also fix the spelling of the transcript
//! ("github", "git hub" -> "GitHub"; "Grüß'n shop" -> "Grüssen-Shop") and
//! are handed to the AI cleanup model.

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

/// Fold text for comparison: lower case, ß as ss, accents and umlauts on
/// their base letter, only letters and digits.
fn fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars().flat_map(char::to_lowercase) {
        match c {
            'ß' => out.push_str("ss"),
            'ä' | 'à' | 'á' | 'â' | 'ã' | 'å' => out.push('a'),
            'ö' | 'ò' | 'ó' | 'ô' | 'õ' => out.push('o'),
            'ü' | 'ù' | 'ú' | 'û' => out.push('u'),
            'é' | 'è' | 'ê' | 'ë' => out.push('e'),
            'í' | 'ì' | 'î' | 'ï' => out.push('i'),
            'ç' => out.push('c'),
            'ñ' => out.push('n'),
            c if c.is_alphanumeric() => out.push(c),
            _ => {}
        }
    }
    out
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != *cb);
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Letters that may differ between a transcript span and an entry: none for
/// short entries (so "polar" never becomes "Polars"), one from 8 folded
/// characters, two from 12.
fn allowed_typos(folded_entry_len: usize) -> usize {
    match folded_entry_len {
        0..=7 => 0,
        8..=11 => 1,
        _ => 2,
    }
}

struct Match {
    start: usize,
    end: usize,
    tokens: usize,
    exact: bool,
    term: usize,
}

/// Write dictionary entries the way they are stored wherever the transcript
/// has them in another form: other case, spaces, hyphens or apostrophes,
/// ß/ss, or, for longer entries, a letter or two off. Word forms that only
/// add or drop an ending ("Heinrichs" for "Heinrich") are left alone.
pub fn apply_spelling(text: &str, terms: &[String]) -> String {
    // Words with their byte spans, punctuation around them excluded.
    let mut words: Vec<(usize, usize)> = Vec::new();
    let mut pos = 0;
    for token in text.split_whitespace() {
        let start = pos + text[pos..].find(token).unwrap_or(0);
        pos = start + token.len();
        let lead = token.len() - token.trim_start_matches(|c: char| !c.is_alphanumeric()).len();
        let core = token.trim_matches(|c: char| !c.is_alphanumeric());
        if !core.is_empty() {
            words.push((start + lead, start + lead + core.len()));
        }
    }

    let mut found: Vec<Match> = Vec::new();
    for (index, term) in terms.iter().enumerate() {
        let folded_term = fold(term);
        if folded_term.is_empty() {
            continue;
        }
        let term_words = term.split_whitespace().count().max(1);
        let typos = allowed_typos(folded_term.chars().count());
        for len in term_words.saturating_sub(1).max(1)..=term_words + 1 {
            for first in 0..words.len().saturating_sub(len - 1) {
                let (start, end) = (words[first].0, words[first + len - 1].1);
                let span = fold(&text[start..end]);
                let exact = span == folded_term;
                let near = !exact
                    && typos > 0
                    && !span.starts_with(&folded_term)
                    && !folded_term.starts_with(&span)
                    && levenshtein(&span, &folded_term) <= typos;
                if exact || near {
                    found.push(Match { start, end, tokens: len, exact, term: index });
                }
            }
        }
    }

    // Leftmost first; at the same place prefer exact, then longer matches.
    found.sort_by(|a, b| a.start.cmp(&b.start).then(b.exact.cmp(&a.exact)).then(b.tokens.cmp(&a.tokens)));
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for m in found {
        if m.start < cursor {
            continue;
        }
        out.push_str(&text[cursor..m.start]);
        out.push_str(&terms[m.term]);
        cursor = m.end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// Swiss spelling: no ß.
pub fn swiss_spelling(text: &str) -> String {
    text.replace('ß', "ss").replace('ẞ', "SS")
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
    fn fixes_case_spacing_and_punctuation() {
        let dict = t(&["GitHub", "oggi", "whisper.cpp", "Finn Brown", "RX 6800"]);
        assert_eq!(
            apply_spelling("Push it to github and ask Oggi about Whisper.CPP.", &dict),
            "Push it to GitHub and ask oggi about whisper.cpp."
        );
        assert_eq!(apply_spelling("Call finn  brown about the rx 6800.", &dict), "Call Finn Brown about the RX 6800.");
        assert_eq!(apply_spelling("It is on git hub, (github).", &dict), "It is on GitHub, (GitHub).");
    }

    #[test]
    fn matches_the_shop_name_however_whisper_writes_it() {
        let dict = t(&["Grüssen-Shop"]);
        for heard in ["Grüß'n shop", "Grüßen Shop", "grüssen shop", "Grüssen-Shop", "GRÜSSENSHOP"] {
            assert_eq!(
                apply_spelling(&format!("I am testing this now. {}.", heard), &dict),
                "I am testing this now. Grüssen-Shop.",
                "heard as {:?}",
                heard
            );
        }
    }

    #[test]
    fn leaves_other_words_alone() {
        let dict = t(&["Polars", "cat", "Heinrich", "Kubernetes"]);
        assert_eq!(apply_spelling("The polar bear sat on the category.", &dict), "The polar bear sat on the category.");
        assert_eq!(apply_spelling("CAT and polars.", &dict), "cat and Polars.");
        assert_eq!(apply_spelling("Heinrichs Auto steht da.", &dict), "Heinrichs Auto steht da.");
        assert_eq!(apply_spelling("We run kubernetis in prod.", &dict), "We run Kubernetes in prod.");
        assert_eq!(apply_spelling("", &dict), "");
    }

    #[test]
    fn swiss_spelling_drops_eszett() {
        assert_eq!(swiss_spelling("Grüße, ich weiß es. STRAẞE"), "Grüsse, ich weiss es. STRASSE");
    }
}
