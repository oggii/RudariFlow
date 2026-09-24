//! Spike: how fast UI Automation gives the visible text of the window the
//! user is in, and what it contains. Waits `<delay>` seconds (switch to the
//! app), then reads once and prints timings and the start of the text.
//! `cargo run --release --example screen_probe -- <delay> [chars]`
#[cfg(windows)]
fn main() -> windows::core::Result<()> {
    use std::time::{Duration, Instant};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::*;

    let delay: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(3);
    let show: usize = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(600);
    std::thread::sleep(Duration::from_secs(delay));
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
    let uia: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)? };
    unsafe {
        let t0 = Instant::now();
        let focused = uia.GetFocusedElement()?;
        let walker = uia.ControlViewWalker()?;
        let root = uia.GetRootElement()?;

        // 1. The nearest ancestor (or self) with a text pattern that is a
        //    document or page: its visible ranges.
        let mut el = focused.clone();
        let mut doc_text = None;
        for depth in 0..40 {
            let ct = el.CurrentControlType().map(|c| c.0).unwrap_or(0);
            if ct == 50030 {
                if let Ok(tp) = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
                    let t = Instant::now();
                    let mut text = String::new();
                    if let Ok(ranges) = tp.GetVisibleRanges() {
                        for i in 0..ranges.Length().unwrap_or(0) {
                            if let Ok(r) = ranges.GetElement(i) {
                                text.push_str(&r.GetText(20_000).map(|b| b.to_string()).unwrap_or_default());
                                text.push('\n');
                            }
                        }
                    }
                    let name = el.CurrentName().map(|b| b.to_string()).unwrap_or_default();
                    println!(
                        "[1] document at depth {depth} {:?}: {} chars visible in {} ms",
                        name.chars().take(50).collect::<String>(),
                        text.chars().count(),
                        t.elapsed().as_millis()
                    );
                    doc_text = Some(text);
                    break;
                }
            }
            match walker.GetParentElement(&el) {
                Ok(parent) if !uia.CompareElements(&parent, &root).map(|b| b.as_bool()).unwrap_or(true) => el = parent,
                _ => break,
            }
        }
        if doc_text.is_none() {
            println!("[1] no document with a text pattern above the focus");
        }

        // The top-level window of the focus.
        let mut top = focused.clone();
        while let Ok(parent) = walker.GetParentElement(&top) {
            if uia.CompareElements(&parent, &root).map(|b| b.as_bool()).unwrap_or(true) {
                break;
            }
            top = parent;
        }
        let title = top.CurrentName().map(|b| b.to_string()).unwrap_or_default();

        // 2. Names of all text elements in the window, capped.
        let t = Instant::now();
        let cond = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_TextControlTypeId.0))?;
        let request = uia.CreateCacheRequest()?;
        request.AddProperty(UIA_NamePropertyId)?;
        request.AddProperty(UIA_IsOffscreenPropertyId)?;
        let found = top.FindAllBuildCache(TreeScope_Descendants, &cond, &request)?;
        let n = found.Length().unwrap_or(0);
        let mut labels = String::new();
        let mut offscreen = 0;
        for i in 0..n.min(2000) {
            if let Ok(e) = found.GetElement(i) {
                if e.CachedIsOffscreen().map(|b| b.as_bool()).unwrap_or(false) {
                    offscreen += 1;
                    continue;
                }
                let name = e.CachedName().map(|b| b.to_string()).unwrap_or_default();
                if !name.trim().is_empty() {
                    labels.push_str(name.trim());
                    labels.push('\n');
                }
            }
        }
        println!(
            "[2] window {:?}: {n} text elements ({offscreen} offscreen), {} chars on screen in {} ms",
            title.chars().take(60).collect::<String>(),
            labels.chars().count(),
            t.elapsed().as_millis()
        );
        println!("total {} ms", t0.elapsed().as_millis());
        if let Some(text) = doc_text {
            println!("--- [1] start:\n{}", text.chars().take(show).collect::<String>());
        }
        println!("--- [2] start:\n{}", labels.chars().take(show).collect::<String>());
    }
    Ok(())
}

#[cfg(not(windows))]
fn main() {}
