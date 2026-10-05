//! Free GPU for games (Engine tab, off by default): an app that covers a
//! whole monitor (fullscreen or borderless) in the foreground for a few
//! seconds frees the GPU like the Free GPU hotkey; once no such app has been
//! in the foreground for half a minute, the models load again.
//!
//! `GameWatch` decides from what main.rs observes about once a second
//! (`observe`); `foreground_game` reads the foreground window on Windows.

use std::time::{Duration, Instant};

/// A fullscreen app in the foreground this long frees the GPU.
pub const FREE_AFTER: Duration = Duration::from_secs(5);
/// No fullscreen app in the foreground this long loads the models again.
pub const LOAD_AFTER: Duration = Duration::from_secs(30);

/// What the watcher saw in the foreground at one look.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Observation {
    /// The program of the fullscreen app in the foreground (as
    /// `foreground_app::exe_name`, "?" when unknown); `None` when the
    /// foreground is no game.
    pub game: Option<String>,
}

impl Observation {
    pub fn game(exe: &str) -> Self {
        Self { game: Some(exe.to_string()) }
    }

    pub fn none() -> Self {
        Self { game: None }
    }
}

/// What the watcher asks main.rs to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Free Whisper and the AI like the Free GPU hotkey.
    FreeNow,
    /// The game is over: load them again.
    LoadAgain,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    /// No game in the foreground.
    Idle,
    /// `game` has been in the foreground since `since`, not yet long enough.
    Seen { game: String, since: Instant },
    /// Freed for a game; `last_seen` is the last look a game was in front.
    Freed { game: String, last_seen: Instant },
    /// The user loaded the models with the hotkey while `game` ran: no free
    /// for it until it has been gone for `LOAD_AFTER`.
    Suspended { game: String, last_seen: Instant },
}

/// The decision part of the watcher: fed with observations and the time,
/// it says when to free and when to load again.
#[derive(Debug, Clone)]
pub struct GameWatch {
    phase: Phase,
}

impl Default for GameWatch {
    fn default() -> Self {
        Self::new()
    }
}

impl GameWatch {
    pub fn new() -> Self {
        Self { phase: Phase::Idle }
    }

    /// One look at the foreground at `now`.
    pub fn observe(&mut self, seen: &Observation, now: Instant) -> Option<Action> {
        let phase = std::mem::replace(&mut self.phase, Phase::Idle);
        let (next, action) = match (phase, &seen.game) {
            (Phase::Idle, None) => (Phase::Idle, None),
            (Phase::Idle, Some(game)) => (Phase::Seen { game: game.clone(), since: now }, None),
            (Phase::Seen { .. }, None) => (Phase::Idle, None),
            (Phase::Seen { game, since }, Some(now_game)) if *now_game == game => {
                if now.saturating_duration_since(since) >= FREE_AFTER {
                    (Phase::Freed { game, last_seen: now }, Some(Action::FreeNow))
                } else {
                    (Phase::Seen { game, since }, None)
                }
            }
            // Another app came to the front: its own seconds count.
            (Phase::Seen { .. }, Some(other)) => (Phase::Seen { game: other.clone(), since: now }, None),
            (Phase::Freed { .. }, Some(game)) => (Phase::Freed { game: game.clone(), last_seen: now }, None),
            (Phase::Freed { game, last_seen }, None) => {
                if now.saturating_duration_since(last_seen) >= LOAD_AFTER {
                    (Phase::Idle, Some(Action::LoadAgain))
                } else {
                    (Phase::Freed { game, last_seen }, None)
                }
            }
            (Phase::Suspended { game, .. }, Some(now_game)) if *now_game == game => {
                (Phase::Suspended { game, last_seen: now }, None)
            }
            // A different game: it is not the one the user loaded for.
            (Phase::Suspended { .. }, Some(other)) => (Phase::Seen { game: other.clone(), since: now }, None),
            (Phase::Suspended { game, last_seen }, None) => {
                if now.saturating_duration_since(last_seen) >= LOAD_AFTER {
                    (Phase::Idle, None)
                } else {
                    (Phase::Suspended { game, last_seen }, None)
                }
            }
        };
        self.phase = next;
        action
    }

    /// The Free GPU hotkey loaded the models at `now`. While a game is in
    /// the foreground or was freed for, the automatic free waits until that
    /// game has been gone for `LOAD_AFTER`.
    pub fn user_loaded(&mut self, now: Instant) {
        self.phase = match std::mem::replace(&mut self.phase, Phase::Idle) {
            Phase::Idle => Phase::Idle,
            Phase::Seen { game, .. } => Phase::Suspended { game, last_seen: now },
            Phase::Freed { game, last_seen } | Phase::Suspended { game, last_seen } => {
                Phase::Suspended { game, last_seen }
            }
        };
    }

    /// The switch went off: forget everything.
    pub fn reset(&mut self) {
        self.phase = Phase::Idle;
    }

    /// Freed for a game and waiting for it to end.
    pub fn freed(&self) -> bool {
        matches!(self.phase, Phase::Freed { .. })
    }

    /// The user loaded during a game; no free until it ends.
    pub fn suspended(&self) -> bool {
        matches!(self.phase, Phase::Suspended { .. })
    }
}

/// A window rectangle in screen pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// What the watcher reads about the foreground window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub visible: bool,
    pub minimized: bool,
    /// Maximised with a title bar: an ordinary window (with an auto-hidden
    /// taskbar it covers the monitor too).
    pub maximized_with_caption: bool,
    /// Window class, e.g. "Progman" for the desktop.
    pub class: String,
    pub pid: u32,
    /// As `foreground_app::exe_name`; empty when unknown.
    pub exe: String,
    pub rect: Rect,
    /// The monitor the window is on (most of it).
    pub monitor: Rect,
}

/// Browsers: a video in fullscreen is no game.
const BROWSERS: &[&str] = &[
    "chrome", "msedge", "firefox", "brave", "opera", "opera_gx", "vivaldi", "arc", "iexplore", "chromium",
    "waterfox", "librewolf", "floorp", "zen", "thorium", "browser", "yandex", "seamonkey", "palemoon",
];

/// Windows' own fullscreen surfaces: the desktop, task view, the lock
/// screen, the start menu and search.
const SHELL_EXES: &[&str] = &[
    "explorer",
    "lockapp",
    "searchhost",
    "searchapp",
    "startmenuexperiencehost",
    "shellexperiencehost",
    "textinputhost",
    "logonui",
];

/// Window classes of the desktop and the taskbar.
const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

pub fn is_browser(exe: &str) -> bool {
    BROWSERS.contains(&exe)
}

/// The window covers its whole monitor (fullscreen or borderless).
pub fn covers_monitor(window: Rect, monitor: Rect) -> bool {
    monitor.right > monitor.left
        && monitor.bottom > monitor.top
        && window.left <= monitor.left
        && window.top <= monitor.top
        && window.right >= monitor.right
        && window.bottom >= monitor.bottom
}

/// The game in this foreground window, if it is one: visible, not
/// minimised, covering its monitor, and none of RudariFlow's own windows
/// (`own_pid`), the shell, a screen saver or a browser.
pub fn game_in(window: &WindowInfo, own_pid: u32) -> Option<String> {
    if !window.visible || window.minimized || window.maximized_with_caption {
        return None;
    }
    if window.pid == own_pid || SHELL_CLASSES.contains(&window.class.as_str()) {
        return None;
    }
    let exe = window.exe.as_str();
    if SHELL_EXES.contains(&exe) || exe.ends_with(".scr") || is_browser(exe) {
        return None;
    }
    if !covers_monitor(window.rect, window.monitor) {
        return None;
    }
    Some(if exe.is_empty() { "?".to_string() } else { exe.to_string() })
}

/// What is in the foreground right now.
pub fn foreground_game() -> Observation {
    Observation { game: imp::foreground_window().and_then(|w| game_in(&w, std::process::id())) }
}

#[cfg(windows)]
mod imp {
    use super::{Rect, WindowInfo};
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsIconic,
        IsWindowVisible, IsZoomed, GWL_STYLE, WS_CAPTION,
    };

    fn rect(r: RECT) -> Rect {
        Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    }

    pub fn foreground_window() -> Option<WindowInfo> {
        // SAFETY: plain Win32 queries on the foreground window handle; the
        // buffers and structs are owned here and sized for the calls.
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return None;
            }
            let mut window = std::mem::zeroed::<RECT>();
            if GetWindowRect(hwnd, &mut window) == 0 {
                return None;
            }
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut info = std::mem::zeroed::<MONITORINFO>();
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if monitor.is_null() || GetMonitorInfoW(monitor, &mut info) == 0 {
                return None;
            }
            let mut class = [0u16; 128];
            let len = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            Some(WindowInfo {
                visible: IsWindowVisible(hwnd) != 0,
                minimized: IsIconic(hwnd) != 0,
                maximized_with_caption: IsZoomed(hwnd) != 0 && style & WS_CAPTION == WS_CAPTION,
                class: String::from_utf16_lossy(&class[..len.max(0) as usize]),
                pid,
                exe: crate::foreground_app::process_name(pid),
                rect: rect(window),
                monitor: rect(info.rcMonitor),
            })
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn foreground_window() -> Option<super::WindowInfo> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    /// Feeds `seen` once a second from `start + from` to `start + to`
    /// (inclusive) and returns the actions with their second.
    fn run(watch: &mut GameWatch, start: Instant, from: u64, to: u64, seen: &Observation) -> Vec<(u64, Action)> {
        (from..=to).filter_map(|s| watch.observe(seen, start + secs(s)).map(|a| (s, a))).collect()
    }

    #[test]
    fn a_game_in_front_for_five_seconds_frees_once() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        let actions = run(&mut watch, start, 0, 20, &Observation::game("eldenring"));
        assert_eq!(actions, vec![(5, Action::FreeNow)], "after 5 s, and only once");
        assert!(watch.freed());
    }

    #[test]
    fn a_short_fullscreen_moment_frees_nothing() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        assert!(run(&mut watch, start, 0, 4, &Observation::game("vlc")).is_empty());
        // Back to the desktop before the 5 s were up: the count starts over.
        assert!(run(&mut watch, start, 5, 5, &Observation::none()).is_empty());
        assert!(run(&mut watch, start, 6, 10, &Observation::game("vlc")).is_empty());
        assert_eq!(run(&mut watch, start, 11, 11, &Observation::game("vlc")), vec![(11, Action::FreeNow)]);
    }

    #[test]
    fn switching_between_fullscreen_apps_restarts_the_count() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        assert!(run(&mut watch, start, 0, 3, &Observation::game("launcher")).is_empty());
        assert!(run(&mut watch, start, 4, 8, &Observation::game("game")).is_empty());
        assert_eq!(run(&mut watch, start, 9, 9, &Observation::game("game")), vec![(9, Action::FreeNow)]);
    }

    #[test]
    fn the_models_load_again_thirty_seconds_after_the_game() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 100, &Observation::game("game"));
        let actions = run(&mut watch, start, 101, 200, &Observation::none());
        assert_eq!(actions, vec![(130, Action::LoadAgain)], "30 s after the last look at the game");
        assert!(!watch.freed());
    }

    #[test]
    fn alt_tab_for_less_than_thirty_seconds_keeps_the_gpu_free() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &Observation::game("game"));
        assert!(run(&mut watch, start, 11, 39, &Observation::none()).is_empty(), "Discord for 29 s");
        assert!(run(&mut watch, start, 40, 50, &Observation::game("game")).is_empty(), "no second free");
        assert!(watch.freed());
        assert_eq!(run(&mut watch, start, 51, 81, &Observation::none()), vec![(80, Action::LoadAgain)]);
    }

    #[test]
    fn another_game_after_the_first_keeps_the_gpu_free() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &Observation::game("game"));
        assert!(run(&mut watch, start, 11, 60, &Observation::game("other")).is_empty());
        assert!(watch.freed());
    }

    #[test]
    fn loading_with_the_hotkey_during_the_game_suspends_until_it_is_gone() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &Observation::game("game"));
        watch.user_loaded(start + secs(10));
        assert!(watch.suspended());
        assert!(run(&mut watch, start, 11, 100, &Observation::game("game")).is_empty(), "no free, no load");
        // Alt-tab out for 20 s and back: still the same game, still suspended.
        assert!(run(&mut watch, start, 101, 120, &Observation::none()).is_empty());
        assert!(run(&mut watch, start, 121, 130, &Observation::game("game")).is_empty());
        assert!(watch.suspended());
        // Gone for 30 s: nothing to load (the user did), and the next game frees again.
        assert!(run(&mut watch, start, 131, 170, &Observation::none()).is_empty());
        assert!(!watch.suspended());
        assert_eq!(run(&mut watch, start, 171, 180, &Observation::game("game")), vec![(176, Action::FreeNow)]);
    }

    #[test]
    fn loading_while_a_game_is_being_counted_suspends_too() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 2, &Observation::game("game"));
        watch.user_loaded(start + secs(2));
        assert!(run(&mut watch, start, 3, 60, &Observation::game("game")).is_empty());
    }

    #[test]
    fn a_different_game_ends_the_suspension() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &Observation::game("game"));
        watch.user_loaded(start + secs(10));
        assert_eq!(run(&mut watch, start, 11, 20, &Observation::game("other")), vec![(16, Action::FreeNow)]);
    }

    #[test]
    fn loading_after_the_game_while_waiting_to_reload_loads_nothing_twice() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &Observation::game("game"));
        run(&mut watch, start, 11, 20, &Observation::none());
        watch.user_loaded(start + secs(20));
        assert!(run(&mut watch, start, 21, 100, &Observation::none()).is_empty(), "the hotkey already loaded");
    }

    #[test]
    fn a_hotkey_load_with_no_game_changes_nothing() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        watch.user_loaded(start);
        assert!(!watch.suspended());
        assert_eq!(run(&mut watch, start, 1, 6, &Observation::game("game")), vec![(6, Action::FreeNow)]);
    }

    #[test]
    fn reset_forgets_a_free() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &Observation::game("game"));
        watch.reset();
        assert!(!watch.freed());
        assert!(run(&mut watch, start, 11, 100, &Observation::none()).is_empty());
    }

    #[test]
    fn a_long_pause_between_looks_counts_as_time() {
        // The watcher thread can be held up (a free waits for a dictation).
        let start = Instant::now();
        let mut watch = GameWatch::new();
        assert_eq!(watch.observe(&Observation::game("game"), start), None);
        assert_eq!(watch.observe(&Observation::game("game"), start + secs(9)), Some(Action::FreeNow));
        assert_eq!(watch.observe(&Observation::none(), start + secs(10)), None);
        assert_eq!(watch.observe(&Observation::none(), start + secs(60)), Some(Action::LoadAgain));
    }

    fn monitor() -> Rect {
        Rect { left: 0, top: 0, right: 2560, bottom: 1440 }
    }

    fn game_window() -> WindowInfo {
        WindowInfo {
            visible: true,
            minimized: false,
            maximized_with_caption: false,
            class: "UnrealWindow".to_string(),
            pid: 4242,
            exe: "fortniteclient-win64-shipping".to_string(),
            rect: monitor(),
            monitor: monitor(),
        }
    }

    #[test]
    fn a_window_covering_its_monitor_is_a_game() {
        assert_eq!(game_in(&game_window(), 1), Some("fortniteclient-win64-shipping".to_string()));
        // Exclusive fullscreen and borderless windows often reach past the edges.
        let mut bigger = game_window();
        bigger.rect = Rect { left: -8, top: -8, right: 2568, bottom: 1448 };
        assert!(game_in(&bigger, 1).is_some());
        // An unknown program (no access to its name) still counts.
        let mut unknown = game_window();
        unknown.exe = String::new();
        assert_eq!(game_in(&unknown, 1), Some("?".to_string()));
    }

    #[test]
    fn a_game_on_the_second_monitor_is_measured_against_that_monitor() {
        let mut w = game_window();
        w.monitor = Rect { left: 2560, top: -200, right: 4480, bottom: 880 };
        w.rect = w.monitor;
        assert!(game_in(&w, 1).is_some());
        // The same window measured against the first monitor would not cover it.
        w.rect = Rect { left: 2560, top: -200, right: 4480, bottom: 880 };
        w.monitor = monitor();
        assert!(game_in(&w, 1).is_none());
    }

    #[test]
    fn windows_that_are_no_games() {
        let check = |change: &dyn Fn(&mut WindowInfo), why: &str| {
            let mut w = game_window();
            change(&mut w);
            assert_eq!(game_in(&w, 1), None, "{}", why);
        };
        check(&|w| w.rect = Rect { left: 0, top: 0, right: 2560, bottom: 1392 }, "a window above the taskbar");
        check(&|w| w.rect = Rect { left: 100, top: 100, right: 1200, bottom: 900 }, "a small window");
        check(&|w| w.maximized_with_caption = true, "a maximised window with an auto-hidden taskbar");
        check(&|w| w.visible = false, "invisible");
        check(&|w| w.minimized = true, "minimised");
        check(&|w| w.pid = 1, "RudariFlow's own window");
        check(&|w| w.class = "Progman".to_string(), "the desktop");
        check(&|w| w.class = "WorkerW".to_string(), "the desktop behind the wallpaper");
        check(&|w| w.class = "Shell_TrayWnd".to_string(), "the taskbar");
        check(&|w| w.exe = "explorer".to_string(), "task view, Explorer in F11");
        check(&|w| w.exe = "lockapp".to_string(), "the lock screen");
        check(&|w| w.exe = "mystify.scr".to_string(), "a screen saver");
        check(&|w| w.monitor = Rect { left: 0, top: 0, right: 0, bottom: 0 }, "no monitor");
        for browser in ["chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "arc"] {
            check(&|w| w.exe = browser.to_string(), "a video in a browser");
        }
    }
}
