#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use rudariflow_lib::audio;
use rudariflow_lib::downloader;
use rudariflow_lib::recorder::{Recorder, RecordingState};
use rudariflow_lib::settings::Settings;
use rudariflow_lib::transcribe_local;

struct AppState {
    recorder: Recorder,
    settings: Mutex<Settings>,
    app_dir: PathBuf,
}

fn get_app_dir() -> PathBuf {
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
    let backend_changed = {
        let prev = state.settings.lock().unwrap();
        prev.gpu_backend != settings.gpu_backend
    };
    *state.settings.lock().unwrap() = settings;
    if backend_changed {
        transcribe_local::clear_backend_cache();
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
    let model_file = transcribe_local::model_filename(&model_size);
    state.app_dir.join(&model_file).exists()
}

#[tauri::command]
async fn download_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    model_size: String,
) -> Result<(), String> {
    let url = transcribe_local::model_download_url(&model_size);
    let model_file = transcribe_local::model_filename(&model_size);
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

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn change_hotkey(
    app: tauri::AppHandle,
    state: State<AppState>,
    new_hotkey: String,
) -> Result<(), String> {
    let current = state.settings.lock().unwrap().hotkey.clone();
    let gs = app.global_shortcut();
    let _ = gs.unregister(current.as_str());
    register_hotkey(&app, &new_hotkey)?;
    let mut settings = state.settings.lock().unwrap();
    settings.hotkey = new_hotkey;
    settings.save(&state.app_dir)?;
    Ok(())
}

fn register_hotkey(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let handle = app.clone();
    println!("[RudariFlow] Registering global shortcut: {}", hotkey);
    app.global_shortcut()
        .on_shortcut(hotkey, move |_app, shortcut, event| {
            println!(
                "[RudariFlow] Hotkey event: {:?} state={:?}",
                shortcut, event.state
            );
            let handle = handle.clone();
            let state = handle.state::<AppState>();
            let mode = state.settings.lock().unwrap().recording_mode.clone();
            println!("[RudariFlow] Recording mode: {}", mode);

            match event.state {
                ShortcutState::Pressed => {
                    tauri::async_runtime::spawn(async move {
                        let state = handle.state::<AppState>();
                        match mode.as_str() {
                            "toggle" => match do_toggle_recording(&handle, state.inner()).await {
                                Ok(result) => println!("[RudariFlow] Toggle result: {}", result),
                                Err(e) => eprintln!("[RudariFlow] Toggle error: {}", e),
                            },
                            "push-to-talk" => {
                                let current = state.recorder.get_state();
                                println!("[RudariFlow] PTT mode, current state: {:?}", current);
                                if current == RecordingState::Ready {
                                    let mic = state.settings.lock().unwrap().microphone.clone();
                                    match state.recorder.start_recording(&handle, &mic) {
                                        Ok(_) => println!("[RudariFlow] Recording started"),
                                        Err(e) => eprintln!("[RudariFlow] Start recording error: {}", e),
                                    }
                                }
                            }
                            _ => {}
                        }
                    });
                }
                ShortcutState::Released => {
                    if mode == "push-to-talk" {
                        tauri::async_runtime::spawn(async move {
                            let state = handle.state::<AppState>();
                            let current = state.recorder.get_state();
                            if current == RecordingState::Recording {
                                let settings = state.settings.lock().unwrap().clone();
                                match state
                                    .recorder
                                    .stop_and_transcribe(&handle, &settings, &state.app_dir)
                                    .await
                                {
                                    Ok(result) => println!("[RudariFlow] Transcription: {}", result),
                                    Err(e) => eprintln!("[RudariFlow] Transcription error: {}", e),
                                }
                            }
                        });
                    }
                }
            }
        })
        .map_err(|e| {
            let msg = format!("Failed to register hotkey '{}': {}", hotkey, e);
            eprintln!("[RudariFlow] {}", msg);
            msg
        })
}

/// Shared logic for toggle recording, used by both the Tauri command and hotkey handler.
async fn do_toggle_recording(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<String, String> {
    let current_state = state.recorder.get_state();
    match current_state {
        RecordingState::Ready => {
            let mic = state.settings.lock().unwrap().microphone.clone();
            state.recorder.start_recording(app, &mic)?;
            Ok("recording".to_string())
        }
        RecordingState::Recording => {
            let settings = state.settings.lock().unwrap().clone();
            let result = state
                .recorder
                .stop_and_transcribe(app, &settings, &state.app_dir)
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
    let settings = Settings::load(&app_dir);
    let initial_hotkey = settings.hotkey.clone();
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
            set_autostart,
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
            // If launched at login (autostart adds --start-minimized), keep the main
            // window hidden so the app lives in the tray. Otherwise show it normally.
            let started_minimized = std::env::args().any(|a| a == "--start-minimized");
            if let Some(main_window) = app.get_webview_window("main") {
                if started_minimized {
                    println!("[RudariFlow] Started minimized (autostart) — staying in tray");
                } else {
                    let _ = main_window.show();
                    let _ = main_window.set_focus();
                }
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

            if let Err(e) = register_hotkey(app.handle(), &initial_hotkey) {
                eprintln!("[RudariFlow] ERROR: {}", e);
            }

            // Sync persisted autostart preference with the OS.
            let autolaunch = app.autolaunch();
            match autolaunch.is_enabled() {
                Ok(actual) if actual != initial_autostart => {
                    let r = if initial_autostart {
                        autolaunch.enable()
                    } else {
                        autolaunch.disable()
                    };
                    if let Err(e) = r {
                        eprintln!("[RudariFlow] Autostart sync failed: {}", e);
                    } else {
                        println!("[RudariFlow] Autostart synced to {}", initial_autostart);
                    }
                }
                Ok(_) => {}
                Err(e) => eprintln!("[RudariFlow] Autostart query failed: {}", e),
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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
