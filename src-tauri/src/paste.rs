/// Restore the clipboard to a previous text value.
/// Best-effort — silently swallows errors. If `prev` is None, leaves the
/// current clipboard alone (we have nothing better to put back).
pub(crate) fn restore_clipboard(prev: Option<String>) {
    if let Some(text) = prev {
        if let Ok(mut cb) = arboard::Clipboard::new() {
            let _ = cb.set_text(text);
        }
    }
}

pub fn paste_text(text: &str) -> Result<(), String> {
    // Capture whatever the user had in the clipboard so we can put it back
    // after our paste. If they had non-text content (image, files, HTML),
    // get_text() errors and we treat that as "nothing to restore".
    let previous: Option<String> = match arboard::Clipboard::new() {
        Ok(mut cb) => cb.get_text().ok(),
        Err(_) => None,
    };

    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())?;

    // Small delay to ensure clipboard is set before the paste keystroke.
    std::thread::sleep(std::time::Duration::from_millis(50));

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("osascript")
            .args(["-e", r#"tell application "System Events" to keystroke "v" using command down"#])
            .output()
            .map_err(|e| format!("Failed to simulate paste: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        use enigo::{Enigo, Keyboard, Settings, Key, Direction};
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
        enigo.key(Key::Unicode('v'), Direction::Click).map_err(|e| e.to_string())?;
        enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
    }

    // Give the target app time to actually consume the paste before we
    // overwrite the clipboard with the previous content.
    std::thread::sleep(std::time::Duration::from_millis(100));
    restore_clipboard(previous);

    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn restore_clipboard_some_writes_back() {
        let mut cb = arboard::Clipboard::new().expect("clipboard available");
        let _ = cb.set_text("our_paste_text");
        assert_eq!(cb.get_text().unwrap_or_default(), "our_paste_text");

        restore_clipboard(Some("ORIGINAL".to_string()));

        let after = arboard::Clipboard::new().unwrap().get_text().unwrap_or_default();
        assert_eq!(after, "ORIGINAL");
    }

    #[test]
    fn restore_clipboard_none_is_noop() {
        let mut cb = arboard::Clipboard::new().expect("clipboard available");
        let _ = cb.set_text("kept");

        restore_clipboard(None);

        let after = arboard::Clipboard::new().unwrap().get_text().unwrap_or_default();
        assert_eq!(after, "kept");
    }
}
