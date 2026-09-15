//! Mouse side buttons as the global hotkey.
//!
//! `RegisterHotKey` (used by tauri-plugin-global-shortcut) only accepts
//! keyboard keys, so side buttons go through a low-level mouse hook
//! (`WH_MOUSE_LL`) on a dedicated thread. The bound button is swallowed so it
//! does not also trigger "Back" / "Forward" in the focused app.
//!
//! Hotkey strings: `Mouse4` (XBUTTON1, usually "Back") and `Mouse5` (XBUTTON2,
//! usually "Forward"), optionally with modifiers, e.g. `CmdOrCtrl+Mouse4`.

use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    /// XBUTTON1, "Back".
    Mouse4,
    /// XBUTTON2, "Forward".
    Mouse5,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Modifiers {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub win: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MouseBinding {
    pub button: MouseButton,
    pub modifiers: Modifiers,
}

/// Parse a hotkey string into a mouse binding. Returns `None` for keyboard
/// hotkeys (and for anything malformed), which keep using the global-shortcut
/// plugin.
pub fn parse(hotkey: &str) -> Option<MouseBinding> {
    let mut button = None;
    let mut modifiers = Modifiers::default();
    for token in hotkey.split('+').map(|t| t.trim().to_ascii_lowercase()) {
        match token.as_str() {
            "mouse4" | "xbutton1" => button = Some(MouseButton::Mouse4),
            "mouse5" | "xbutton2" => button = Some(MouseButton::Mouse5),
            "cmdorctrl" | "commandorcontrol" | "ctrl" | "control" => modifiers.ctrl = true,
            "shift" => modifiers.shift = true,
            "alt" | "option" => modifiers.alt = true,
            "super" | "win" | "meta" | "cmd" | "command" => modifiers.win = true,
            _ => return None,
        }
    }
    button.map(|button| MouseBinding { button, modifiers })
}

/// Handler invoked with `true` on press and `false` on release.
pub type Handler = Box<dyn Fn(bool) + Send + Sync + 'static>;

struct Registration {
    binding: MouseBinding,
    #[cfg(windows)]
    thread_id: u32,
}

static REGISTRATION: Mutex<Option<Registration>> = Mutex::new(None);

pub fn is_registered(binding: MouseBinding) -> bool {
    REGISTRATION
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .is_some_and(|r| r.binding == binding)
}

/// Unregister `binding` if it is the active one. A different active binding
/// is left alone, so switching Mouse4 -> Mouse5 can register the new binding
/// before releasing the old one.
pub fn unregister(binding: MouseBinding) {
    let mut reg = REGISTRATION.lock().unwrap_or_else(|p| p.into_inner());
    if reg.as_ref().is_some_and(|r| r.binding == binding) {
        #[cfg(windows)]
        imp::stop(reg.as_ref().unwrap().thread_id);
        *reg = None;
    }
}

/// Install the hook for `binding`, replacing any previous mouse binding.
pub fn register(binding: MouseBinding, handler: Handler) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut reg = REGISTRATION.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(old) = reg.take() {
            imp::stop(old.thread_id);
        }
        let thread_id = imp::start(binding, handler)?;
        *reg = Some(Registration { binding, thread_id });
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (binding, handler);
        Err("Mouse button hotkeys are only supported on Windows".to_string())
    }
}

#[cfg(windows)]
mod imp {
    use super::{Handler, Modifiers, MouseBinding, MouseButton};
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::mpsc;
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
        TranslateMessage, UnhookWindowsHookEx, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_QUIT,
        WM_XBUTTONDOWN, WM_XBUTTONUP, XBUTTON1, XBUTTON2,
    };

    // The hook procedure has no context pointer, so the active binding lives
    // in statics. Only one mouse hotkey is active at a time.
    static BUTTON: AtomicU8 = AtomicU8::new(0); // 0 none, 1 XBUTTON1, 2 XBUTTON2
    static MODS: AtomicU8 = AtomicU8::new(0);
    /// Whether we reported a press, so the matching release is reported and
    /// swallowed even if modifiers changed in between.
    static PRESSED: AtomicBool = AtomicBool::new(false);
    static EVENTS: Mutex<Option<mpsc::Sender<bool>>> = Mutex::new(None);

    fn mods_to_bits(m: Modifiers) -> u8 {
        (m.ctrl as u8) | (m.shift as u8) << 1 | (m.alt as u8) << 2 | (m.win as u8) << 3
    }

    fn key_down(vk: u16) -> bool {
        unsafe { GetAsyncKeyState(vk as i32) as u16 & 0x8000 != 0 }
    }

    fn current_mods() -> u8 {
        mods_to_bits(Modifiers {
            ctrl: key_down(VK_CONTROL),
            shift: key_down(VK_SHIFT),
            alt: key_down(VK_MENU),
            win: key_down(VK_LWIN) || key_down(VK_RWIN),
        })
    }

    fn send(pressed: bool) {
        if let Some(tx) = EVENTS.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            let _ = tx.send(pressed);
        }
    }

    /// Must return quickly: Windows silently removes low-level hooks that
    /// exceed LowLevelHooksTimeout. All real work happens on the handler thread.
    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && (wparam as u32 == WM_XBUTTONDOWN || wparam as u32 == WM_XBUTTONUP) {
            let info = &*(lparam as *const MSLLHOOKSTRUCT);
            let which = ((info.mouseData >> 16) & 0xFFFF) as u16;
            let button = match which {
                XBUTTON1 => 1,
                XBUTTON2 => 2,
                _ => 0,
            };
            if button != 0 && button == BUTTON.load(Ordering::Relaxed) {
                if wparam as u32 == WM_XBUTTONDOWN {
                    if current_mods() == MODS.load(Ordering::Relaxed) {
                        PRESSED.store(true, Ordering::Relaxed);
                        send(true);
                        return 1; // swallow
                    }
                } else if PRESSED.swap(false, Ordering::Relaxed) {
                    send(false);
                    return 1; // swallow
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    pub fn start(binding: MouseBinding, handler: Handler) -> Result<u32, String> {
        let (tx, rx) = mpsc::channel::<bool>();
        BUTTON.store(
            match binding.button {
                MouseButton::Mouse4 => 1,
                MouseButton::Mouse5 => 2,
            },
            Ordering::Relaxed,
        );
        MODS.store(mods_to_bits(binding.modifiers), Ordering::Relaxed);
        PRESSED.store(false, Ordering::Relaxed);
        *EVENTS.lock().unwrap_or_else(|p| p.into_inner()) = Some(tx);

        // Handler thread: keeps app logic out of the hook procedure. Ends when
        // the sender is dropped by `stop`.
        std::thread::Builder::new()
            .name("rf-mouse-hotkey-handler".into())
            .spawn(move || {
                for pressed in rx {
                    handler(pressed);
                }
            })
            .map_err(|e| e.to_string())?;

        // Hook thread: owns the hook and pumps messages, which low-level hooks
        // require on the installing thread.
        let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
        std::thread::Builder::new()
            .name("rf-mouse-hotkey-hook".into())
            .spawn(move || unsafe {
                let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), std::ptr::null_mut(), 0);
                if hook.is_null() {
                    let _ = ready_tx.send(Err(format!(
                        "SetWindowsHookExW failed: {}",
                        std::io::Error::last_os_error()
                    )));
                    return;
                }
                let _ = ready_tx.send(Ok(GetCurrentThreadId()));
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                UnhookWindowsHookEx(hook);
            })
            .map_err(|e| e.to_string())?;

        match ready_rx.recv() {
            Ok(Ok(thread_id)) => Ok(thread_id),
            Ok(Err(e)) => {
                stop_events();
                Err(e)
            }
            Err(_) => {
                stop_events();
                Err("mouse hook thread exited".to_string())
            }
        }
    }

    fn stop_events() {
        BUTTON.store(0, Ordering::Relaxed);
        PRESSED.store(false, Ordering::Relaxed);
        *EVENTS.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    pub fn stop(thread_id: u32) {
        stop_events();
        unsafe {
            PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_side_buttons() {
        assert_eq!(
            parse("Mouse4"),
            Some(MouseBinding { button: MouseButton::Mouse4, modifiers: Modifiers::default() })
        );
        assert_eq!(parse("mouse5").map(|b| b.button), Some(MouseButton::Mouse5));
    }

    #[test]
    fn parses_modifiers() {
        let b = parse("CmdOrCtrl+Shift+Mouse5").unwrap();
        assert_eq!(b.button, MouseButton::Mouse5);
        assert_eq!(b.modifiers, Modifiers { ctrl: true, shift: true, alt: false, win: false });
    }

    #[test]
    fn keyboard_hotkeys_are_not_mouse_bindings() {
        assert_eq!(parse("CmdOrCtrl+Shift+Space"), None);
        assert_eq!(parse("CmdOrCtrl+Shift"), None);
        assert_eq!(parse(""), None);
    }
}
