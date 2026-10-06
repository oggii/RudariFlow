//! Power state. On battery, RudariFlow frees the GPU after a while without
//! dictation, so a laptop's graphics card can go to sleep; on mains power
//! only when the Engine setting "Unload when idle" asks for it. The Free GPU
//! hotkey frees it on demand (`gpu_toggle`).

use std::time::Duration;

/// On battery, both models are unloaded after this long without dictation.
/// The next hotkey press loads them again while the user speaks.
pub const IDLE_UNLOAD: Duration = Duration::from_secs(10 * 60);

/// Whether the PC runs on battery right now; false on desktops and when the
/// power state is unknown.
pub fn on_battery() -> bool {
    imp::on_battery()
}

/// How long without dictation unloads the models: `IDLE_UNLOAD` on battery,
/// the "Unload when idle" setting (`mains_minutes`, 0 = never) on mains
/// power. `None` = never.
pub fn idle_limit(on_battery: bool, mains_minutes: u32) -> Option<Duration> {
    if on_battery {
        Some(IDLE_UNLOAD)
    } else if mains_minutes > 0 {
        Some(Duration::from_secs(u64::from(mains_minutes) * 60))
    } else {
        None
    }
}

/// Whether the idle watcher must keep the models: a dictation runs, a
/// meeting records or runs its end steps, or a file is transcribed.
pub fn busy(dictating: bool, meeting: bool, file_running: bool) -> bool {
    dictating || meeting || file_running
}

/// Whether to unload the models now. `busy`: see `busy`.
pub fn should_unload(on_battery: bool, mains_minutes: u32, idle: Duration, loaded: bool, busy: bool) -> bool {
    loaded && !busy && idle_limit(on_battery, mains_minutes).is_some_and(|limit| idle >= limit)
}

/// What a press of the Free GPU hotkey does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuToggle {
    /// Unload Whisper and stop the AI server.
    Free,
    /// Load them again.
    Load,
}

/// Load again only when the last press freed the GPU and both models are
/// still released. Once a dictation, a file or a summary has loaded one of
/// them, the press frees the GPU again. The battery watcher's unload is not
/// a release, so a press after it frees too.
pub fn gpu_toggle(freed: bool, whisper_released: bool, ai_released: bool) -> GpuToggle {
    if freed && whisper_released && ai_released {
        GpuToggle::Load
    } else {
        GpuToggle::Free
    }
}

/// A Free GPU press. While the GPU is freed for a game (`game_holds`),
/// Whisper loaded meanwhile (for a dictation, a file, a meeting's rest) is
/// let go of again soon, so it counts as released: the press loads, as the
/// user means it during a game.
pub fn press_toggle(freed: bool, whisper_released: bool, ai_released: bool, game_holds: bool) -> GpuToggle {
    gpu_toggle(freed, whisper_released || game_holds, ai_released)
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    /// ACLineStatus 0 = offline (battery), 1 = online, 255 = unknown.
    pub fn on_battery() -> bool {
        // SAFETY: plain struct filled by the call; 0 means failure.
        unsafe {
            let mut status: SYSTEM_POWER_STATUS = std::mem::zeroed();
            GetSystemPowerStatus(&mut status) != 0 && status.ACLineStatus == 0
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn on_battery() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unloads_on_battery_when_idle_and_loaded() {
        let long = IDLE_UNLOAD;
        let short = IDLE_UNLOAD - Duration::from_secs(1);
        assert!(should_unload(true, 0, long, true, false));
        assert!(!should_unload(false, 0, long, true, false), "plugged in or desktop, Never");
        assert!(!should_unload(true, 0, short, true, false), "not idle long enough");
        assert!(!should_unload(true, 0, long, false, false), "nothing loaded");
        assert!(!should_unload(true, 0, long, true, true), "recording, transcribing or a meeting");
    }

    #[test]
    fn unloads_on_mains_only_after_the_chosen_minutes() {
        let min = |m: u64| Duration::from_secs(m * 60);
        assert!(!should_unload(false, 0, min(24 * 60), true, false), "Never, the default");
        assert!(!should_unload(false, 15, min(15) - Duration::from_secs(1), true, false));
        assert!(should_unload(false, 15, min(15), true, false));
        assert!(!should_unload(false, 30, min(29), true, false));
        assert!(should_unload(false, 30, min(30), true, false));
        assert!(should_unload(false, 60, min(61), true, false));
        assert!(!should_unload(false, 60, min(61), true, true), "a meeting or a dictation keeps them");
        assert!(!should_unload(false, 60, min(61), false, false), "nothing loaded");
    }

    #[test]
    fn the_battery_keeps_its_ten_minutes_whatever_the_mains_setting() {
        assert_eq!(idle_limit(true, 0), Some(IDLE_UNLOAD));
        assert_eq!(idle_limit(true, 60), Some(IDLE_UNLOAD), "a longer mains time does not delay it");
        assert_eq!(idle_limit(true, 15), Some(IDLE_UNLOAD));
        assert!(should_unload(true, 60, IDLE_UNLOAD, true, false));
        assert_eq!(idle_limit(false, 0), None);
        assert_eq!(idle_limit(false, 15), Some(Duration::from_secs(15 * 60)));
    }

    #[test]
    fn the_idle_watcher_waits_for_dictations_meetings_and_files() {
        assert!(!busy(false, false, false));
        assert!(busy(true, false, false), "a dictation");
        assert!(busy(false, true, false), "a meeting records or finishes");
        assert!(busy(false, false, true), "a file is transcribed");
        assert!(!should_unload(false, 15, Duration::from_secs(3600), true, busy(false, false, true)));
    }

    #[test]
    fn a_press_during_a_game_dictation_loads() {
        // Freed for a game, a dictation loaded Whisper and is not let go of
        // yet: the press loads instead of freeing the GPU it means to fill.
        assert_eq!(press_toggle(true, false, true, true), GpuToggle::Load);
        assert_eq!(press_toggle(true, true, true, true), GpuToggle::Load);
        // Without the game, today's rule: a dictation since the free frees.
        assert_eq!(press_toggle(true, false, true, false), GpuToggle::Free);
        assert_eq!(press_toggle(true, true, true, false), GpuToggle::Load);
        // The AI started during the game (a summary): the press frees it.
        assert_eq!(press_toggle(true, true, false, true), GpuToggle::Free);
        assert_eq!(press_toggle(false, false, false, false), GpuToggle::Free);
    }

    #[test]
    fn free_gpu_loads_only_what_the_last_press_freed() {
        assert_eq!(gpu_toggle(false, false, false), GpuToggle::Free, "loaded, or unloaded on battery");
        assert_eq!(gpu_toggle(true, true, true), GpuToggle::Load, "the last press freed both");
        assert_eq!(gpu_toggle(true, false, true), GpuToggle::Free, "a dictation or file loaded Whisper since");
        assert_eq!(gpu_toggle(true, true, false), GpuToggle::Free, "a dictation or summary started the AI since");
        assert_eq!(gpu_toggle(false, true, true), GpuToggle::Free, "the last press loaded; there was nothing to load");
    }
}
