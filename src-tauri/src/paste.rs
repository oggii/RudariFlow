/// Put text on the clipboard without adding it to Windows' clipboard history
/// (Win+V) or syncing it to other devices. The clipboard only carries the
/// text for the paste keystroke; the user never copied it.
fn set_clipboard_text(cb: &mut arboard::Clipboard, text: &str) -> Result<(), arboard::Error> {
    #[cfg(windows)]
    {
        use arboard::SetExtWindows;
        cb.set().exclude_from_history().exclude_from_cloud().text(text)
    }
    #[cfg(not(windows))]
    {
        cb.set_text(text)
    }
}

/// Restore the clipboard to a previous text value.
/// Best-effort — silently swallows errors. If `prev` is None, leaves the
/// current clipboard alone (we have nothing better to put back).
pub(crate) fn restore_clipboard(prev: Option<String>) {
    if let Some(text) = prev {
        if let Ok(mut cb) = arboard::Clipboard::new() {
            // Already in the history from when the user copied it.
            let _ = set_clipboard_text(&mut cb, &text);
        }
    }
}

/// Wait until Ctrl, Shift, Alt and Win are released, at most `timeout`.
/// A hotkey chord that is still held would otherwise turn the simulated
/// Ctrl+V into Ctrl+Shift+V, or Enter into Shift+Enter.
fn wait_for_modifiers_released(timeout: std::time::Duration) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
        };
        let held = || {
            [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN]
                .iter()
                .any(|&vk| unsafe { GetAsyncKeyState(vk as i32) as u16 & 0x8000 != 0 })
        };
        let start = std::time::Instant::now();
        while held() && start.elapsed() < timeout {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    #[cfg(not(windows))]
    let _ = timeout;
}

const MODIFIER_WAIT: std::time::Duration = std::time::Duration::from_millis(1500);

pub fn paste_text(text: &str) -> Result<(), String> {
    wait_for_modifiers_released(MODIFIER_WAIT);

    // Capture whatever the user had in the clipboard so we can put it back
    // after our paste. If they had non-text content (image, files, HTML),
    // get_text() errors and we treat that as "nothing to restore".
    let previous: Option<String> = match arboard::Clipboard::new() {
        Ok(mut cb) => cb.get_text().ok(),
        Err(_) => None,
    };

    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    set_clipboard_text(&mut clipboard, text).map_err(|e| e.to_string())?;

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

/// Submit what was just pasted: `"enter"` or `"ctrl+enter"`.
pub fn press_submit(key: &str) -> Result<(), String> {
    wait_for_modifiers_released(MODIFIER_WAIT);
    // Let the target app finish handling the paste first.
    std::thread::sleep(std::time::Duration::from_millis(60));

    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    let ctrl = key == "ctrl+enter";
    if ctrl {
        enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
    }
    let result = enigo.key(Key::Return, Direction::Click).map_err(|e| e.to_string());
    if ctrl {
        enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
    }
    result
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// The tests share the system clipboard, so they must not run in parallel.
    static CLIPBOARD: Mutex<()> = Mutex::new(());

    #[test]
    fn restore_clipboard_some_writes_back() {
        let _guard = CLIPBOARD.lock().unwrap_or_else(|p| p.into_inner());
        let mut cb = arboard::Clipboard::new().expect("clipboard available");
        let _ = cb.set_text("our_paste_text");
        assert_eq!(cb.get_text().unwrap_or_default(), "our_paste_text");

        restore_clipboard(Some("ORIGINAL".to_string()));

        let after = arboard::Clipboard::new().unwrap().get_text().unwrap_or_default();
        assert_eq!(after, "ORIGINAL");
    }

    #[test]
    fn restore_clipboard_none_is_noop() {
        let _guard = CLIPBOARD.lock().unwrap_or_else(|p| p.into_inner());
        let mut cb = arboard::Clipboard::new().expect("clipboard available");
        let _ = cb.set_text("kept");

        restore_clipboard(None);

        let after = arboard::Clipboard::new().unwrap().get_text().unwrap_or_default();
        assert_eq!(after, "kept");
    }
}
