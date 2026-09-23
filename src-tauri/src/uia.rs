//! The UI Automation client shared by Edit mode (`selection.rs`) and screen
//! context (`screen_context.rs`), one per thread.

#[cfg(windows)]
mod imp {
    use std::cell::RefCell;
    use windows::core::Interface;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation, IUIAutomation2};

    /// Calls into an app that hangs give up after this long.
    const TIMEOUT_MS: u32 = 500;

    thread_local! {
        static AUTOMATION: RefCell<Option<IUIAutomation>> = const { RefCell::new(None) };
    }

    pub fn automation() -> Option<IUIAutomation> {
        AUTOMATION.with(|cell| {
            if let Some(uia) = cell.borrow().as_ref() {
                return Some(uia.clone());
            }
            // S_FALSE when this thread already joined the MTA; an STA thread
            // (RPC_E_CHANGED_MODE) can still create the object.
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            let uia: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.ok()?;
            if let Ok(uia2) = uia.cast::<IUIAutomation2>() {
                unsafe {
                    let _ = uia2.SetConnectionTimeout(TIMEOUT_MS);
                    let _ = uia2.SetTransactionTimeout(TIMEOUT_MS);
                }
            }
            *cell.borrow_mut() = Some(uia.clone());
            Some(uia)
        })
    }
}

#[cfg(windows)]
pub use imp::automation;
