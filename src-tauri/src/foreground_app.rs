//! The app a dictation goes into (foreground window: program and title), and
//! the open apps the rule editor suggests.

use crate::ai_cleanup::AppContext;

/// `C:\Program Files\WindowsApps\...\WhatsApp.Root.exe` -> `whatsapp.root`.
pub fn exe_name(path: &str) -> String {
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path).to_lowercase();
    match file.strip_suffix(".exe") {
        Some(stem) => stem.to_string(),
        None => file,
    }
}

/// Program and title of the foreground window.
pub fn current() -> AppContext {
    imp::current()
}

/// Programs with a visible main window, sorted, without RudariFlow.
pub fn open_apps() -> Vec<String> {
    imp::open_apps()
}

/// Executable name of a process, as in `exe_name`; empty when unknown.
pub fn process_name(pid: u32) -> String {
    imp::process_exe(pid)
}

#[cfg(windows)]
mod imp {
    use super::exe_name;
    use crate::ai_cleanup::AppContext;
    use windows_sys::Win32::Foundation::{CloseHandle, BOOL, FALSE, HWND, LPARAM, TRUE};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GetForegroundWindow, GetWindow, GetWindowLongW,
        GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE,
        GW_OWNER, WS_EX_TOOLWINDOW,
    };

    /// UWP apps draw inside ApplicationFrameHost.exe.
    const FRAME_HOST: &str = "applicationframehost";

    fn window_title(hwnd: HWND) -> String {
        let mut buf = [0u16; 512];
        let len = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        String::from_utf16_lossy(&buf[..len.max(0) as usize])
    }

    fn window_pid(hwnd: HWND) -> u32 {
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        pid
    }

    pub fn process_exe(pid: u32) -> String {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
            if process.is_null() {
                return String::new();
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
            CloseHandle(process);
            if ok == 0 {
                return String::new();
            }
            exe_name(&String::from_utf16_lossy(&buf[..len as usize]))
        }
    }

    /// The hosted UWP app: a child window that belongs to another process.
    fn hosted_app_pid(frame: HWND, frame_pid: u32) -> Option<u32> {
        struct Search {
            frame_pid: u32,
            found: u32,
        }
        unsafe extern "system" fn visit(child: HWND, lparam: LPARAM) -> BOOL {
            let search = &mut *(lparam as *mut Search);
            let pid = window_pid(child);
            if pid != 0 && pid != search.frame_pid {
                search.found = pid;
                return FALSE;
            }
            TRUE
        }
        let mut search = Search { frame_pid, found: 0 };
        unsafe { EnumChildWindows(frame, Some(visit), &mut search as *mut Search as LPARAM) };
        (search.found != 0).then_some(search.found)
    }

    fn app_of(hwnd: HWND) -> String {
        let pid = window_pid(hwnd);
        let exe = process_exe(pid);
        if exe != FRAME_HOST {
            return exe;
        }
        hosted_app_pid(hwnd, pid).map(process_exe).unwrap_or(exe)
    }

    pub fn current() -> AppContext {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            return AppContext::default();
        }
        AppContext { exe: app_of(hwnd), title: window_title(hwnd) }
    }

    fn is_cloaked(hwnd: HWND) -> bool {
        let mut cloaked: u32 = 0;
        let hr = unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED as _,
                &mut cloaked as *mut u32 as *mut core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            )
        };
        hr == 0 && cloaked != 0
    }

    fn is_app_window(hwnd: HWND) -> bool {
        unsafe {
            IsWindowVisible(hwnd) != 0
                && GetWindowTextLengthW(hwnd) > 0
                && GetWindow(hwnd, GW_OWNER).is_null()
                && (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW) == 0
        }
    }

    pub fn open_apps() -> Vec<String> {
        unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
            (*(lparam as *mut Vec<HWND>)).push(hwnd);
            TRUE
        }
        let mut windows: Vec<HWND> = Vec::new();
        unsafe { EnumWindows(Some(collect), &mut windows as *mut Vec<HWND> as LPARAM) };

        let mut apps: Vec<String> = windows
            .into_iter()
            .filter(|&hwnd| is_app_window(hwnd) && !is_cloaked(hwnd))
            .map(app_of)
            .filter(|exe| !exe.is_empty() && exe != "rudariflow" && exe != FRAME_HOST)
            .collect();
        apps.sort();
        apps.dedup();
        apps
    }
}

#[cfg(not(windows))]
mod imp {
    use crate::ai_cleanup::AppContext;

    pub fn current() -> AppContext {
        AppContext::default()
    }

    pub fn open_apps() -> Vec<String> {
        Vec::new()
    }

    pub fn process_exe(_pid: u32) -> String {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_names_are_lowercase_stems() {
        assert_eq!(exe_name(r"C:\Program Files\WindowsApps\5319\WhatsApp.Root.exe"), "whatsapp.root");
        assert_eq!(exe_name(r"C:\Windows\explorer.exe"), "explorer");
        assert_eq!(exe_name("OUTLOOK.EXE"), "outlook");
        assert_eq!(exe_name("/usr/bin/code"), "code");
    }

    #[cfg(windows)]
    #[test]
    fn reads_foreground_and_open_apps_without_panicking() {
        let _ = current();
        let apps = open_apps();
        assert!(!apps.iter().any(|a| a == "rudariflow" || a.ends_with(".exe")));
    }
}
