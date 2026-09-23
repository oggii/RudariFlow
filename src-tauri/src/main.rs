#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use rudariflow_lib::audio;
use rudariflow_lib::cleanup::cleanup_text;
use rudariflow_lib::downloader;
use rudariflow_lib::history::{self, History, HistoryEntry};
use rudariflow_lib::mouse_hotkey;
use rudariflow_lib::paste::paste_text;
use rudariflow_lib::recorder::{model_label, transcribe_samples, Recorder, RecordingState};
use rudariflow_lib::replacements::apply_replacements;
use rudariflow_lib::send_command::strip_send_command;
use rudariflow_lib::settings::Settings;
use rudariflow_lib::startup_log;
use rudariflow_lib::whisper_engine::WhisperEngine;

struct AppState {
    recorder: Recorder,
    settings: Mutex<Settings>,
    app_dir: PathBuf,
    whisper_engine: Arc<WhisperEngine>,
    history: Arc<History>,
}

/// What a global hotkey does.
#[derive(Clone, Copy, PartialEq, Debug)]
enum HotkeyAction {
    /// Start / stop dictation (the main hotkey, keyboard or mouse button).
    Dictation,
    /// Paste the last transcript again (keyboard chords only).
    PasteLast,
}

impl HotkeyAction {
    fn from_target(target: &str) -> Result<Self, String> {
        match target {
            "dictation" => Ok(Self::Dictation),
            "pasteLast" => Ok(Self::PasteLast),
            _ => Err(format!("Unknown hotkey target: {}", target)),
        }
    }
}

/// Settings, models and history. `RUDARIFLOW_DATA_DIR` points a test build at
/// a separate folder, so it never touches the installed app's data.
fn get_app_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("RUDARIFLOW_DATA_DIR") {
        return PathBuf::from(dir);
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.rudariflow.app")
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(state: State<AppState>, settings: Settings) -> Result<(), String> {
    settings.save(&state.app_dir)?;
    let engine_invalidate = {
        let prev = state.settings.lock().unwrap();
        prev.gpu_backend != settings.gpu_backend
            || prev.whisper_model != settings.whisper_model
    };
    *state.settings.lock().unwrap() = settings;
    if engine_invalidate {
        state.whisper_engine.invalidate();
    }
    Ok(())
}

#[tauri::command]
fn list_microphones() -> Vec<audio::MicDevice> {
    audio::list_microphones()
}

#[tauri::command]
fn get_recording_state(state: State<AppState>) -> RecordingState {
    state.recorder.get_state()
}

#[tauri::command]
fn check_model_downloaded(state: State<AppState>, model_size: String) -> bool {
    let model_file = rudariflow_lib::whisper_engine::model_filename(&model_size);
    state.app_dir.join(&model_file).exists()
}

#[tauri::command]
async fn download_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    model_size: String,
) -> Result<(), String> {
    let url = rudariflow_lib::whisper_engine::model_download_url(&model_size);
    let model_file = rudariflow_lib::whisper_engine::model_filename(&model_size);
    let dest = state.app_dir.join(&model_file);
    downloader::download_model(app, &url, &dest).await
}

#[tauri::command]
async fn toggle_recording(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    do_toggle_recording(&app, &state).await
}

#[tauri::command]
fn cancel_recording(
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    state.recorder.cancel_recording(&app)
}

/// GPUs whisper.cpp can use, for the settings hint. Async so backend
/// initialisation (CUDA / Vulkan device probing) stays off the main thread.
#[tauri::command]
async fn detect_gpus() -> Vec<rudariflow_lib::whisper_engine::GpuDevice> {
    tauri::async_runtime::spawn_blocking(rudariflow_lib::whisper_engine::list_gpu_devices)
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn history_list(state: State<AppState>) -> Vec<HistoryEntry> {
    state.history.list()
}

#[tauri::command]
fn history_delete(state: State<AppState>, id: u64) {
    state.history.delete(id);
}

#[tauri::command]
fn history_clear(state: State<AppState>) {
    state.history.clear();
}

/// The recording of a history entry as WAV bytes, for playback in the UI.
#[tauri::command]
fn history_audio(state: State<AppState>, id: u64) -> Result<tauri::ipc::Response, String> {
    let bytes = std::fs::read(state.history.audio_path(id)).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Transcribe a history recording again with the current engine and model,
/// e.g. after switching to a larger model. Nothing is pasted.
#[tauri::command]
async fn history_rerun(state: State<'_, AppState>, id: u64) -> Result<HistoryEntry, String> {
    let entry = state.history.get(id).ok_or("History entry not found")?;
    if !entry.has_audio {
        return Err("This entry has no recording".to_string());
    }
    let samples = history::read_wav(&state.history.audio_path(id))?;
    let settings = state.settings.lock().unwrap().clone();
    let raw = transcribe_samples(None, &settings, &state.app_dir, &state.whisper_engine, &samples)
        .await?;
    let cleaned = cleanup_text(&raw);
    let text = strip_send_command(&cleaned).unwrap_or(cleaned);
    let text = apply_replacements(&text, &settings.replacements);
    state
        .history
        .update_text(id, &text, &model_label(&settings))
        .ok_or_else(|| "History entry not found".to_string())
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut cb| cb.set_text(text))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn diag_log(source: String, message: String) {
    startup_log::log(&format!("[{}] {}", source, message));
}

fn running_from_debug_build() -> bool {
    let exe = std::env::current_exe().unwrap_or_default();
    let path_str = exe.to_string_lossy().to_lowercase();
    path_str.contains("\\target\\debug\\") || path_str.contains("/target/debug/")
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if enabled && running_from_debug_build() {
        return Err(
            "Refusing to register autostart from a debug build. Install the production build first."
                .to_string(),
        );
    }
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
}

/// `target` is "dictation" or "pasteLast". An empty `new_hotkey` turns the
/// paste-last hotkey off; dictation always needs one.
#[tauri::command]
fn change_hotkey(
    app: tauri::AppHandle,
    state: State<AppState>,
    target: String,
    new_hotkey: String,
) -> Result<(), String> {
    let action = HotkeyAction::from_target(&target)?;
    let (current, other) = {
        let s = state.settings.lock().unwrap();
        match action {
            HotkeyAction::Dictation => (s.hotkey.clone(), s.paste_last_hotkey.clone()),
            HotkeyAction::PasteLast => (s.paste_last_hotkey.clone(), s.hotkey.clone()),
        }
    };
    if new_hotkey.is_empty() && action == HotkeyAction::Dictation {
        return Err("The dictation hotkey cannot be empty".to_string());
    }
    if !new_hotkey.is_empty() && new_hotkey.eq_ignore_ascii_case(&other) {
        return Err(format!("'{}' is already used by the other hotkey", new_hotkey));
    }
    if action == HotkeyAction::PasteLast && mouse_hotkey::parse(&new_hotkey).is_some() {
        return Err("Mouse buttons can only start dictation".to_string());
    }
    if new_hotkey != current {
        // Register the new chord before dropping the old one, so a rejected
        // chord (invalid name, taken by another app) leaves the old one working.
        if !new_hotkey.is_empty() {
            register_hotkey(&app, &new_hotkey, action)?;
        }
        if !current.is_empty() {
            unregister_hotkey(&app, &current);
        }
    } else if !new_hotkey.is_empty() && !hotkey_is_registered(&app, &current) {
        register_hotkey(&app, &new_hotkey, action)?;
    }
    startup_log::log(&format!("[hotkey] {:?} changed {} -> {}", action, current, new_hotkey));
    let mut settings = state.settings.lock().unwrap();
    match action {
        HotkeyAction::Dictation => settings.hotkey = new_hotkey,
        HotkeyAction::PasteLast => settings.paste_last_hotkey = new_hotkey,
    }
    settings.save(&state.app_dir)?;
    Ok(())
}

/// Temporarily release the global hotkeys while the settings UI captures a
/// new chord; a registered chord never reaches the webview as a keydown.
#[tauri::command]
fn set_hotkey_paused(
    app: tauri::AppHandle,
    state: State<AppState>,
    paused: bool,
) -> Result<(), String> {
    let (dictation, paste_last) = {
        let s = state.settings.lock().unwrap();
        (s.hotkey.clone(), s.paste_last_hotkey.clone())
    };
    let mut result = Ok(());
    for (hotkey, action) in [
        (dictation, HotkeyAction::Dictation),
        (paste_last, HotkeyAction::PasteLast),
    ] {
        if hotkey.is_empty() {
            continue;
        }
        if paused {
            unregister_hotkey(&app, &hotkey);
        } else if !hotkey_is_registered(&app, &hotkey) {
            if let Err(e) = register_hotkey(&app, &hotkey, action) {
                // A paste-last chord taken by another app must not block the
                // dictation hotkey; it is logged by register_hotkey.
                if action == HotkeyAction::Dictation {
                    result = Err(e);
                }
            }
        }
    }
    result
}

fn on_hotkey_event(handle: &AppHandle, action: HotkeyAction, pressed: bool) {
    match action {
        HotkeyAction::Dictation => on_hotkey(handle, pressed),
        HotkeyAction::PasteLast if pressed => paste_last_transcript(handle),
        HotkeyAction::PasteLast => {}
    }
}

/// Paste the last transcript into the focused app again.
fn paste_last_transcript(handle: &AppHandle) {
    let history = handle.state::<AppState>().history.clone();
    tauri::async_runtime::spawn_blocking(move || match history.last_text() {
        Some(text) => {
            if let Err(e) = paste_text(&text) {
                startup_log::log(&format!("[paste-last] {}", e));
            }
        }
        None => startup_log::log("[paste-last] nothing to paste yet"),
    });
}

/// Keyboard chords go through the global-shortcut plugin; mouse side buttons
/// (`Mouse4`, `Mouse5`, optionally with modifiers) through a mouse hook.
fn register_hotkey(app: &AppHandle, hotkey: &str, action: HotkeyAction) -> Result<(), String> {
    startup_log::log(&format!("[hotkey] registering {} for {:?}", hotkey, action));
    if let Some(binding) = mouse_hotkey::parse(hotkey) {
        let handle = app.clone();
        let label = hotkey.to_string();
        return mouse_hotkey::register(
            binding,
            Box::new(move |pressed| {
                startup_log::log(&format!(
                    "[hotkey] {} {}",
                    label,
                    if pressed { "Pressed" } else { "Released" }
                ));
                on_hotkey_event(&handle, action, pressed);
            }),
        )
        .map_err(|e| {
            let msg = format!("Failed to register hotkey '{}': {}", hotkey, e);
            startup_log::log(&format!("[hotkey] {}", msg));
            msg
        });
    }

    let handle = app.clone();
    app.global_shortcut()
        .on_shortcut(hotkey, move |_app, shortcut, event| {
            startup_log::log(&format!(
                "[hotkey] {} {:?}",
                shortcut.into_string(),
                event.state
            ));
            on_hotkey_event(&handle, action, event.state == ShortcutState::Pressed);
        })
        .map_err(|e| {
            let msg = format!("Failed to register hotkey '{}': {}", hotkey, e);
            startup_log::log(&format!("[hotkey] {}", msg));
            msg
        })
}

fn unregister_hotkey(app: &AppHandle, hotkey: &str) {
    match mouse_hotkey::parse(hotkey) {
        Some(binding) => mouse_hotkey::unregister(binding),
        None => {
            let _ = app.global_shortcut().unregister(hotkey);
        }
    }
}

fn hotkey_is_registered(app: &AppHandle, hotkey: &str) -> bool {
    match mouse_hotkey::parse(hotkey) {
        Some(binding) => mouse_hotkey::is_registered(binding),
        None => app.global_shortcut().is_registered(hotkey),
    }
}

/// Shared press/release handling for keyboard and mouse hotkeys.
fn on_hotkey(handle: &AppHandle, pressed: bool) {
    let handle = handle.clone();
    let state = handle.state::<AppState>();
    let mode = state.settings.lock().unwrap().recording_mode.clone();
    println!("[RudariFlow] Recording mode: {}", mode);

    if pressed {
        tauri::async_runtime::spawn(async move {
            let state = handle.state::<AppState>();
            // Background warmup: kick off model load in parallel
            // with audio capture. Single-flight via the engine's
            // mutex; ignores errors here — they surface at
            // transcription time.
            let s = state.settings.lock().unwrap().clone();
            if s.engine == "local" {
                let model_path = state
                    .app_dir
                    .join(rudariflow_lib::whisper_engine::model_filename(
                        &s.whisper_model,
                    ));
                if model_path.exists() {
                    let engine = state.whisper_engine.clone();
                    let backend = s.gpu_backend.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Err(e) = engine.ensure_loaded(&model_path, &backend) {
                            eprintln!("[RudariFlow] warmup failed: {}", e);
                        }
                    });
                }
            }
            match mode.as_str() {
                "toggle" => match do_toggle_recording(&handle, state.inner()).await {
                    Ok(result) => println!("[RudariFlow] Toggle result: {}", result),
                    Err(e) => startup_log::log(&format!("[hotkey] toggle error: {}", e)),
                },
                "push-to-talk" => {
                    let current = state.recorder.get_state();
                    println!("[RudariFlow] PTT mode, current state: {:?}", current);
                    if current == RecordingState::Ready {
                        let (mic, mute) = {
                            let s = state.settings.lock().unwrap();
                            (s.microphone.clone(), s.mute_audio)
                        };
                        match state.recorder.start_recording(&handle, &mic, mute) {
                            Ok(_) => println!("[RudariFlow] Recording started"),
                            Err(e) => startup_log::log(&format!("[hotkey] start error: {}", e)),
                        }
                    }
                }
                _ => {}
            }
        });
    } else if mode == "push-to-talk" {
        tauri::async_runtime::spawn(async move {
            let state = handle.state::<AppState>();
            let current = state.recorder.get_state();
            if current == RecordingState::Recording {
                let settings = state.settings.lock().unwrap().clone();
                match state
                    .recorder
                    .stop_and_transcribe(
                        &handle,
                        &settings,
                        &state.app_dir,
                        &state.whisper_engine,
                        &state.history,
                    )
                    .await
                {
                    Ok(result) => println!("[RudariFlow] Transcription: {}", result),
                    Err(e) => eprintln!("[RudariFlow] Transcription error: {}", e),
                }
            }
        });
    }
}

/// Shared logic for toggle recording, used by both the Tauri command and hotkey handler.
async fn do_toggle_recording(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<String, String> {
    let current_state = state.recorder.get_state();
    match current_state {
        RecordingState::Ready => {
            let (mic, mute) = {
                let s = state.settings.lock().unwrap();
                (s.microphone.clone(), s.mute_audio)
            };
            state.recorder.start_recording(app, &mic, mute)?;
            Ok("recording".to_string())
        }
        RecordingState::Recording => {
            let settings = state.settings.lock().unwrap().clone();
            let result = state
                .recorder
                .stop_and_transcribe(
                    app,
                    &settings,
                    &state.app_dir,
                    &state.whisper_engine,
                    &state.history,
                )
                .await?;
            Ok(result)
        }
        RecordingState::Transcribing => {
            Err("Currently transcribing, please wait".to_string())
        }
    }
}

fn main() {
    let app_dir = get_app_dir();
    startup_log::init(&app_dir);
    let settings = Settings::load(&app_dir);
    startup_log::log("settings loaded");
    let history = Arc::new(History::load(&app_dir));
    let initial_hotkey = settings.hotkey.clone();
    let initial_paste_last_hotkey = settings.paste_last_hotkey.clone();
    let initial_autostart = settings.autostart;

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--start-minimized"]),
        ))
        .manage(AppState {
            recorder: Recorder::new(),
            settings: Mutex::new(settings),
            app_dir,
            whisper_engine: Arc::new(WhisperEngine::new()),
            history,
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            list_microphones,
            get_recording_state,
            check_model_downloaded,
            download_model,
            toggle_recording,
            cancel_recording,
            change_hotkey,
            set_hotkey_paused,
            set_autostart,
            detect_gpus,
            history_list,
            history_delete,
            history_clear,
            history_audio,
            history_rerun,
            copy_text,
            diag_log,
        ])
        .on_window_event(|window, event| {
            // Close button (X) on the main window hides to tray instead of quitting.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .setup(move |app| {
            startup_log::log("setup() entered");
            // The CUDA runtime and Vulkan loader DLLs are load-time imports and
            // are installed next to rudariflow.exe (see tauri.conf.json).
            if let Ok(rd) = app.path().resource_dir() {
                startup_log::log(&format!("resource_dir: {:?}", rd));
            } else {
                startup_log::log("resource_dir: <unresolved>");
            }

            // If launched at login (autostart adds --start-minimized), keep the main
            // window hidden so the app lives in the tray. Otherwise show it normally.
            let started_minimized = std::env::args().any(|a| a == "--start-minimized");
            startup_log::log(&format!("started_minimized: {}", started_minimized));
            if let Some(main_window) = app.get_webview_window("main") {
                startup_log::log("main window handle obtained");
                // Listen for webview load errors / page-failed-to-load events.
                let mw_for_listener = main_window.clone();
                main_window.on_window_event(move |ev| {
                    startup_log::log(&format!("[main window event] {:?}", ev));
                    let _ = &mw_for_listener;
                });
                if started_minimized {
                    startup_log::log("autostart: keeping main hidden");
                } else {
                    startup_log::log("showing main window");
                    if let Err(e) = main_window.show() {
                        startup_log::log(&format!("main_window.show() failed: {}", e));
                    }
                    if let Err(e) = main_window.set_focus() {
                        startup_log::log(&format!("main_window.set_focus() failed: {}", e));
                    }
                }
            } else {
                startup_log::log("ERROR: no main window handle from get_webview_window(\"main\")");
            }

            // Bottom-center recording pill: hidden by default, shown while recording.
            let monitor = app.primary_monitor().ok().flatten();
            let (overlay_w, overlay_h) = (320.0_f64, 64.0_f64);
            let (x, y) = if let Some(m) = monitor {
                let size = m.size();
                let scale = m.scale_factor();
                let logical_w = size.width as f64 / scale;
                let logical_h = size.height as f64 / scale;
                (
                    ((logical_w - overlay_w) / 2.0) as i32,
                    (logical_h - overlay_h - 60.0) as i32,
                )
            } else {
                (800, 900)
            };

            let overlay = WebviewWindowBuilder::new(
                app,
                "overlay",
                WebviewUrl::App("src/overlay.html".into()),
            )
            .title("")
            .inner_size(overlay_w, overlay_h)
            .position(x as f64, y as f64)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .shadow(false)
            .visible(false)
            .build();

            match overlay {
                Ok(_) => println!("[RudariFlow] Overlay window created"),
                Err(e) => eprintln!("[RudariFlow] Failed to create overlay: {}", e),
            }

            if let Err(e) = register_hotkey(app.handle(), &initial_hotkey, HotkeyAction::Dictation) {
                eprintln!("[RudariFlow] ERROR: {}", e);
                // A saved chord that no longer registers would leave the app
                // with no hotkey at all; fall back to the default chord.
                let default_hotkey = Settings::default().hotkey;
                if initial_hotkey != default_hotkey
                    && register_hotkey(app.handle(), &default_hotkey, HotkeyAction::Dictation).is_ok()
                {
                    let state = app.state::<AppState>();
                    let mut settings = state.settings.lock().unwrap();
                    settings.hotkey = default_hotkey;
                    let _ = settings.save(&state.app_dir);
                }
            }

            // Paste-last is optional: if another app owns the chord, the
            // setting stays and the failure is in startup.log.
            if !initial_paste_last_hotkey.is_empty() {
                let _ = register_hotkey(
                    app.handle(),
                    &initial_paste_last_hotkey,
                    HotkeyAction::PasteLast,
                );
            }

            // Sync persisted autostart preference with the OS — but never
            // register a debug build at autostart (would point Windows at a
            // dev-only exe whose webview tries to load the Vite dev server).
            let is_debug = running_from_debug_build();
            startup_log::log(&format!("running_from_debug_build: {}", is_debug));
            if is_debug && initial_autostart {
                startup_log::log(
                    "Skipping autostart registration: running from debug build path",
                );
            } else {
                let autolaunch = app.autolaunch();
                match autolaunch.is_enabled() {
                    Ok(actual) if actual != initial_autostart => {
                        let r = if initial_autostart {
                            autolaunch.enable()
                        } else {
                            autolaunch.disable()
                        };
                        if let Err(e) = r {
                            startup_log::log(&format!("Autostart sync failed: {}", e));
                        } else {
                            startup_log::log(&format!(
                                "Autostart synced to {}",
                                initial_autostart
                            ));
                        }
                    }
                    Ok(_) => {}
                    Err(e) => startup_log::log(&format!("Autostart query failed: {}", e)),
                }
            }

            // System tray.
            let show_item = MenuItem::with_id(app, "show", "Show RudariFlow", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("RudariFlow")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            startup_log::log("setup() completed successfully");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
