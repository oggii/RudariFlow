//! PDF export: the export's HTML in a hidden webview window, printed with
//! WebView2's PrintToPdf. The page goes through a temporary file, since
//! NavigateToString is limited to 2 MB.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::time::Duration;

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

use crate::export::Paper;

const WINDOW: &str = "pdf-export";
static BUSY: AtomicBool = AtomicBool::new(false);

/// Print `html` to a PDF at `path`.
pub async fn print(app: &AppHandle, html: String, paper: Paper, path: PathBuf) -> Result<(), String> {
    if BUSY.swap(true, SeqCst) {
        return Err("busy".to_string());
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            BUSY.store(false, SeqCst);
        }
    }
    let _done = Done;

    let page = std::env::temp_dir().join(format!("rudariflow-export-{}.html", std::process::id()));
    std::fs::write(&page, html).map_err(|e| e.to_string())?;
    let url = tauri::Url::from_file_path(&page).map_err(|_| "bad temporary path".to_string())?;

    let (loaded_tx, loaded_rx) = tokio::sync::oneshot::channel::<()>();
    let loaded_tx = std::sync::Mutex::new(Some(loaded_tx));
    let window = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(url))
        .visible(false)
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if let Some(tx) = loaded_tx.lock().unwrap_or_else(|p| p.into_inner()).take() {
                    let _ = tx.send(());
                }
            }
        })
        .build()
        .map_err(|e| e.to_string())?;

    let result = async {
        tokio::time::timeout(Duration::from_secs(30), loaded_rx)
            .await
            .map_err(|_| "the page did not load".to_string())?
            .map_err(|_| "the page did not load".to_string())?;
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let target = path.clone();
        window
            .with_webview(move |webview| imp::print_to_pdf(&webview, &target, paper, done_tx))
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(180), done_rx)
            .await
            .map_err(|_| "printing took too long".to_string())?
            .map_err(|_| "printing stopped".to_string())?
    }
    .await;
    let _ = window.destroy();
    let _ = std::fs::remove_file(&page);
    result
}

#[cfg(windows)]
mod imp {
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    use tokio::sync::oneshot::Sender;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING};

    use crate::export::Paper;

    /// 20 mm, as the page's @page rule; whichever wins, the margin is the same.
    const MARGIN_INCHES: f64 = 0.787;

    pub fn print_to_pdf(
        webview: &tauri::webview::PlatformWebview,
        path: &Path,
        paper: Paper,
        done: Sender<Result<(), String>>,
    ) {
        let done = Arc::new(Mutex::new(Some(done)));
        let send = {
            let done = done.clone();
            move |result: Result<(), String>| {
                if let Some(tx) = done.lock().unwrap_or_else(|p| p.into_inner()).take() {
                    let _ = tx.send(result);
                }
            }
        };
        let handler_send = send.clone();
        let start = || -> windows::core::Result<()> {
            unsafe {
                let core: ICoreWebView2_7 = webview.controller().CoreWebView2()?.cast()?;
                let environment: ICoreWebView2Environment6 = webview.environment().cast()?;
                let settings = environment.CreatePrintSettings()?;
                let (width, height) = paper.inches();
                settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
                settings.SetPageWidth(width)?;
                settings.SetPageHeight(height)?;
                settings.SetMarginTop(MARGIN_INCHES)?;
                settings.SetMarginBottom(MARGIN_INCHES)?;
                settings.SetMarginLeft(MARGIN_INCHES)?;
                settings.SetMarginRight(MARGIN_INCHES)?;
                settings.SetShouldPrintBackgrounds(true)?;
                settings.SetShouldPrintHeaderAndFooter(false)?;
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                    handler_send(match (result, ok) {
                        (Ok(()), true) => Ok(()),
                        (Err(e), _) => Err(e.message().to_string()),
                        (Ok(()), false) => Err("the PDF could not be written".to_string()),
                    });
                    Ok(())
                }));
                core.PrintToPdf(&HSTRING::from(path.as_os_str()), &settings, &handler)
            }
        };
        if let Err(e) = start() {
            send(Err(e.message().to_string()));
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn print_to_pdf(
        _webview: &tauri::webview::PlatformWebview,
        _path: &std::path::Path,
        _paper: crate::export::Paper,
        done: tokio::sync::oneshot::Sender<Result<(), String>>,
    ) {
        let _ = done.send(Err("PDF export needs Windows".to_string()));
    }
}
