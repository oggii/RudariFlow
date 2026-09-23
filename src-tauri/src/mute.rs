//! Mute other apps while recording.
//!
//! Mutes every audio session on every active playback device, except sessions
//! that belong to RudariFlow itself (the webview plays the start/stop sounds
//! from a child process) and sessions the user had already muted. `restore`
//! unmutes exactly the sessions that were muted here.
//!
//! COM work runs on one dedicated thread, so the hotkey path never waits on
//! the audio stack and the session objects never cross threads.

use std::sync::mpsc::Sender;
use std::sync::Mutex;

use crate::startup_log;

enum Command {
    Mute,
    Restore,
}

static WORKER: Mutex<Option<Sender<Command>>> = Mutex::new(None);

fn send(cmd: Command) {
    let mut worker = WORKER.lock().unwrap_or_else(|p| p.into_inner());
    if worker.is_none() {
        *worker = imp::spawn_worker();
    }
    if let Some(tx) = worker.as_ref() {
        if tx.send(cmd).is_err() {
            *worker = None;
        }
    }
}

/// Mute other apps. Does nothing if they are already muted by us.
pub fn mute_others() {
    send(Command::Mute);
}

/// Unmute what `mute_others` muted. Safe to call when nothing is muted.
pub fn restore() {
    if WORKER.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
        send(Command::Restore);
    }
}

#[cfg(windows)]
mod imp {
    use super::{startup_log, Command};
    use std::collections::HashMap;
    use std::sync::mpsc::{self, Sender};
    use windows::core::Interface;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Media::Audio::{
        eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    pub fn spawn_worker() -> Option<Sender<Command>> {
        let (tx, rx) = mpsc::channel::<Command>();
        std::thread::Builder::new()
            .name("rf-audio-mute".into())
            .spawn(move || {
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                }
                let mut muted: Option<Vec<ISimpleAudioVolume>> = None;
                for cmd in rx {
                    match cmd {
                        Command::Mute if muted.is_none() => match mute_all() {
                            Ok(list) => {
                                startup_log::log(&format!("[mute] muted {} sessions", list.len()));
                                muted = Some(list);
                            }
                            Err(e) => startup_log::log(&format!("[mute] failed: {}", e)),
                        },
                        Command::Mute => {}
                        Command::Restore => {
                            for volume in muted.take().unwrap_or_default() {
                                // The app may have closed meanwhile; nothing to restore then.
                                let _ = unsafe { volume.SetMute(false, std::ptr::null()) };
                            }
                        }
                    }
                }
            })
            .ok()?;
        Some(tx)
    }

    fn mute_all() -> windows::core::Result<Vec<ISimpleAudioVolume>> {
        let parents = parent_pids();
        let own = std::process::id();
        let mut muted = Vec::new();
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let devices = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
            for d in 0..devices.GetCount()? {
                let Ok(device) = devices.Item(d) else { continue };
                let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                    continue;
                };
                let Ok(sessions) = manager.GetSessionEnumerator() else { continue };
                for s in 0..sessions.GetCount().unwrap_or(0) {
                    let Ok(control) = sessions.GetSession(s) else { continue };
                    let Ok(control2) = control.cast::<IAudioSessionControl2>() else { continue };
                    let pid = control2.GetProcessId().unwrap_or(0);
                    if pid != 0 && descends_from(pid, own, &parents) {
                        continue;
                    }
                    let Ok(volume) = control.cast::<ISimpleAudioVolume>() else { continue };
                    if volume.GetMute().map(|m| m.as_bool()).unwrap_or(true) {
                        continue;
                    }
                    if volume.SetMute(true, std::ptr::null()).is_ok() {
                        muted.push(volume);
                    }
                }
            }
        }
        Ok(muted)
    }

    /// Child pid -> parent pid for every running process.
    fn parent_pids() -> HashMap<u32, u32> {
        let mut map = HashMap::new();
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return map;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    map.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
        map
    }

    /// Whether `pid` is `ancestor` or one of its descendants. Bounded, since
    /// reused pids can form cycles in the parent map.
    pub(super) fn descends_from(mut pid: u32, ancestor: u32, parents: &HashMap<u32, u32>) -> bool {
        for _ in 0..16 {
            if pid == ancestor {
                return true;
            }
            match parents.get(&pid) {
                Some(&parent) if parent != 0 && parent != pid => pid = parent,
                _ => return false,
            }
        }
        false
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Command;
    use std::sync::mpsc::Sender;

    pub fn spawn_worker() -> Option<Sender<Command>> {
        None
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::imp::descends_from;
    use std::collections::HashMap;

    #[test]
    fn follows_parent_chain() {
        // 30 (audio utility) -> 20 (webview browser) -> 10 (app) -> 1
        let parents = HashMap::from([(30, 20), (20, 10), (10, 1)]);
        assert!(descends_from(30, 10, &parents));
        assert!(descends_from(10, 10, &parents));
        assert!(!descends_from(1, 10, &parents));
        assert!(!descends_from(99, 10, &parents));
    }

    #[test]
    fn stops_on_cycles() {
        let parents = HashMap::from([(5, 6), (6, 5)]);
        assert!(!descends_from(5, 10, &parents));
    }
}
