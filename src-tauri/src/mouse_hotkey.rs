//! Mouse side buttons as global hotkeys (dictation, paste last, rewrite last).
//!
//! `RegisterHotKey` (used by tauri-plugin-global-shortcut) only accepts
//! keyboard keys, so side buttons go through a low-level mouse hook
//! (`WH_MOUSE_LL`) on a dedicated thread. A bound button is swallowed so it
//! does not also trigger "Back" / "Forward" in the focused app.
//!
//! Hotkey strings: `Mouse4` (XBUTTON1, usually "Back") and `Mouse5` (XBUTTON2,
//! usually "Forward"), optionally with modifiers, e.g. `CmdOrCtrl+Mouse4`.
//! Several bindings can be active, also on one button with different
//! modifiers (`Mouse5` and `Shift+Mouse5`).

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

/// Most bindings at once (three hotkeys use them today).
const SLOTS: usize = 8;

/// A binding as the hook compares it: the button (1 = XBUTTON1, 2 =
/// XBUTTON2) and the modifier bits. 0 is an empty slot.
fn encode(binding: MouseBinding) -> u8 {
    let button = match binding.button {
        MouseButton::Mouse4 => 1,
        MouseButton::Mouse5 => 2,
    };
    0x80 | button << 4 | mods_to_bits(binding.modifiers)
}

fn mods_to_bits(m: Modifiers) -> u8 {
    (m.ctrl as u8) | (m.shift as u8) << 1 | (m.alt as u8) << 2 | (m.win as u8) << 3
}

/// The slot bound to `button` with exactly `mods` held.
fn find_slot(slots: &[u8], button: u8, mods: u8) -> Option<usize> {
    let wanted = 0x80 | button << 4 | mods;
    slots.iter().position(|&s| s == wanted)
}

type Handlers = Vec<Option<(MouseBinding, std::sync::Arc<dyn Fn(bool) + Send + Sync>)>>;

/// The handlers per slot, and the hook thread while any binding is active.
struct State {
    handlers: Handlers,
    #[cfg(windows)]
    hook_thread: Option<u32>,
}

static STATE: Mutex<State> = Mutex::new(State {
    handlers: Vec::new(),
    #[cfg(windows)]
    hook_thread: None,
});

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn is_registered(binding: MouseBinding) -> bool {
    state().handlers.iter().flatten().any(|(b, _)| *b == binding)
}

/// Remove `binding`; the hook stops with the last one.
pub fn unregister(binding: MouseBinding) {
    let mut st = state();
    let Some(slot) = st.handlers.iter().position(|h| h.as_ref().is_some_and(|(b, _)| *b == binding)) else {
        return;
    };
    st.handlers[slot] = None;
    #[cfg(windows)]
    {
        imp::set_slot(slot, 0);
        if st.handlers.iter().all(Option::is_none) {
            if let Some(thread_id) = st.hook_thread.take() {
                imp::stop(thread_id);
            }
        }
    }
}

/// Bind `binding` to `handler` (replacing its old handler), starting the
/// hook with the first binding.
pub fn register(binding: MouseBinding, handler: Handler) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut st = state();
        let slot = match st.handlers.iter().position(|h| h.as_ref().is_some_and(|(b, _)| *b == binding)) {
            Some(slot) => slot,
            None => match st.handlers.iter().position(Option::is_none) {
                Some(free) => free,
                None if st.handlers.len() < SLOTS => {
                    st.handlers.push(None);
                    st.handlers.len() - 1
                }
                None => return Err("too many mouse hotkeys".to_string()),
            },
        };
        if st.hook_thread.is_none() {
            st.hook_thread = Some(imp::start()?);
        }
        st.handlers[slot] = Some((binding, std::sync::Arc::from(handler)));
        imp::set_slot(slot, encode(binding));
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (binding, handler);
        Err("Mouse button hotkeys are only supported on Windows".to_string())
    }
}

/// Run the handler of `slot` (on the handler thread, outside the hook).
#[cfg(windows)]
fn dispatch(slot: usize, pressed: bool) {
    let handler = state().handlers.get(slot).and_then(|h| h.as_ref().map(|(_, f)| f.clone()));
    if let Some(handler) = handler {
        handler(pressed);
    }
}

/// A release followed this soon by a press of the same binding is contact
/// bounce: a worn side button logged release-to-press gaps of 3 to 7 ms,
/// and the bounce press stopped a toggle recording right after it started.
/// People take 60 ms or more between two clicks.
#[cfg_attr(not(windows), allow(dead_code))]
const BOUNCE: std::time::Duration = std::time::Duration::from_millis(40);

/// Pass the hook's events on to `dispatch`, holding each release back for
/// `BOUNCE`: when the same binding is pressed again within it, neither the
/// release nor that press is passed on. Returns when the sender is gone.
#[cfg_attr(not(windows), allow(dead_code))]
fn run_debounced(events: std::sync::mpsc::Receiver<(usize, bool)>, mut dispatch: impl FnMut(usize, bool)) {
    use std::sync::mpsc::RecvTimeoutError;
    let mut next = events.recv().ok();
    while let Some((slot, pressed)) = next.take() {
        if pressed {
            dispatch(slot, true);
            next = events.recv().ok();
            continue;
        }
        match events.recv_timeout(BOUNCE) {
            Ok((s, true)) if s == slot => next = events.recv().ok(),
            Ok(other) => {
                dispatch(slot, false);
                next = Some(other);
            }
            Err(RecvTimeoutError::Timeout) => {
                dispatch(slot, false);
                next = events.recv().ok();
            }
            Err(RecvTimeoutError::Disconnected) => dispatch(slot, false),
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::{find_slot, mods_to_bits, Modifiers, SLOTS};
    use std::sync::atomic::{AtomicU8, Ordering};
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

    // The hook procedure has no context pointer, so the bindings live in
    // statics it can read without locking.
    static BINDINGS: [AtomicU8; SLOTS] = [const { AtomicU8::new(0) }; SLOTS];
    /// Per button (index 1 and 2): the slot + 1 whose press was reported, so
    /// the release goes to the same binding and is swallowed even if the
    /// modifiers changed in between.
    static PRESSED: [AtomicU8; 3] = [const { AtomicU8::new(0) }; 3];
    static EVENTS: Mutex<Option<mpsc::Sender<(usize, bool)>>> = Mutex::new(None);

    pub fn set_slot(slot: usize, code: u8) {
        BINDINGS[slot].store(code, Ordering::Relaxed);
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

    fn send(slot: usize, pressed: bool) {
        if let Some(tx) = EVENTS.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            let _ = tx.send((slot, pressed));
        }
    }

    /// Must return quickly: Windows silently removes low-level hooks that
    /// exceed LowLevelHooksTimeout. All real work happens on the handler thread.
    unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && (wparam as u32 == WM_XBUTTONDOWN || wparam as u32 == WM_XBUTTONUP) {
            let info = &*(lparam as *const MSLLHOOKSTRUCT);
            let button: u8 = match ((info.mouseData >> 16) & 0xFFFF) as u16 {
                XBUTTON1 => 1,
                XBUTTON2 => 2,
                _ => 0,
            };
            if button != 0 {
                let pressed = &PRESSED[button as usize];
                if wparam as u32 == WM_XBUTTONDOWN {
                    let slots: [u8; SLOTS] = std::array::from_fn(|i| BINDINGS[i].load(Ordering::Relaxed));
                    if let Some(slot) = find_slot(&slots, button, current_mods()) {
                        pressed.store(slot as u8 + 1, Ordering::Relaxed);
                        send(slot, true);
                        return 1; // swallow
                    }
                } else {
                    let slot = pressed.swap(0, Ordering::Relaxed);
                    if slot != 0 {
                        send(slot as usize - 1, false);
                        return 1; // swallow
                    }
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }

    /// Start the hook and its handler thread; returns the hook thread's id.
    pub fn start() -> Result<u32, String> {
        let (tx, rx) = mpsc::channel::<(usize, bool)>();
        for p in &PRESSED {
            p.store(0, Ordering::Relaxed);
        }
        *EVENTS.lock().unwrap_or_else(|p| p.into_inner()) = Some(tx);

        // Handler thread: keeps app logic out of the hook procedure. Ends when
        // the sender is dropped by `stop`.
        std::thread::Builder::new()
            .name("rf-mouse-hotkey-handler".into())
            .spawn(move || super::run_debounced(rx, super::dispatch))
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
        for p in &PRESSED {
            p.store(0, Ordering::Relaxed);
        }
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

    #[test]
    fn contact_bounce_is_dropped() {
        use std::sync::mpsc;
        use std::time::Duration;
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut got = Vec::new();
            run_debounced(rx, |slot, pressed| got.push((slot, pressed)));
            got
        });
        // Click, bounce 5 ms after the release, bounce release.
        tx.send((0, true)).unwrap();
        tx.send((0, false)).unwrap();
        std::thread::sleep(Duration::from_millis(5));
        tx.send((0, true)).unwrap();
        tx.send((0, false)).unwrap();
        std::thread::sleep(BOUNCE * 3);
        // Two real clicks 150 ms apart, then a press of another binding
        // right after a release.
        tx.send((0, true)).unwrap();
        tx.send((0, false)).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        tx.send((0, true)).unwrap();
        tx.send((0, false)).unwrap();
        tx.send((1, true)).unwrap();
        drop(tx);
        let got = worker.join().unwrap();
        assert_eq!(got, [(0, true), (0, false), (0, true), (0, false), (0, true), (0, false), (1, true)]);
    }

    #[test]
    fn one_button_serves_several_hotkeys_by_modifiers() {
        let dictation = encode(parse("Mouse5").unwrap());
        let rewrite = encode(parse("Shift+Mouse5").unwrap());
        let paste = encode(parse("Mouse4").unwrap());
        let slots = [dictation, 0, rewrite, paste, 0, 0, 0, 0];
        let shift = mods_to_bits(Modifiers { shift: true, ..Default::default() });
        assert_eq!(find_slot(&slots, 2, 0), Some(0));
        assert_eq!(find_slot(&slots, 2, shift), Some(2));
        assert_eq!(find_slot(&slots, 1, 0), Some(3));
        // Ctrl+Mouse5 is bound to nothing: the click goes to the app.
        let ctrl = mods_to_bits(Modifiers { ctrl: true, ..Default::default() });
        assert_eq!(find_slot(&slots, 2, ctrl), None);
        assert_eq!(find_slot(&[0; 8], 1, 0), None);
    }
}
