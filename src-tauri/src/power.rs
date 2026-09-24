//! Power state. On battery, RudariFlow frees the GPU after a while without
//! dictation, so a laptop's graphics card can go to sleep.

use std::time::Duration;

/// On battery, both models are unloaded after this long without dictation.
/// The next hotkey press loads them again while the user speaks.
pub const IDLE_UNLOAD: Duration = Duration::from_secs(10 * 60);

/// Whether the PC runs on battery right now; false on desktops and when the
/// power state is unknown.
pub fn on_battery() -> bool {
    imp::on_battery()
}

/// Whether to unload the models now.
pub fn should_unload(on_battery: bool, idle: Duration, loaded: bool, busy: bool) -> bool {
    on_battery && loaded && !busy && idle >= IDLE_UNLOAD
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
    fn unloads_only_on_battery_when_idle_and_loaded() {
        let long = IDLE_UNLOAD;
        let short = IDLE_UNLOAD - Duration::from_secs(1);
        assert!(should_unload(true, long, true, false));
        assert!(!should_unload(false, long, true, false), "plugged in or desktop");
        assert!(!should_unload(true, short, true, false), "not idle long enough");
        assert!(!should_unload(true, long, false, false), "nothing loaded");
        assert!(!should_unload(true, long, true, true), "recording or transcribing");
    }
}
