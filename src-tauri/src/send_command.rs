//! "Send it" voice command: a dictation that ends with a submit phrase gets
//! the phrase removed and Enter pressed after the paste.
//!
//! The phrase only counts as its own sentence ("Hello there. Send it."), so
//! ordinary sentences that happen to end with it ("I'll send it.", "Ich muss
//! den Brief abschicken.") are pasted as dictated. A missed command costs one
//! manual Enter; a false one sends a half-written message.

/// Submit phrases, longest first so "send it" wins over "send".
const PHRASES: &[&str] = &[
    "send the message",
    "schick es ab",
    "send message",
    "abschicken",
    "send this",
    "schick ab",
    "absenden",
    "send it",
    "senden",
    "send",
];

const SENTENCE_END: &[char] = &['.', '!', '?', '…', '。', '！', '？'];

/// If `text` ends with a submit phrase spoken as its own sentence, return the
/// text before it (possibly empty). Otherwise `None`.
pub fn strip_send_command(text: &str) -> Option<String> {
    let core = text.trim_end_matches(|c: char| c.is_whitespace() || SENTENCE_END.contains(&c));

    for phrase in PHRASES {
        let n = phrase.chars().count();
        let Some((start, _)) = core.char_indices().rev().nth(n - 1) else {
            continue;
        };
        if core[start..].to_lowercase() != *phrase {
            continue;
        }
        let before = core[..start].trim_end();
        if before.is_empty() || before.ends_with(SENTENCE_END) {
            return Some(before.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_trailing_sentence() {
        assert_eq!(strip_send_command("Hello there. Send it."), Some("Hello there.".into()));
        assert_eq!(strip_send_command("Bin gleich da! Abschicken."), Some("Bin gleich da!".into()));
        assert_eq!(strip_send_command("Are you coming? Send."), Some("Are you coming?".into()));
        assert_eq!(strip_send_command("Okay. Schick es ab!"), Some("Okay.".into()));
    }

    #[test]
    fn phrase_alone_leaves_empty_text() {
        assert_eq!(strip_send_command("Send it."), Some(String::new()));
        assert_eq!(strip_send_command("  send it  "), Some(String::new()));
        assert_eq!(strip_send_command("Absenden"), Some(String::new()));
    }

    #[test]
    fn ignores_phrase_inside_a_sentence() {
        assert_eq!(strip_send_command("I'll send it."), None);
        assert_eq!(strip_send_command("If it's ready, send it."), None);
        assert_eq!(strip_send_command("Ich muss den Brief noch abschicken."), None);
        assert_eq!(strip_send_command("Please resend it."), None);
    }

    #[test]
    fn ignores_text_without_phrase() {
        assert_eq!(strip_send_command("Hello there."), None);
        assert_eq!(strip_send_command(""), None);
        assert_eq!(strip_send_command("Sent."), None);
    }

    #[test]
    fn handles_multibyte_text_before_phrase() {
        assert_eq!(strip_send_command("Grüße aus Zürich. Senden."), Some("Grüße aus Zürich.".into()));
        assert_eq!(strip_send_command("日本語です。 Send it."), Some("日本語です。".into()));
    }
}
