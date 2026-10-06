//! Free GPU for games (Engine tab, off by default): an app that covers a
//! whole monitor (fullscreen or borderless) in the foreground for a few
//! seconds frees the GPU like the Free GPU hotkey. The game then counts as
//! running while its window is open, visible, not minimised and covers its
//! monitor, whatever window is in front (Discord on another monitor). Half a
//! minute after it stops, the models load again.
//!
//! `GameWatch` decides from what main.rs observes about once a second
//! (`observe`); `look` reads the windows on Windows.

use std::time::{Duration, Instant};

/// A fullscreen app in the foreground this long frees the GPU.
pub const FREE_AFTER: Duration = Duration::from_secs(5);
/// The game stopped (closed, minimised, no longer fullscreen) this long ago
/// loads the models again.
pub const LOAD_AFTER: Duration = Duration::from_secs(30);

/// A fullscreen app: its program and its window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Front {
    /// As `foreground_app::exe_name`, "?" when unknown.
    pub game: String,
    /// The window handle as a number.
    pub window: isize,
    /// Its process, so a handle Windows gives to a new window later is not
    /// taken for the game.
    pub pid: u32,
}

/// What the watcher saw at one look.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Observation {
    /// The fullscreen app in the foreground; `None` when the foreground is
    /// no game.
    pub front: Option<Front>,
    /// The window `GameWatch::tracked` named before this look still runs:
    /// open, visible, not minimised, covering its monitor (`still_running`).
    pub tracked_running: bool,
    /// main.rs holds the GPU freed for a game right now (`GameFree::holds`).
    pub holds: bool,
}

impl Front {
    /// The same program: by name, and by process when the name could not be
    /// read ("?"), so two unreadable programs are not taken for one.
    fn same_game(&self, other: &Front) -> bool {
        self.game == other.game && (self.game != "?" || self.pid == other.pid)
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
    Seen { game: Front, since: Instant },
    /// Freed for `game`; `last_seen` is the last look it ran.
    Freed { game: Front, last_seen: Instant },
    /// The user loaded the models with the hotkey while `game` ran: no free
    /// until it has stopped for `LOAD_AFTER`.
    Suspended { game: Front, last_seen: Instant },
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

    /// One look at `now`.
    pub fn observe(&mut self, seen: &Observation, now: Instant) -> Option<Action> {
        let phase = std::mem::replace(&mut self.phase, Phase::Idle);
        let (next, action) = match (phase, &seen.front) {
            (Phase::Idle, None) => (Phase::Idle, None),
            (Phase::Idle, Some(front)) => (Phase::Seen { game: front.clone(), since: now }, None),
            (Phase::Seen { .. }, None) => (Phase::Idle, None),
            (Phase::Seen { game, since }, Some(front)) if front.same_game(&game) => {
                // The newest window of the program (a game may make a new
                // one when it changes the resolution).
                let game = front.clone();
                if now.saturating_duration_since(since) >= FREE_AFTER {
                    (Phase::Freed { game, last_seen: now }, Some(Action::FreeNow))
                } else {
                    (Phase::Seen { game, since }, None)
                }
            }
            // Another app came to the front: its own seconds count.
            (Phase::Seen { .. }, Some(other)) => (Phase::Seen { game: other.clone(), since: now }, None),
            (Phase::Freed { game, .. }, _) if seen.tracked_running => (Phase::Freed { game, last_seen: now }, None),
            // The game's window is gone, but a fullscreen app is in front
            // (the same game's new window, or the next game): follow it.
            (Phase::Freed { .. }, Some(front)) => (Phase::Freed { game: front.clone(), last_seen: now }, None),
            (Phase::Freed { game, last_seen }, None) => {
                if now.saturating_duration_since(last_seen) >= LOAD_AFTER {
                    (Phase::Idle, Some(Action::LoadAgain))
                } else {
                    (Phase::Freed { game, last_seen }, None)
                }
            }
            (Phase::Suspended { game, .. }, _) if seen.tracked_running => {
                (Phase::Suspended { game, last_seen: now }, None)
            }
            (Phase::Suspended { game, .. }, Some(front)) if front.same_game(&game) => {
                (Phase::Suspended { game: front.clone(), last_seen: now }, None)
            }
            // A different game while the one the user loaded for is gone.
            (Phase::Suspended { .. }, Some(other)) => (Phase::Seen { game: other.clone(), since: now }, None),
            (Phase::Suspended { game, last_seen }, None) => {
                if now.saturating_duration_since(last_seen) >= LOAD_AFTER {
                    // Still freed for a game (a free that raced the hotkey's
                    // load): the game is over, so load.
                    (Phase::Idle, seen.holds.then_some(Action::LoadAgain))
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
    /// game has stopped for `LOAD_AFTER`.
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

    /// The game whose window the next look checks (`Observation::tracked_running`).
    pub fn tracked(&self) -> Option<&Front> {
        match &self.phase {
            Phase::Freed { game, .. } | Phase::Suspended { game, .. } => Some(game),
            Phase::Idle | Phase::Seen { .. } => None,
        }
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

/// What the watcher reads about a window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub visible: bool,
    pub minimized: bool,
    /// Hidden by Windows although "visible", e.g. on another virtual desktop.
    pub cloaked: bool,
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

/// Calls and remote desktops in fullscreen: a screen share or a remote PC
/// is no game.
const CALLS_AND_REMOTE: &[&str] = &[
    "ms-teams", "teams", "zoom", "discord", "discordptb", "discordcanary", "rustdesk", "mstsc", "msrdc", "parsecd",
    "parsec", "anydesk", "teamviewer",
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

/// A call or remote desktop app (`CALLS_AND_REMOTE`).
pub fn is_call_or_remote(exe: &str) -> bool {
    CALLS_AND_REMOTE.contains(&exe)
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

/// A window in fullscreen: visible, not minimised, no ordinary maximised
/// window, covering its monitor.
fn fullscreen(window: &WindowInfo) -> bool {
    window.visible
        && !window.cloaked
        && !window.minimized
        && !window.maximized_with_caption
        && covers_monitor(window.rect, window.monitor)
}

/// The game in this foreground window, if it is one: in fullscreen, and
/// none of RudariFlow's own windows (`own_pid`), the shell, a screen saver,
/// a browser, a call or a remote desktop. Video players count.
pub fn game_in(window: &WindowInfo, own_pid: u32) -> Option<String> {
    if window.pid == own_pid || SHELL_CLASSES.contains(&window.class.as_str()) {
        return None;
    }
    let exe = window.exe.as_str();
    if SHELL_EXES.contains(&exe) || exe.ends_with(".scr") || is_browser(exe) || is_call_or_remote(exe) {
        return None;
    }
    if !fullscreen(window) {
        return None;
    }
    Some(if exe.is_empty() { "?".to_string() } else { exe.to_string() })
}

/// The game's window (now `window`) still runs: the same process, and still
/// in fullscreen on its monitor. In the foreground or not.
pub fn still_running(game: &Front, window: &WindowInfo) -> bool {
    window.pid == game.pid && fullscreen(window)
}

/// The program of the window last looked at, so its process is not opened
/// every second: (window, process, name).
static LAST_EXE: std::sync::Mutex<Option<(isize, u32, String)>> = std::sync::Mutex::new(None);

fn exe_of(window: isize, pid: u32) -> String {
    let mut last = LAST_EXE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((w, p, exe)) = last.as_ref() {
        if *w == window && *p == pid {
            return exe.clone();
        }
    }
    let exe = crate::foreground_app::process_name(pid);
    *last = Some((window, pid, exe.clone()));
    exe
}

/// One look: the fullscreen app in front, and whether the game `watch`
/// tracks still runs (its process is not opened for that: `still_running`
/// compares the process id). `holds`: see `Observation::holds`.
pub fn look(watch: &GameWatch, holds: bool) -> Observation {
    let own_pid = std::process::id();
    let front = imp::foreground_window().and_then(|(window, mut info)| {
        info.exe = exe_of(window, info.pid);
        game_in(&info, own_pid).map(|game| Front { game, window, pid: info.pid })
    });
    let tracked_running = watch
        .tracked()
        .is_some_and(|game| imp::window_info(game.window).is_some_and(|info| still_running(game, &info)));
    Observation { front, tracked_running, holds }
}

#[cfg(windows)]
mod imp {
    use super::{Rect, WindowInfo};
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, IsIconic,
        IsWindow, IsWindowVisible, IsZoomed, GWL_STYLE, WS_CAPTION,
    };

    fn rect(r: RECT) -> Rect {
        Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    }

    /// The foreground window: its handle as a number and what it is.
    pub fn foreground_window() -> Option<(isize, WindowInfo)> {
        // SAFETY: returns a handle or null; no memory is passed.
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            return None;
        }
        let window = hwnd as isize;
        window_info(window).map(|info| (window, info))
    }

    /// What `window` is, or `None` when it no longer exists. `exe` stays
    /// empty: the caller reads it when it needs it.
    pub fn window_info(window: isize) -> Option<WindowInfo> {
        let hwnd = window as HWND;
        // SAFETY: plain Win32 queries on a window handle (one that no
        // longer exists only makes them fail); the buffers and structs are
        // owned here and sized for the calls.
        unsafe {
            if hwnd.is_null() || IsWindow(hwnd) == 0 {
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
            let mut cloaked: u32 = 0;
            let cloaked_read = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED as _,
                &mut cloaked as *mut u32 as *mut core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
            Some(WindowInfo {
                visible: IsWindowVisible(hwnd) != 0,
                cloaked: cloaked_read == 0 && cloaked != 0,
                minimized: IsIconic(hwnd) != 0,
                maximized_with_caption: IsZoomed(hwnd) != 0 && style & WS_CAPTION == WS_CAPTION,
                class: String::from_utf16_lossy(&class[..len.max(0) as usize]),
                pid,
                exe: String::new(),
                rect: rect(window),
                monitor: rect(info.rcMonitor),
            })
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn foreground_window() -> Option<(isize, super::WindowInfo)> {
        None
    }

    pub fn window_info(_window: isize) -> Option<super::WindowInfo> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    /// `game` in fullscreen in front, in window `window` (process = window).
    fn front(game: &str, window: isize) -> Front {
        Front { game: game.to_string(), window, pid: window as u32 }
    }

    /// A look: `front` in the foreground (`None`: no game there), and the
    /// tracked game's window running or not.
    fn look_at(front: Option<Front>, tracked_running: bool) -> Observation {
        Observation { front, tracked_running, holds: false }
    }

    /// The game in front, its window running.
    fn playing(game: &str, window: isize) -> Observation {
        look_at(Some(front(game, window)), true)
    }

    /// Something else in front (Discord, the desktop), the game's window
    /// still running on its monitor.
    fn elsewhere() -> Observation {
        look_at(None, true)
    }

    /// No game in front, and the tracked game's window closed, minimised or
    /// no longer fullscreen.
    fn stopped() -> Observation {
        look_at(None, false)
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
        let actions = run(&mut watch, start, 0, 20, &playing("eldenring", 7));
        assert_eq!(actions, vec![(5, Action::FreeNow)], "after 5 s, and only once");
        assert!(watch.freed());
        assert_eq!(watch.tracked(), Some(&front("eldenring", 7)), "its window is watched from now on");
    }

    #[test]
    fn a_short_fullscreen_moment_frees_nothing() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        assert!(run(&mut watch, start, 0, 4, &playing("vlc", 7)).is_empty());
        // Back to the desktop before the 5 s were up: the count starts over.
        assert!(run(&mut watch, start, 5, 5, &stopped()).is_empty());
        assert!(run(&mut watch, start, 6, 10, &playing("vlc", 7)).is_empty());
        assert_eq!(run(&mut watch, start, 11, 11, &playing("vlc", 7)), vec![(11, Action::FreeNow)]);
    }

    #[test]
    fn detection_needs_the_game_in_front_even_if_a_window_runs() {
        // Before a free nothing is tracked: a fullscreen game behind Discord
        // does not count.
        let start = Instant::now();
        let mut watch = GameWatch::new();
        assert!(run(&mut watch, start, 0, 60, &elsewhere()).is_empty());
        assert_eq!(watch.tracked(), None);
    }

    #[test]
    fn switching_between_fullscreen_apps_restarts_the_count() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        assert!(run(&mut watch, start, 0, 3, &playing("launcher", 3)).is_empty());
        assert!(run(&mut watch, start, 4, 8, &playing("game", 7)).is_empty());
        assert_eq!(run(&mut watch, start, 9, 9, &playing("game", 7)), vec![(9, Action::FreeNow)]);
        assert_eq!(watch.tracked(), Some(&front("game", 7)));
    }

    #[test]
    fn a_game_that_makes_a_new_window_is_tracked_by_the_newest() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 2, &playing("game", 7));
        assert_eq!(run(&mut watch, start, 3, 5, &playing("game", 8)), vec![(5, Action::FreeNow)]);
        assert_eq!(watch.tracked(), Some(&front("game", 8)));
    }

    #[test]
    fn the_game_stays_freed_while_another_window_is_in_front() {
        // Three monitors: Discord on another one for ten minutes.
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &playing("game", 7));
        assert!(run(&mut watch, start, 11, 600, &elsewhere()).is_empty());
        assert!(watch.freed());
        assert!(run(&mut watch, start, 601, 700, &playing("game", 7)).is_empty(), "no second free");
    }

    #[test]
    fn a_different_fullscreen_app_in_front_while_the_game_runs_keeps_it_freed() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &playing("game", 7));
        assert!(run(&mut watch, start, 11, 300, &look_at(Some(front("vlc", 9)), true)).is_empty());
        assert!(watch.freed());
        assert_eq!(watch.tracked(), Some(&front("game", 7)), "still the game's window");
    }

    #[test]
    fn the_models_load_again_thirty_seconds_after_the_game_is_closed() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 100, &playing("game", 7));
        let actions = run(&mut watch, start, 101, 200, &stopped());
        assert_eq!(actions, vec![(130, Action::LoadAgain)], "30 s after the last look it ran");
        assert!(!watch.freed());
        assert_eq!(watch.tracked(), None);
    }

    #[test]
    fn a_minimised_game_loads_the_models_again_after_thirty_seconds() {
        // Minimised (or windowed): `still_running` says no, behind Discord
        // or not.
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &playing("game", 7));
        run(&mut watch, start, 11, 20, &elsewhere());
        assert_eq!(run(&mut watch, start, 21, 60, &stopped()), vec![(50, Action::LoadAgain)]);
    }

    #[test]
    fn minimised_for_less_than_thirty_seconds_keeps_the_gpu_free() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &playing("game", 7));
        assert!(run(&mut watch, start, 11, 39, &stopped()).is_empty(), "minimised for 29 s");
        assert!(run(&mut watch, start, 40, 50, &playing("game", 7)).is_empty(), "no second free");
        assert!(watch.freed());
        assert_eq!(run(&mut watch, start, 51, 81, &stopped()), vec![(80, Action::LoadAgain)]);
    }

    #[test]
    fn the_next_game_after_the_first_is_closed_keeps_the_gpu_free() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &playing("game", 7));
        // Game closed, the next one in front: follow it.
        assert!(run(&mut watch, start, 11, 12, &look_at(Some(front("other", 9)), false)).is_empty());
        assert_eq!(watch.tracked(), Some(&front("other", 9)));
        assert!(run(&mut watch, start, 13, 300, &elsewhere()).is_empty(), "its window runs");
        assert_eq!(run(&mut watch, start, 301, 331, &stopped()), vec![(330, Action::LoadAgain)]);
    }

    #[test]
    fn loading_with_the_hotkey_during_the_game_suspends_until_it_has_stopped() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &playing("game", 7));
        watch.user_loaded(start + secs(10));
        assert!(watch.suspended());
        assert_eq!(watch.tracked(), Some(&front("game", 7)));
        assert!(run(&mut watch, start, 11, 100, &playing("game", 7)).is_empty(), "no free, no load");
        // Discord in front for minutes while the game runs: still suspended.
        assert!(run(&mut watch, start, 101, 400, &elsewhere()).is_empty());
        // Another fullscreen app in front while the game runs: still suspended.
        assert!(run(&mut watch, start, 401, 450, &look_at(Some(front("vlc", 9)), true)).is_empty());
        assert!(watch.suspended());
        // Minimised for 20 s and back: still suspended.
        assert!(run(&mut watch, start, 451, 470, &stopped()).is_empty());
        assert!(run(&mut watch, start, 471, 480, &playing("game", 7)).is_empty());
        assert!(watch.suspended());
        // Closed for 30 s: nothing to load (the user did), and the next game frees again.
        assert!(run(&mut watch, start, 481, 520, &stopped()).is_empty());
        assert!(!watch.suspended());
        assert_eq!(run(&mut watch, start, 521, 530, &playing("game", 11)), vec![(526, Action::FreeNow)]);
    }

    #[test]
    fn loading_while_a_game_is_being_counted_suspends_too() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 2, &playing("game", 7));
        watch.user_loaded(start + secs(2));
        assert!(run(&mut watch, start, 3, 60, &playing("game", 7)).is_empty());
    }

    #[test]
    fn the_suspended_game_with_a_new_window_stays_suspended() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &playing("game", 7));
        watch.user_loaded(start + secs(10));
        assert!(run(&mut watch, start, 11, 60, &look_at(Some(front("game", 8)), false)).is_empty());
        assert_eq!(watch.tracked(), Some(&front("game", 8)));
    }

    #[test]
    fn a_different_game_after_the_suspended_one_is_gone_frees() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &playing("game", 7));
        watch.user_loaded(start + secs(10));
        let other = look_at(Some(front("other", 9)), false);
        assert_eq!(run(&mut watch, start, 11, 20, &other), vec![(16, Action::FreeNow)]);
    }

    #[test]
    fn loading_after_the_game_while_waiting_to_reload_loads_nothing_twice() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &playing("game", 7));
        run(&mut watch, start, 11, 20, &stopped());
        watch.user_loaded(start + secs(20));
        assert!(run(&mut watch, start, 21, 100, &stopped()).is_empty(), "the hotkey already loaded");
    }

    #[test]
    fn a_hotkey_load_with_no_game_changes_nothing() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        watch.user_loaded(start);
        assert!(!watch.suspended());
        assert_eq!(run(&mut watch, start, 1, 6, &playing("game", 7)), vec![(6, Action::FreeNow)]);
    }

    #[test]
    fn reset_forgets_a_free() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &playing("game", 7));
        watch.reset();
        assert!(!watch.freed());
        assert_eq!(watch.tracked(), None);
        assert!(run(&mut watch, start, 11, 100, &stopped()).is_empty());
    }

    #[test]
    fn a_long_pause_between_looks_counts_as_time() {
        // The watcher thread can be held up (a free waits for a dictation).
        let start = Instant::now();
        let mut watch = GameWatch::new();
        assert_eq!(watch.observe(&playing("game", 7), start), None);
        assert_eq!(watch.observe(&playing("game", 7), start + secs(9)), Some(Action::FreeNow));
        assert_eq!(watch.observe(&stopped(), start + secs(10)), None);
        assert_eq!(watch.observe(&stopped(), start + secs(60)), Some(Action::LoadAgain));
    }

    fn monitor() -> Rect {
        Rect { left: 0, top: 0, right: 2560, bottom: 1440 }
    }

    fn game_window() -> WindowInfo {
        WindowInfo {
            visible: true,
            cloaked: false,
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

    #[test]
    fn the_tracked_game_runs_while_its_window_stays_fullscreen() {
        let game = Front { game: "fortniteclient-win64-shipping".to_string(), window: 7, pid: 4242 };
        assert!(still_running(&game, &game_window()), "in front or not, it is the same check");
        let stops = |change: &dyn Fn(&mut WindowInfo), why: &str| {
            let mut w = game_window();
            change(&mut w);
            assert!(!still_running(&game, &w), "{}", why);
        };
        stops(&|w| w.minimized = true, "minimised");
        stops(&|w| w.visible = false, "hidden");
        stops(&|w| w.rect = Rect { left: 200, top: 100, right: 1800, bottom: 1000 }, "switched to windowed");
        stops(&|w| w.maximized_with_caption = true, "an ordinary maximised window");
        stops(&|w| w.pid = 5555, "the handle now belongs to another program");
        stops(&|w| w.cloaked = true, "moved to another virtual desktop");
    }

    #[test]
    fn calls_and_remote_desktops_are_no_games_but_video_players_are() {
        for exe in [
            "ms-teams", "teams", "zoom", "discord", "discordptb", "discordcanary", "rustdesk", "mstsc", "msrdc", "parsecd",
            "anydesk", "teamviewer",
        ] {
            let mut w = game_window();
            w.exe = exe.to_string();
            assert_eq!(game_in(&w, 1), None, "{}", exe);
        }
        for exe in ["vlc", "mpv", "obs64", "snippingtool"] {
            let mut w = game_window();
            w.exe = exe.to_string();
            assert!(game_in(&w, 1).is_some(), "{} counts, as the user chose", exe);
        }
        let mut cloaked = game_window();
        cloaked.cloaked = true;
        assert_eq!(game_in(&cloaked, 1), None, "on another virtual desktop");
    }

    #[test]
    fn unreadable_programs_are_told_apart_by_their_process() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        let unknown = |pid: u32| look_at(Some(Front { game: "?".into(), window: pid as isize, pid }), true);
        // Two programs whose names could not be read take turns in front:
        // neither is in front for 5 s.
        for s in 0..20u64 {
            let pid = if s % 2 == 0 { 100 } else { 200 };
            assert_eq!(watch.observe(&unknown(pid), start + secs(s)), None, "second {}", s);
        }
        // One of them alone for 5 s frees.
        assert_eq!(run(&mut watch, start, 20, 25, &unknown(100)), vec![(25, Action::FreeNow)]);
    }

    #[test]
    fn a_suspension_that_ends_while_the_gpu_is_still_freed_loads() {
        let start = Instant::now();
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &playing("game", 7));
        watch.user_loaded(start + secs(10));
        // The game is closed; main.rs still holds the GPU freed (a free
        // that raced the hotkey's load): the models must not stay unloaded.
        let held = Observation { front: None, tracked_running: false, holds: true };
        assert_eq!(run(&mut watch, start, 11, 45, &held), vec![(40, Action::LoadAgain)]);
        assert!(!watch.suspended());
        // Not held: nothing to load.
        let mut watch = GameWatch::new();
        run(&mut watch, start, 0, 10, &playing("game", 7));
        watch.user_loaded(start + secs(10));
        assert!(run(&mut watch, start, 11, 45, &stopped()).is_empty());
    }
}
