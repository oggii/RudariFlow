//! Spike: what UI Automation reports about the focused element and its
//! selection, per app, and how long the calls take. Prints a line whenever the
//! focused element or its selection changes. `cargo run --release --example
//! uia_probe -- <seconds>`
#[cfg(windows)]
fn main() -> windows::core::Result<()> {
    use std::time::{Duration, Instant};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::UI::Accessibility::*;

    let secs: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(60);
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
    let uia: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)? };
    let end = Instant::now() + Duration::from_secs(secs);
    let mut last = String::new();
    while Instant::now() < end {
        let t0 = Instant::now();
        let line = unsafe {
            match uia.GetFocusedElement() {
                Err(e) => format!("no focus: {e}"),
                Ok(el) => {
                    let pid = el.CurrentProcessId().unwrap_or(0);
                    let exe = process_exe_name(pid as u32);
                    let ct = el.CurrentControlType().map(|c| c.0).unwrap_or(0);
                    let name = el.CurrentName().map(|b| b.to_string()).unwrap_or_default();
                    let aid = el.CurrentAutomationId().map(|b| b.to_string()).unwrap_or_default();
                    let class = el.CurrentClassName().map(|b| b.to_string()).unwrap_or_default();
                    let fw = el.CurrentFrameworkId().map(|b| b.to_string()).unwrap_or_default();
                    let pw = el.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false);
                    let t_el = t0.elapsed();
                    // Chromium right after its accessibility turns on: the page
                    // is reported as focused; look for the focused element in it.
                    let mut el = el;
                    let mut extra = String::new();
                    if aid == "RootWebArea" {
                        let cond = uia.CreatePropertyCondition(UIA_HasKeyboardFocusPropertyId, &windows::Win32::System::Variant::VARIANT::from(true));
                        if let Ok(cond) = cond {
                            match el.FindFirst(TreeScope_Descendants, &cond) {
                                Ok(found) => {
                                    extra = format!(" [inner focus: ct={} name={:?}]", found.CurrentControlType().map(|c| c.0).unwrap_or(0), found.CurrentName().map(|b| b.to_string()).unwrap_or_default());
                                    el = found;
                                }
                                Err(e) => extra = format!(" [no inner focus: {}]", e.code()),
                            }
                        }
                    }
                    let sel = match el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
                        Err(e) => format!("no TextPattern ({})", e.code()),
                        Ok(tp) => match tp.GetSelection() {
                            Err(e) => format!("GetSelection failed {e}"),
                            Ok(arr) => {
                                let n = arr.Length().unwrap_or(0);
                                let mut texts = Vec::new();
                                for i in 0..n {
                                    if let Ok(r) = arr.GetElement(i) {
                                        let t = r.GetText(-1).map(|b| b.to_string()).unwrap_or_default();
                                        texts.push(format!("{:?}", t.chars().take(60).collect::<String>()));
                                    }
                                }
                                format!("TextPattern sel[{n}] {}", texts.join(" | "))
                            }
                        },
                    };
                    format!(
                        "{exe}{extra} ct={ct} name={:?} aid={:?} class={:?} fw={fw} pw={pw} | {sel} | el {} ms, total {} ms",
                        name.chars().take(40).collect::<String>(),
                        aid.chars().take(30).collect::<String>(),
                        class.chars().take(30).collect::<String>(),
                        t_el.as_millis(),
                        t0.elapsed().as_millis()
                    )
                }
            }
        };
        let key = line.split(" | el ").next().unwrap_or("").to_string();
        if key != last {
            println!("{line}");
            last = key;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    Ok(())
}

#[cfg(windows)]
fn process_exe_name(pid: u32) -> String {
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if h.is_null() {
            return format!("pid{pid}");
        }
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) != 0;
        CloseHandle(h);
        if !ok {
            return format!("pid{pid}");
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit('\\').next().unwrap_or(&path).to_string()
    }
}

#[cfg(not(windows))]
fn main() {}
