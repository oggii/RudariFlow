#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_window_state::AppHandleExt;

use rudariflow_lib::ai_cleanup::AppContext;
use rudariflow_lib::ai_models;
use rudariflow_lib::audio;
use rudariflow_lib::cleanup::cleanup_text;
use rudariflow_lib::dictionary;
use rudariflow_lib::downloader;
use rudariflow_lib::foreground_app;
use rudariflow_lib::history::{self, History, HistoryEntry};
use rudariflow_lib::llm_server::{self, LlmServer, ServerStatus};
use rudariflow_lib::mouse_hotkey;
use rudariflow_lib::paste::paste_text;
use rudariflow_lib::polish::{self, polish, Polished};
use rudariflow_lib::power::{self, GpuToggle};
use rudariflow_lib::recorder::{model_label, transcribe_samples, Recorder, RecordingState};
use rudariflow_lib::send_command::strip_send_command;
use rudariflow_lib::settings::Settings;
use rudariflow_lib::startup_log;
use rudariflow_lib::voice_edit::{self, Edit};
use rudariflow_lib::whisper_engine::WhisperEngine;
use rudariflow_lib::{ai_cleanup, file_transcribe, media, screen_context};
use rudariflow_lib::soundboard::library::{Board, Devices};
use rudariflow_lib::soundboard::{self, engine, AddResult, BoardState, Soundboard, Status};
use rudariflow_lib::meeting::{self, Meetings};

/// One file is transcribed at a time; setting the flag stops it after the
/// block that is running.
static FILE_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static FILE_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

struct AppState {
    recorder: Recorder,
    settings: Mutex<Settings>,
    app_dir: PathBuf,
    whisper_engine: Arc<WhisperEngine>,
    history: Arc<History>,
    /// The AI cleanup model server.
    llm: Arc<LlmServer>,
    /// Id of the AI model being downloaded, if any.
    ai_download: Mutex<Option<String>>,
    /// Last hotkey press or recording start, for unloading on battery.
    last_activity: Mutex<std::time::Instant>,
    /// The Free GPU hotkey (see `free_gpu_press`).
    gpu: GpuFree,
    /// The soundboard (library, engine while on).
    soundboard: Arc<Soundboard>,
    /// Meeting mode: the meeting that records, the ones finishing, ▶.
    meetings: Arc<Meetings>,
}

/// State of the Free GPU hotkey.
#[derive(Default)]
struct GpuFree {
    /// The last press freed the GPU; a press that loads clears it.
    freed: AtomicBool,
    /// Counts presses, so a load that a newer press overtook shows no notice.
    press: AtomicU64,
    /// Presses run one after the other.
    ops: tokio::sync::Mutex<()>,
}

/// On battery, free the GPU after `power::IDLE_UNLOAD` without dictation
/// (about 5 GB of video memory and 3 GB of RAM with the default models), so
/// a laptop's graphics card can sleep. The next hotkey press loads both
/// again while the user speaks. Not while a meeting records or runs its end
/// steps: its live text would pause until Stop, and its notes would fail.
fn watch_idle_on_battery(handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let state = handle.state::<AppState>();
            let on_battery = power::on_battery();
            let idle = state.last_activity.lock().unwrap().elapsed();
            let in_meeting = meeting_busy(&state.meetings.status());
            if in_meeting {
                // The idle time counts from the meeting's end.
                *state.last_activity.lock().unwrap() = std::time::Instant::now();
            }
            let busy = in_meeting || state.recorder.get_state() != RecordingState::Ready;
            // Only looked at when it matters: the engine lock waits for a
            // running transcription.
            let loaded = on_battery
                && !busy
                && (state.llm.status() != ServerStatus::Stopped || state.whisper_engine.is_loaded());
            if power::should_unload(on_battery, idle, loaded, busy) {
                state.whisper_engine.invalidate();
                state.llm.stop();
                startup_log::log(&format!(
                    "[power] on battery and idle for {} min: models unloaded",
                    idle.as_secs() / 60
                ));
            }
        }
    });
}

/// Set in `setup`; lets the AI server report status changes to the UI.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Where the bundled llama.cpp server lives: `llama\` next to the exe (the
/// installer's resource folder), or `RUDARIFLOW_LLAMA_DIR` for dev builds.
fn llama_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("RUDARIFLOW_LLAMA_DIR") {
        return PathBuf::from(dir);
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("llama")))
        .unwrap_or_else(|| PathBuf::from("llama"))
}

/// The selected AI model's file, if AI cleanup is on and it is downloaded.
fn ai_model_to_run(settings: &Settings, app_dir: &std::path::Path) -> Option<PathBuf> {
    if !settings.ai_cleanup {
        return None;
    }
    let path = ai_models::model_path(app_dir, ai_models::find(&settings.ai_model)?);
    path.exists().then_some(path)
}

/// The Whisper model to load for these settings: local engine and model
/// downloaded.
fn whisper_model_to_load(settings: &Settings, app_dir: &std::path::Path) -> Option<PathBuf> {
    if settings.engine != "local" {
        return None;
    }
    let path = app_dir.join(rudariflow_lib::whisper_engine::model_filename(&settings.whisper_model));
    path.exists().then_some(path)
}

/// Load the Whisper model now instead of at the first dictation. False when
/// a load was tried and failed (the log says why); true when it loaded or
/// the settings load none (Groq, or no model downloaded).
async fn load_whisper(state: &AppState) -> bool {
    let settings = state.settings.lock().unwrap().clone();
    state.whisper_engine.set_flash_attn(settings.flash_attn_pref());
    let Some(model) = whisper_model_to_load(&settings, &state.app_dir) else {
        return true;
    };
    let engine = state.whisper_engine.clone();
    let started = std::time::Instant::now();
    let loaded = tauri::async_runtime::spawn_blocking(move || engine.ensure_loaded(&model, &settings.gpu_backend)).await;
    match loaded {
        Ok(Ok(_)) => {
            startup_log::log(&format!("[engine] ready after {} ms", started.elapsed().as_millis()));
            true
        }
        Ok(Err(e)) => {
            startup_log::log(&format!("[engine] load failed: {}", e));
            false
        }
        Err(e) => {
            startup_log::log(&format!("[engine] load task failed: {}", e));
            false
        }
    }
}

/// Start the AI server in the background when the settings use it.
fn start_ai(state: &AppState) {
    let settings = state.settings.lock().unwrap().clone();
    if let Some(model) = ai_model_to_run(&settings, &state.app_dir) {
        state.llm.warm(model, Some(settings.gpu_backend));
    }
}

/// `start_ai` for background starts (app start, settings, a download), but
/// not while the Free GPU hotkey keeps the AI unloaded: then the next
/// request starts it.
fn warm_ai(state: &AppState) {
    if !state.llm.released() {
        start_ai(state);
    }
}

/// What a global hotkey does.
#[derive(Clone, PartialEq, Debug)]
enum HotkeyAction {
    /// Start / stop dictation (the main hotkey).
    Dictation,
    /// Paste the last transcript again.
    PasteLast,
    /// Select the last dictation and record what to change about it.
    RewriteLast,
    /// Free the GPU, or load the models again (see `free_gpu_press`).
    FreeGpu,
    /// Start a meeting, or stop the one that records (Meetings tab).
    Meeting,
    /// Stop every soundboard sound (registered while the board is on).
    StopSounds,
    /// Turn the sounds' hotkeys off or on again (registered while the board is on).
    ToggleSoundHotkeys,
    /// Play or stop a soundboard sound, by id (registered while the board is on).
    Sound(String),
}

impl HotkeyAction {
    fn from_target(target: &str) -> Result<Self, String> {
        match target {
            "dictation" => Ok(Self::Dictation),
            "pasteLast" => Ok(Self::PasteLast),
            "rewriteLast" => Ok(Self::RewriteLast),
            "freeGpu" => Ok(Self::FreeGpu),
            "meeting" => Ok(Self::Meeting),
            _ => Err(format!("Unknown hotkey target: {}", target)),
        }
    }

    /// The name the UI knows this hotkey by: "dictation", "pasteLast",
    /// "rewriteLast", "freeGpu", "meeting", "stopSounds", "toggleSoundHotkeys",
    /// or the sound's id.
    fn target(&self) -> String {
        match self {
            Self::Dictation => "dictation".to_string(),
            Self::PasteLast => "pasteLast".to_string(),
            Self::RewriteLast => "rewriteLast".to_string(),
            Self::FreeGpu => "freeGpu".to_string(),
            Self::Meeting => "meeting".to_string(),
            Self::StopSounds => "stopSounds".to_string(),
            Self::ToggleSoundHotkeys => "toggleSoundHotkeys".to_string(),
            Self::Sound(id) => id.clone(),
        }
    }
}

/// Every hotkey setting with its action.
fn hotkeys(s: &Settings) -> [(HotkeyAction, String); 5] {
    [
        (HotkeyAction::Dictation, s.hotkey.clone()),
        (HotkeyAction::PasteLast, s.paste_last_hotkey.clone()),
        (HotkeyAction::RewriteLast, s.rewrite_last_hotkey.clone()),
        (HotkeyAction::FreeGpu, s.free_gpu_hotkey.clone()),
        (HotkeyAction::Meeting, s.meeting_hotkey.clone()),
    ]
}

/// The stop-all, toggle and sound hotkeys that are set, also the sounds'
/// while their hotkeys are switched off (they keep their keys): what the
/// conflict check compares with.
fn board_hotkeys(board: &Board) -> Vec<(HotkeyAction, String)> {
    board_hotkeys_with(board, true)
}

/// The board hotkeys to register while the board is on: stop all and the
/// toggle always, the sounds' only while their hotkeys are switched on.
fn active_board_hotkeys(board: &Board) -> Vec<(HotkeyAction, String)> {
    board_hotkeys_with(board, board.sound_hotkeys)
}

fn board_hotkeys_with(board: &Board, sounds: bool) -> Vec<(HotkeyAction, String)> {
    let sounds = board.sounds.iter().filter(|_| sounds);
    [
        (HotkeyAction::StopSounds, board.stop_hotkey.clone()),
        (HotkeyAction::ToggleSoundHotkeys, board.toggle_hotkey.clone()),
    ]
    .into_iter()
    .chain(sounds.map(|s| (HotkeyAction::Sound(s.id.clone()), s.hotkey.clone())))
    .filter(|(_, hotkey)| !hotkey.is_empty())
    .collect()
}

/// Every hotkey: the app's five and the soundboard's.
fn all_hotkeys(settings: &Settings, board: &Board) -> Vec<(HotkeyAction, String)> {
    let mut all = hotkeys(settings).to_vec();
    all.extend(board_hotkeys(board));
    all
}

/// Whether two hotkey strings are the same binding: mouse bindings by
/// button and modifiers, chords by key and modifiers (so "CmdOrCtrl" is
/// "Ctrl", in any order and case), anything else without regard to case.
fn same_hotkey(a: &str, b: &str) -> bool {
    use tauri_plugin_global_shortcut::Shortcut;
    match (mouse_hotkey::parse(a), mouse_hotkey::parse(b)) {
        (Some(a), Some(b)) => return a == b,
        (Some(_), None) | (None, Some(_)) => return false,
        (None, None) => {}
    }
    match (a.parse::<Shortcut>(), b.parse::<Shortcut>()) {
        (Ok(a), Ok(b)) => a.mods == b.mods && a.key == b.key,
        _ => a.eq_ignore_ascii_case(b),
    }
}

/// The action other than `action` that already has `hotkey` (see
/// `same_hotkey`).
fn taken_by(all: &[(HotkeyAction, String)], action: &HotkeyAction, hotkey: &str) -> Option<HotkeyAction> {
    all.iter().find(|(a, h)| a != action && !h.is_empty() && same_hotkey(h, hotkey)).map(|(a, _)| a.clone())
}

/// The app hotkey (dictation, paste last, rewrite last, Free GPU, meeting)
/// that has `hotkey`. A board key never registers over one: a mouse binding would
/// replace its handler, and releasing the board key later would release it.
fn app_hotkey_owner(app: &[(HotkeyAction, String)], hotkey: &str) -> Option<HotkeyAction> {
    app.iter().find(|(_, h)| !h.is_empty() && same_hotkey(h, hotkey)).map(|(a, _)| a.clone())
}

/// Whether a chord with no modifier is a key that may stand alone: the
/// numpad and F1-F24 (Soundpad-like sound and stop-all keys). Not NumpadEnter
/// and NumpadEqual: the hotkey crate registers those as Enter and E.
fn may_stand_alone(key: tauri_plugin_global_shortcut::Code) -> bool {
    let name = format!("{:?}", key);
    (name.starts_with("Numpad") && name != "NumpadEnter" && name != "NumpadEqual")
        || name.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()).is_some_and(|n| (1..=24).contains(&n))
}

/// The owner in an "already used by" error, for the UI to put in words:
/// its target, and for a sound "sound:<name>".
fn owner_label(action: &HotkeyAction, board: &Board) -> String {
    match action {
        HotkeyAction::Sound(id) => format!("sound:{}", board.sound(id).map_or("", |s| s.name.as_str())),
        other => other.target(),
    }
}

/// Whether `hotkey` may become a sound's, stop all's or the toggle's: not a Windows
/// shortcut, a key or side button the hotkey code knows, and no other
/// hotkey's. Empty (off) is always fine. A key alone is allowed only for
/// the numpad and F1-F24 (the settings UI offers that only for the
/// soundboard); a side button keeps the mouse rules.
fn check_board_hotkey(all: &[(HotkeyAction, String)], board: &Board, action: &HotkeyAction, hotkey: &str) -> Result<(), String> {
    if hotkey.is_empty() {
        return Ok(());
    }
    if rudariflow_lib::settings::is_windows_shortcut(hotkey) {
        return Err(format!("'{}' is a Windows shortcut (select all, copy, paste, ...)", hotkey));
    }
    if mouse_hotkey::parse(hotkey).is_none() {
        let Ok(chord) = hotkey.parse::<tauri_plugin_global_shortcut::Shortcut>() else {
            return Err(format!("'{}' is not a valid hotkey", hotkey));
        };
        if chord.mods.is_empty() && !may_stand_alone(chord.key) {
            return Err(format!(
                "'{}' is a key alone; only the numpad and F1-F24 work without Ctrl, Alt, Shift or Win",
                hotkey
            ));
        }
    }
    match taken_by(all, action, hotkey) {
        Some(owner) => Err(format!("'{}' is already used by {}", hotkey, owner_label(&owner, board))),
        None => Ok(()),
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
fn save_settings(app: AppHandle, state: State<AppState>, settings: Settings) -> Result<(), String> {
    settings.save(&state.app_dir)?;
    let (engine_invalidate, ai_restart) = {
        let prev = state.settings.lock().unwrap();
        (
            prev.gpu_backend != settings.gpu_backend
                || prev.whisper_model != settings.whisper_model
                || prev.whisper_flash_attn != settings.whisper_flash_attn,
            prev.ai_cleanup != settings.ai_cleanup || prev.ai_model != settings.ai_model,
        )
    };
    let warm_prompt = polish::system_prompt(&settings);
    let language_changed = state.settings.lock().unwrap().ui_language != settings.ui_language;
    *state.settings.lock().unwrap() = settings;
    if language_changed {
        show_meeting_state(&app, true);
    }
    if engine_invalidate {
        state.whisper_engine.invalidate();
        // Load the new model or backend now, not at the next dictation;
        // after a Free GPU press the next use loads it.
        if !state.whisper_engine.released() {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                load_whisper(app.state::<AppState>().inner()).await;
            });
        }
    }
    if ai_restart {
        state.llm.stop();
        warm_ai(&state);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            if let Some(model) = active_ai_model(state.inner()) {
                fetch_ai_draft(state.inner(), model).await;
            }
        });
    }
    // After a restart the new server picks the prompt up for its warm-up.
    state.llm.set_warm_prompt(warm_prompt);
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
    downloader::download_model(app, &url, &dest, "download-progress").await
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

#[derive(serde::Serialize)]
struct FileTranscript {
    segments: Vec<rudariflow_lib::whisper_engine::Segment>,
    /// Speakers found; 0 when not separated.
    speakers: u8,
    /// Why speakers are missing although asked for: "no_model",
    /// "no_runtime", "none_found" (no voices), "cancelled" (Cancel while
    /// they were separated after Whisper) or an error text.
    #[serde(rename = "speakersError", skip_serializing_if = "Option::is_none")]
    speakers_error: Option<String>,
    language: String,
    #[serde(rename = "durationMs")]
    duration_ms: u64,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
}

/// A "file-progress" event: `phase` "reading", "loading", "transcribing" or
/// "speakers" (for "speakers" `done` is the percent, `total` = 100); `text`
/// is the text of the block just done.
#[derive(Clone, serde::Serialize)]
struct FileProgress {
    phase: &'static str,
    done: u64,
    total: u64,
    text: String,
}

/// Transcribe an audio or video file with the local Whisper model. Progress
/// and the text so far arrive as "file-progress" events. `language` empty =
/// the Engine setting. `speakers` is the Files tab's setting, "off", "auto"
/// or "2" … "8": unless off, the speakers are separated next to Whisper and
/// each segment gets its speaker (or `speakersError` says why not). Errors
/// "busy", "no_model", "no_speech", "cancelled" (Cancel before Whisper is
/// done) are shown by the UI in words.
#[tauri::command]
async fn transcribe_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    language: String,
    speakers: String,
) -> Result<FileTranscript, String> {
    use std::sync::atomic::Ordering::SeqCst;
    if FILE_RUNNING.swap(true, SeqCst) {
        return Err("busy".to_string());
    }
    struct Running;
    impl Drop for Running {
        fn drop(&mut self) {
            FILE_RUNNING.store(false, SeqCst);
        }
    }
    let _running = Running;
    FILE_CANCEL.store(false, SeqCst);
    let settings = state.settings.lock().unwrap().clone();
    let model = state.app_dir.join(rudariflow_lib::whisper_engine::model_filename(&settings.whisper_model));
    if !model.exists() {
        return Err("no_model".to_string());
    }
    let language = if language.trim().is_empty() { settings.language.clone() } else { language };
    let engine = state.whisper_engine.clone();
    let started = std::time::Instant::now();
    let handle = app.clone();
    let worker_settings = settings.clone();
    let (speaker_setting, app_dir) = (speakers, state.app_dir.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let settings = worker_settings;
        let emit = |phase, done, total, text: String| {
            let _ = handle.emit("file-progress", FileProgress { phase, done, total, text });
        };
        let mut last_emit = std::time::Instant::now();
        let audio = media::decode_16k_mono(std::path::Path::new(&path), |done, total| {
            if last_emit.elapsed() >= std::time::Duration::from_millis(100) {
                emit("reading", done, total, String::new());
                last_emit = std::time::Instant::now();
            }
        })?;
        if audio::trim_silence(&audio, 16_000).is_none() {
            return Err("no_speech".to_string());
        }
        let audio = std::sync::Arc::new(audio);

        emit("loading", 0, 1, String::new());
        engine.ensure_loaded(&model, &settings.gpu_backend)?;
        let run = engine.start_file_or_reload(&model, &settings.gpu_backend, &language)?;

        // Speakers: on the CPU while Whisper runs on the GPU. Started once
        // Whisper has loaded, so a failed load leaves nothing running.
        use rudariflow_lib::speakers;
        let mut speakers_error = None;
        let percent = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let separation = match speakers::parse_setting(&speaker_setting) {
            None => None,
            Some(_) if !speakers::models_ready(&app_dir) => {
                speakers_error = Some("no_model".to_string());
                None
            }
            Some(_) if !speakers::runtime_available() => {
                speakers_error = Some("no_runtime".to_string());
                None
            }
            Some(count) => {
                let (audio, app_dir, percent) = (audio.clone(), app_dir.clone(), percent.clone());
                let started = std::time::Instant::now();
                let spawned = std::thread::Builder::new().name("rf-speakers".into()).spawn(move || {
                    let turns = speakers::separate(&audio, count, &app_dir, &mut |done, total| {
                        if let Some(p) = (done * 100).checked_div(total) {
                            percent.store(p, SeqCst);
                        }
                    });
                    (turns, started.elapsed())
                });
                match spawned {
                    Ok(handle) => Some(handle),
                    // The transcript comes without speakers.
                    Err(e) => {
                        startup_log::log(&format!("[speakers] could not start: {}", e));
                        speakers_error = Some(format!("the separation could not start ({})", e));
                        None
                    }
                }
            }
        };

        let terms = dictionary::terms(&settings.custom_prompt);
        let prompt = screen_context::whisper_prompt(&[], &settings.custom_prompt);
        let spelling = |text: &str| {
            let text = dictionary::apply_spelling(&file_transcribe::tidy_segment(text), &terms);
            if settings.swiss_spelling { dictionary::swiss_spelling(&text) } else { text }
        };
        let (mut segments, language) =
            file_transcribe::transcribe(&engine, &audio, run, &prompt, spelling, &FILE_CANCEL, |p| {
                let text = p.segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
                emit("transcribing", p.done_ms, p.total_ms, text);
            })?;

        let mut found = 0u8;
        if let Some(handle) = separation {
            let mut cancelled = false;
            while !handle.is_finished() {
                if FILE_CANCEL.load(SeqCst) {
                    cancelled = true;
                    break;
                }
                emit("speakers", percent.load(SeqCst) as u64, 100, String::new());
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            if cancelled {
                // Whisper is done: the transcript stays, without speakers.
                // The separation finishes on its own; its result is dropped.
                startup_log::log("[speakers] cancelled; the transcript comes without speakers");
                speakers_error = Some(file_transcribe::CANCELLED.to_string());
            } else {
                match handle.join() {
                    Ok((Ok(turns), took)) => {
                        match file_transcribe::label_speakers(&mut segments, &turns) {
                            Ok(n) => found = n,
                            Err(e) => speakers_error = Some(e),
                        }
                        startup_log::log(&format!(
                            "[speakers] {} speakers, {} turns in {:.1} s ({:.0} s of audio, {} threads)",
                            found,
                            turns.len(),
                            took.as_secs_f64(),
                            audio.len() as f64 / 16_000.0,
                            speakers::threads()
                        ));
                    }
                    Ok((Err(e), _)) => {
                        startup_log::log(&format!("[speakers] failed: {}", e));
                        speakers_error = Some(e);
                    }
                    Err(_) => speakers_error = Some("speaker separation stopped unexpectedly".to_string()),
                }
            }
        }
        Ok(FileTranscript {
            segments,
            speakers: found,
            speakers_error,
            language,
            duration_ms: audio.len() as u64 / 16,
            elapsed_ms: 0,
        })
    })
    .await
    .map_err(|e| format!("worker thread failed: {}", e))?;
    // With the cloud engine the local model is not kept loaded. A meeting
    // that transcribes with it keeps it (nothing would load it again until
    // Stop) and unloads it itself after its transcript.
    if settings.engine != "local" && !meeting_uses_whisper(&state.meetings.status()) {
        state.whisper_engine.invalidate();
    }
    *state.last_activity.lock().unwrap() = std::time::Instant::now();
    let mut transcript = result.inspect_err(|e| startup_log::log(&format!("[file] failed: {}", e)))?;
    transcript.elapsed_ms = started.elapsed().as_millis() as u64;
    startup_log::log(&format!(
        "[file] {:.0} s of audio in {:.1} s, language {}, {} segments, {} speakers",
        transcript.duration_ms as f64 / 1000.0,
        transcript.elapsed_ms as f64 / 1000.0,
        transcript.language,
        transcript.segments.len(),
        transcript.speakers
    ));
    Ok(transcript)
}

/// Write the Files tab's transcript as `kind`: "pdf", "docx", "srt", "vtt"
/// or "txt".
#[tauri::command]
async fn export_file(app: AppHandle, kind: String, path: String, doc: rudariflow_lib::export::ExportDoc) -> Result<(), String> {
    use rudariflow_lib::export;
    let paper = export::Paper::for_region();
    let path = std::path::PathBuf::from(path);
    let write = |bytes: &[u8]| std::fs::write(&path, bytes).map_err(|e| e.to_string());
    let result = match kind.as_str() {
        "txt" => write(export::text(&doc).as_bytes()),
        "srt" => write(export::srt(&doc.segments, &doc.names).as_bytes()),
        "vtt" => write(export::vtt(&doc.segments, &doc.names).as_bytes()),
        "docx" => export::docx(&doc, paper).and_then(|bytes| write(&bytes)),
        "pdf" => rudariflow_lib::pdf::print(&app, export::pdf_html(&doc, paper), paper, path.clone()).await,
        other => Err(format!("unknown export '{}'", other)),
    };
    startup_log::log(&match &result {
        Ok(()) => format!("[export] {} with {} segments", kind, doc.segments.len()),
        Err(e) => format!("[export] {} failed: {}", kind, e),
    });
    result
}

/// Stop the file transcription after the block that is running.
#[tauri::command]
fn cancel_file() {
    FILE_CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// A summary request that failed because the Free GPU hotkey stopped the
/// AI server while it answered: "gpu_freed", which the Files tab shows in
/// words.
fn summary_error(llm: &LlmServer, error: String) -> String {
    if llm.released() {
        "gpu_freed".to_string()
    } else {
        error
    }
}

/// The summary's wait for the AI server: "gpu_freed" only when the Free GPU
/// hotkey's release ended it. A start that fails after a free (e.g. while a
/// game holds the memory) keeps its own error.
fn summary_wait_error(llm: &LlmServer, error: String) -> String {
    if error == llm_server::STOPPED && llm.released() {
        "gpu_freed".to_string()
    } else {
        error
    }
}

/// Summarise a transcript with the AI model, even with AI cleanup off. A
/// long one is summarised in parts first ("summary-progress" events with
/// done and total requests). Fails with the AI's error, or "gpu_freed" when
/// the Free GPU hotkey stopped the AI.
#[tauri::command]
async fn summarize_text(app: AppHandle, state: State<'_, AppState>, text: String) -> Result<String, String> {
    let settings = state.settings.lock().unwrap().clone();
    let model = ai_models::find(&settings.ai_model).ok_or("no_ai_model")?;
    let model_path = ai_models::model_path(&state.app_dir, model);
    if !model_path.exists() {
        return Err("no_ai_model".to_string());
    }
    let language = ai_cleanup::detect_language(&text);
    let language = language.as_deref();
    let endpoint = state
        .llm
        .wait_ready(&model_path, Some(settings.gpu_backend.clone()), std::time::Duration::from_secs(120))
        .await
        .map_err(|e| summary_wait_error(&state.llm, e))?;
    let started = std::time::Instant::now();
    let (material, requests) = file_transcribe::condense(&endpoint, &text, language, &mut |done, total| {
        let _ = app.emit("summary-progress", (done, total));
    })
    .await
    .map_err(|e| summary_error(&state.llm, e))?;
    let _ = app.emit("summary-progress", (requests, requests + 1));
    let answer = ai_cleanup::complete_in(
        &endpoint,
        ai_cleanup::LONG_SLOT,
        &file_transcribe::summary_prompt(language),
        &material,
        0.2,
        900,
        file_transcribe::AI_TIMEOUT,
    )
    .await
    .map_err(|e| summary_error(&state.llm, e))?;
    startup_log::log(&format!(
        "[file] summary of {} characters in {} requests, {:.1} s",
        text.chars().count(),
        requests + 1,
        started.elapsed().as_secs_f64()
    ));
    Ok(answer.text.trim().to_string())
}

/// The Files tab's transcript text: paragraphs, optional times, speaker
/// names (`names[n]` for speaker n; empty = "Speaker n+1").
#[tauri::command]
fn format_file_text(segments: Vec<rudariflow_lib::whisper_engine::Segment>, names: Vec<String>, times: bool) -> String {
    file_transcribe::format(&segments, &names, times)
}

#[derive(serde::Serialize)]
struct SpeakerModelStatus {
    downloaded: bool,
    runtime: bool,
    downloading: bool,
}

static SPEAKER_DOWNLOAD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn speaker_model_status(state: State<AppState>) -> SpeakerModelStatus {
    use std::sync::atomic::Ordering::SeqCst;
    SpeakerModelStatus {
        downloaded: rudariflow_lib::speakers::models_ready(&state.app_dir),
        runtime: rudariflow_lib::speakers::runtime_available(),
        downloading: SPEAKER_DOWNLOAD.load(SeqCst),
    }
}

/// Download the speaker models (about 45 MB), with "speaker-model-progress"
/// events. "busy" while a download runs.
#[tauri::command]
async fn speaker_model_download(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use std::sync::atomic::Ordering::SeqCst;
    if SPEAKER_DOWNLOAD.swap(true, SeqCst) {
        return Err("busy".to_string());
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            SPEAKER_DOWNLOAD.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _done = Done;
    let result = rudariflow_lib::speakers::download_models(&state.app_dir, |p| {
        let _ = app.emit("speaker-model-progress", p);
    })
    .await;
    startup_log::log(&match &result {
        Ok(()) => "[speakers] models downloaded".to_string(),
        Err(e) => format!("[speakers] model download failed: {}", e),
    });
    result
}

/// Dictionary entries suggested from the user's corrections.
#[tauri::command]
fn learn_suggestions(state: State<AppState>) -> Vec<rudariflow_lib::learn::Suggestion> {
    rudariflow_lib::learn::suggestions(&state.app_dir)
}

/// A suggestion was added to the dictionary (`dismiss` false) or dismissed.
#[tauri::command]
fn learn_resolve(state: State<AppState>, word: String, dismiss: bool) -> Vec<rudariflow_lib::learn::Suggestion> {
    rudariflow_lib::learn::resolve(&state.app_dir, &word, dismiss);
    rudariflow_lib::learn::suggestions(&state.app_dir)
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
    if entry.edit.is_some() {
        return Err("Edits cannot be re-run".to_string());
    }
    if !entry.has_audio {
        return Err("This entry has no recording".to_string());
    }
    let samples = history::read_wav(&state.history.audio_path(id))?;
    let settings = state.settings.lock().unwrap().clone();
    let ctx = AppContext { exe: entry.app.clone(), title: entry.title.clone(), ..Default::default() };
    // The app's rule may set the language, as for the dictation itself.
    let whisper_language = rudariflow_lib::ai_cleanup::whisper_language(&settings.ai_rules, &ctx, &settings.language);
    let (raw, language) = transcribe_samples(
        None,
        &settings,
        &state.app_dir,
        &state.whisper_engine,
        &samples,
        &[],
        whisper_language,
    )
    .await?;
    let cleaned = dictionary::apply_spelling(&cleanup_text(&raw), &dictionary::terms(&settings.custom_prompt));
    let text = strip_send_command(&cleaned).unwrap_or(cleaned);
    let polished = polish(&settings, &state.app_dir, &state.llm, &ctx, &text, language.as_deref(), || {}).await;
    state
        .history
        .update_text(id, &polished.text, polished.raw.as_deref(), &model_label(&settings))
        .ok_or_else(|| "History entry not found".to_string())
}

#[derive(serde::Serialize)]
struct PcCheckResult {
    report: String,
    #[serde(rename = "gpuBackend")]
    gpu_backend: String,
    #[serde(rename = "whisperFlashAttn")]
    whisper_flash_attn: String,
    changed: bool,
}

/// PC check (Engine tab): Whisper on every GPU with flash attention on and
/// off on the user's latest recording, the fastest setup applied, the AI
/// server's speed measured, and a report to copy. Errors "meeting_busy"
/// while a meeting records or runs its end steps, "busy" while a check runs.
#[tauri::command]
async fn pc_check(app: AppHandle, state: State<'_, AppState>) -> Result<PcCheckResult, String> {
    use rudariflow_lib::pc_check as check;
    // No meeting starts or finishes from here on ("pc_check"), and none
    // may be under way: the check unloads the engine's model and runs
    // Whisper beside it, past the gate and the engine's lock. A meeting's
    // live text would stop and its pieces would run against the variants.
    let _running = PcCheckRunning::begin()?;
    // `is_recording` waits for a meeting whose devices are opening right
    // now (it is not in the status yet); off the async threads for that.
    let meetings = state.meetings.clone();
    let in_meeting =
        tauri::async_runtime::spawn_blocking(move || meetings.is_recording() || meeting_busy(&meetings.status())).await;
    if in_meeting.unwrap_or(true) {
        return Err("meeting_busy".to_string());
    }
    let settings = state.settings.lock().unwrap().clone();
    let model = whisper_model_to_load(&settings, &state.app_dir).ok_or("Download a Whisper model first")?;
    // The newest recording in the history, else five seconds of silence.
    let clip = state
        .history
        .list()
        .iter()
        .find(|e| e.has_audio)
        .and_then(|e| history::read_wav(&state.history.audio_path(e.id)).ok())
        .unwrap_or_else(|| vec![0.0; 16_000 * 5]);
    let clip_secs = clip.len() as f32 / 16_000.0;
    let language = settings.language.clone();
    let model_for_check = model.clone();
    startup_log::log("[pc-check] started");
    // The engine's model gives up its video memory while the variants run.
    state.whisper_engine.invalidate();
    let progress_app = app.clone();
    let (results, default) = tauri::async_runtime::spawn_blocking(move || {
        let variants = check::variants();
        let default = check::default_variant();
        let results = check::measure(&model_for_check, &clip, &language, &variants, |done, total, label| {
            let _ = progress_app.emit("pc-check-progress", (done, total, label.to_string()));
        });
        (results, default)
    })
    .await
    .map_err(|e| e.to_string())?;

    let chosen = check::choose(&results, &default);
    let (gpu_backend, whisper_flash_attn) = match chosen {
        Some(i) => check::settings_for(&results[i], &default),
        None => (settings.gpu_backend.clone(), settings.whisper_flash_attn.clone()),
    };
    let changed = gpu_backend != settings.gpu_backend || whisper_flash_attn != settings.whisper_flash_attn;
    {
        let mut s = state.settings.lock().unwrap();
        s.gpu_backend = gpu_backend.clone();
        s.whisper_flash_attn = whisper_flash_attn.clone();
        s.save(&state.app_dir)?;
    }
    load_whisper(state.inner()).await;
    let ai = ai_check_line(state.inner()).await;

    let mut report = vec![
        format!(
            "RudariFlow {} PC check, {}",
            env!("CARGO_PKG_VERSION"),
            rudariflow_lib::replacements::fill_variables(
                "{date} {time}",
                &rudariflow_lib::replacements::Moment::now(),
                true
            )
        ),
        check::system_summary(),
    ];
    let gpus: Vec<String> = rudariflow_lib::whisper_engine::list_gpu_devices()
        .iter()
        .map(|d| format!("{} ({}, {:.0} GB{})", d.name, d.api.label(), d.memory_mib as f64 / 1024.0, if d.integrated { ", integrated" } else { "" }))
        .collect();
    report.push(format!("GPUs: {}", if gpus.is_empty() { "none".to_string() } else { gpus.join("; ") }));
    report.push(format!("Whisper {} on a {:.1} s recording:", settings.whisper_model, clip_secs));
    for (i, m) in results.iter().enumerate() {
        let result = match (m.median_ms, &m.error) {
            (Some(ms), _) => format!("{} ms (load {:.1} s)", ms, m.load_ms as f64 / 1000.0),
            (None, Some(e)) => format!("failed: {}", e),
            (None, None) => "failed".to_string(),
        };
        let mark = if Some(i) == chosen { "  <- in use" } else { "" };
        report.push(format!("  {}: {}{}", m.label, result, mark));
    }
    report.push(format!(
        "Setting: GPU backend {}, flash attention {}{}",
        gpu_backend,
        whisper_flash_attn,
        if changed { " (changed)" } else { " (unchanged)" }
    ));
    report.push(ai);
    let report = report.join("\n");
    startup_log::log(&format!("[pc-check] done: backend {}, flash attention {}", gpu_backend, whisper_flash_attn));
    Ok(PcCheckResult { report, gpu_backend, whisper_flash_attn, changed })
}

/// The AI part of the PC check: three sample cleanups with the user's
/// settings, their times, the per-token speed and the drafter.
async fn ai_check_line(state: &AppState) -> String {
    let settings = state.settings.lock().unwrap().clone();
    let Some(model_path) = ai_model_to_run(&settings, &state.app_dir) else {
        return "AI cleanup: off or model not downloaded".to_string();
    };
    let label = ai_models::find(&settings.ai_model).map_or("AI model", |m| m.label);
    let ctx = AppContext { exe: "notepad".into(), title: "Untitled - Notepad".into(), ..Default::default() };
    const SAMPLES: [&str; 3] = [
        "Um so I think we should, uh, meet on Tuesday, no wait, Wednesday at 3 and bring the slides.",
        "For the trip we need sunscreen, a new phone charger, two beach towels and, uh, snacks for the kids.",
        "Can you send me the invoice by the end of the week so I can pay it this month?",
    ];
    // One run that is not counted: after some idle minutes the GPU and the
    // prompt cache are cold (1552 ms instead of 263 ms). A dictation gets
    // this warm-up from the hotkey press.
    let _ = polish(&settings, &state.app_dir, &state.llm, &ctx, SAMPLES[2], Some("English"), || {}).await;
    let mut times = Vec::new();
    for text in SAMPLES {
        let p = polish(&settings, &state.app_dir, &state.llm, &ctx, text, Some("English"), || {}).await;
        match p.fallback {
            Some(reason) => return format!("AI cleanup: {} did not answer ({})", label, reason),
            None => times.push(p.ai_ms),
        }
    }
    let device = match state.llm.status() {
        ServerStatus::Ready { device } => device,
        _ => "?".to_string(),
    };
    let _ = model_path;
    let mut sorted = times.clone();
    sorted.sort();
    let speed = state.llm.speed().map_or(String::new(), |s| {
        format!("; {:.1} ms per prompt token, {:.1} ms per output token", s.prompt_ms_per_token, s.gen_ms_per_token)
    });
    format!(
        "AI cleanup: {} on {}{}: {} ms (median {} ms){}",
        label,
        device,
        if state.llm.drafter_active() { " with MTP drafter" } else { "" },
        times.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(" / "),
        sorted[sorted.len() / 2],
        speed
    )
}

#[derive(serde::Serialize)]
struct AiModelInfo {
    id: &'static str,
    label: &'static str,
    bytes: u64,
    downloaded: bool,
}

#[derive(serde::Serialize)]
struct AiStatus {
    server: ServerStatus,
    /// The bundled llama-server was found.
    installed: bool,
    models: Vec<AiModelInfo>,
    downloading: Option<String>,
    /// Unloaded by the Free GPU hotkey; the next request starts it.
    #[serde(rename = "gpuFreed")]
    gpu_freed: bool,
}

#[tauri::command]
fn ai_status(state: State<AppState>) -> AiStatus {
    AiStatus {
        server: state.llm.status(),
        installed: state.llm.is_installed(),
        models: ai_models::MODELS
            .iter()
            .map(|m| AiModelInfo {
                id: m.id,
                label: m.label,
                bytes: m.bytes,
                downloaded: ai_models::model_path(&state.app_dir, m).exists(),
            })
            .collect(),
        downloading: state.ai_download.lock().unwrap().clone(),
        gpu_freed: state.llm.released(),
    }
}

/// Download an AI model (progress as `ai-download-progress` events).
#[tauri::command]
async fn ai_download_model(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let model = ai_models::find(&id).ok_or("Unknown AI model")?;
    {
        let mut downloading = state.ai_download.lock().unwrap();
        if downloading.is_some() {
            return Err("A download is already running".to_string());
        }
        *downloading = Some(id.clone());
    }
    let dest = ai_models::model_path(&state.app_dir, model);
    let result =
        downloader::download_model(app, &ai_models::download_url(model), &dest, "ai-download-progress").await;
    *state.ai_download.lock().unwrap() = None;
    result?;
    // The drafter first (about 100 MB), so the server starts with it.
    fetch_ai_draft(&state, model).await;
    warm_ai(&state);
    Ok(())
}

/// Download a model's MTP drafter when the model is there and the drafter
/// is not. llama-server uses it from its next start.
async fn fetch_ai_draft(state: &AppState, model: &'static ai_models::AiModel) {
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let dest = ai_models::draft_path(&state.app_dir, model);
    if dest.exists() || !ai_models::model_path(&state.app_dir, model).exists() {
        return;
    }
    if RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let started = std::time::Instant::now();
    match downloader::download_file(&ai_models::draft_url(model), &dest, |_| {}).await {
        Ok(()) => startup_log::log(&format!(
            "[ai] MTP drafter {} downloaded in {} s",
            model.draft_file,
            started.elapsed().as_secs()
        )),
        Err(e) => startup_log::log(&format!("[ai] MTP drafter download failed: {}", e)),
    }
    RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
}

/// The selected AI model when AI cleanup is on.
fn active_ai_model(state: &AppState) -> Option<&'static ai_models::AiModel> {
    let settings = state.settings.lock().unwrap();
    if !settings.ai_cleanup {
        return None;
    }
    ai_models::find(&settings.ai_model)
}

/// Clean up a sample text as if it were dictated into `app` (settings test
/// box). Works before the AI cleanup switch is on.
#[tauri::command]
async fn ai_test(
    state: State<'_, AppState>,
    text: String,
    app: String,
    screen_terms: Option<Vec<String>>,
) -> Result<Polished, String> {
    let mut settings = state.settings.lock().unwrap().clone();
    settings.ai_cleanup = true;
    let ctx = AppContext {
        exe: app.trim().to_lowercase(),
        screen_terms: screen_terms.unwrap_or_default(),
        ..Default::default()
    };
    let text = dictionary::apply_spelling(&cleanup_text(&text), &dictionary::terms(&settings.custom_prompt));
    Ok(polish(&settings, &state.app_dir, &state.llm, &ctx, &text, None, || {}).await)
}

#[derive(serde::Serialize)]
struct EditTestResult {
    /// The replacement text; empty when the model asked to delete.
    text: String,
    delete: bool,
    error: Option<String>,
    #[serde(rename = "aiMs")]
    ai_ms: u64,
}

/// Run an Edit mode request on a sample selection as if it came from `app`
/// (for testing; nothing is pasted). Works before the AI cleanup switch is on.
#[tauri::command]
async fn ai_edit_test(
    state: State<'_, AppState>,
    selection: String,
    spoken: String,
    app: String,
) -> Result<EditTestResult, String> {
    let settings = state.settings.lock().unwrap().clone();
    let ctx = AppContext { exe: app.trim().to_lowercase(), ..Default::default() };
    let (result, ai_ms) =
        voice_edit::edit(&settings, &state.app_dir, &state.llm, &ctx, &selection, &cleanup_text(&spoken), || {}).await;
    Ok(match result {
        Ok(Edit::Replace(text)) => EditTestResult { text, delete: false, error: None, ai_ms },
        Ok(Edit::Delete) => EditTestResult { text: String::new(), delete: true, error: None, ai_ms },
        Err(e) => EditTestResult { text: String::new(), delete: false, error: Some(e), ai_ms },
    })
}

/// Test hook for the whole Edit mode path without a microphone: read the
/// selection of the focused app, edit it with `spoken` as if it had been
/// said, and paste the result. Only when started with
/// RUDARIFLOW_TEST_COMMANDS=1.
#[tauri::command]
async fn edit_live_test(state: State<'_, AppState>, spoken: String) -> Result<String, String> {
    if std::env::var("RUDARIFLOW_TEST_COMMANDS").as_deref() != Ok("1") {
        return Err("test commands are off".to_string());
    }
    let settings = state.settings.lock().unwrap().clone();
    let ctx = foreground_app::current();
    if !voice_edit::available(&settings, &state.app_dir, &ctx) {
        return Err(format!("Edit mode not available in '{}'", ctx.exe));
    }
    let target = tauri::async_runtime::spawn_blocking(rudariflow_lib::selection::read).await.map_err(|e| e.to_string())?;
    let Some(selection) = target.selected().map(str::to_string) else {
        return Err(format!("no edit: {:?}", target));
    };
    let (result, ai_ms) =
        voice_edit::edit(&settings, &state.app_dir, &state.llm, &ctx, &selection, &cleanup_text(&spoken), || {}).await;
    match result? {
        Edit::Replace(text) => {
            paste_text(&text)?;
            Ok(format!("{} ms in '{}': {:?} -> {:?}", ai_ms, ctx.exe, selection, text))
        }
        Edit::Delete => {
            rudariflow_lib::paste::press_delete()?;
            Ok(format!("{} ms in '{}': deleted {:?}", ai_ms, ctx.exe, selection))
        }
    }
}

#[derive(serde::Serialize)]
struct ScreenTestResult {
    exe: String,
    chars: usize,
    ms: u64,
    terms: Vec<String>,
}

/// Test hook: the screen context of the focused window right now (terms
/// and how long reading took). Only with RUDARIFLOW_TEST_COMMANDS=1.
#[tauri::command]
async fn screen_context_test(state: State<'_, AppState>) -> Result<ScreenTestResult, String> {
    if std::env::var("RUDARIFLOW_TEST_COMMANDS").as_deref() != Ok("1") {
        return Err("test commands are off".to_string());
    }
    let dictionary = dictionary::terms(&state.settings.lock().unwrap().custom_prompt);
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let text = rudariflow_lib::screen_context::read_window_text(rudariflow_lib::screen_context::MAX_CHARS)
            .unwrap_or_default();
        let terms =
            rudariflow_lib::screen_context::terms(&text, &dictionary, rudariflow_lib::screen_context::MAX_TERMS);
        ScreenTestResult {
            exe: foreground_app::current().exe,
            chars: text.chars().count(),
            ms: started.elapsed().as_millis() as u64,
            terms,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Test hook: the text before the caret in the focused field and what a
/// dictation of `text` after the last one would paste there. Only with
/// RUDARIFLOW_TEST_COMMANDS=1.
#[tauri::command]
async fn caret_test(state: State<'_, AppState>, text: String) -> Result<(Option<String>, String), String> {
    if std::env::var("RUDARIFLOW_TEST_COMMANDS").as_deref() != Ok("1") {
        return Err("test commands are off".to_string());
    }
    let last = state.history.last_text();
    let look_back = last.as_ref().map_or(40, |t| t.trim().chars().count());
    let before = tauri::async_runtime::spawn_blocking(move || rudariflow_lib::selection::text_before_caret(look_back))
        .await
        .map_err(|e| e.to_string())?;
    let pasted = rudariflow_lib::selection::space_after_dictation(&text, before.as_deref(), last.as_deref());
    Ok((before, pasted))
}

/// Restart the AI server, e.g. after it failed twice. Retry is asked for, so
/// it starts after a Free GPU press too.
#[tauri::command]
fn ai_restart(state: State<AppState>) {
    state.llm.stop();
    start_ai(&state);
}

/// Save the dictionary as a text file, one entry per line (to move it to
/// another PC). Returns how many entries were written.
#[tauri::command]
fn dictionary_export(state: State<AppState>, path: String) -> Result<usize, String> {
    let terms = dictionary::terms(&state.settings.lock().unwrap().custom_prompt);
    std::fs::write(&path, dictionary::to_file_text(&terms)).map_err(|e| e.to_string())?;
    Ok(terms.len())
}

/// Entries of a dictionary file; the UI merges them into the dictionary.
#[tauri::command]
fn dictionary_read_file(path: String) -> Result<Vec<String>, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(dictionary::from_file_bytes(&bytes))
}

#[tauri::command]
fn list_open_apps() -> Vec<String> {
    foreground_app::open_apps()
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

/// `target` is "dictation", "pasteLast", "rewriteLast", "freeGpu" or
/// "meeting"; each takes a keyboard chord or a mouse side button. An empty
/// `new_hotkey` turns all but dictation off; dictation always needs one. A key a
/// soundboard hotkey has is refused too, even while the board is off.
#[tauri::command]
fn change_hotkey(
    app: tauri::AppHandle,
    state: State<AppState>,
    target: String,
    new_hotkey: String,
) -> Result<(), String> {
    let action = HotkeyAction::from_target(&target)?;
    let board = state.soundboard.board();
    let all = all_hotkeys(&state.settings.lock().unwrap(), &board);
    let current = all.iter().find(|(a, _)| *a == action).map(|(_, h)| h.clone()).unwrap_or_default();
    if new_hotkey.is_empty() && action == HotkeyAction::Dictation {
        return Err("The dictation hotkey cannot be empty".to_string());
    }
    if !new_hotkey.is_empty() {
        if let Some(owner) = taken_by(&all, &action, &new_hotkey) {
            return Err(format!("'{}' is already used by {}", new_hotkey, owner_label(&owner, &board)));
        }
    }
    if new_hotkey != current {
        // Register the new chord before dropping the old one, so a rejected
        // chord (invalid name, taken by another app) leaves the old one working.
        if !new_hotkey.is_empty() {
            register_hotkey(&app, &new_hotkey, action.clone())?;
        }
        if !current.is_empty() {
            unregister_hotkey(&app, &current);
        }
    } else if !new_hotkey.is_empty() && !hotkey_is_registered(&app, &current) {
        register_hotkey(&app, &new_hotkey, action.clone())?;
    }
    startup_log::log(&format!("[hotkey] {:?} changed {} -> {}", action, current, new_hotkey));
    let mut settings = state.settings.lock().unwrap();
    match action {
        HotkeyAction::Dictation => settings.hotkey = new_hotkey,
        HotkeyAction::PasteLast => settings.paste_last_hotkey = new_hotkey,
        HotkeyAction::RewriteLast => settings.rewrite_last_hotkey = new_hotkey,
        HotkeyAction::FreeGpu => settings.free_gpu_hotkey = new_hotkey,
        HotkeyAction::Meeting => settings.meeting_hotkey = new_hotkey,
        // `from_target` names only the app's five.
        HotkeyAction::StopSounds | HotkeyAction::ToggleSoundHotkeys | HotkeyAction::Sound(_) => {}
    }
    settings.save(&state.app_dir)?;
    drop(settings);
    // The board's keys never sit on an app hotkey's (see `sync_board_hotkeys`).
    spawn_board_hotkey_sync(&app);
    Ok(())
}

/// Temporarily release the global hotkeys while the settings UI captures a
/// new chord; a registered chord never reaches the webview as a keydown.
/// The soundboard's hotkeys follow off the main thread.
#[tauri::command]
async fn set_hotkey_paused(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    paused: bool,
) -> Result<(), String> {
    // Two windows (main, soundboard pop-out) can each hold a capture. The
    // pause is held per window label, so one finishing never re-registers
    // the hotkeys under the other, and a window that goes away mid-capture
    // is released in release_hotkey_pause (Destroyed), never wedging it.
    // Async + spawn_blocking: HOTKEY_PAUSE_HOLDERS is held while the hotkeys
    // are (un)registered, which can wait on the main thread, so nothing that
    // takes the lock may ever run on the main thread (a sync command would).
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut holders = HOTKEY_PAUSE_HOLDERS.lock().unwrap();
        let change = if paused { holders.hold(&label) } else { holders.release(&label) };
        if !change {
            return Ok(());
        }
        apply_hotkey_pause(&app, paused)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A window is gone: it no longer holds a pause.
fn release_hotkey_pause(app: &AppHandle, label: &str) {
    let mut holders = HOTKEY_PAUSE_HOLDERS.lock().unwrap();
    if holders.release(label) {
        let _ = apply_hotkey_pause(app, false);
    }
}

/// Which windows hold the hotkey pause (a hotkey capture in progress).
/// hold/release are idempotent per label and return true when the pause
/// starts (first holder) or ends (last holder gone).
struct PauseHolders {
    labels: Vec<String>,
}

impl PauseHolders {
    const fn new() -> Self {
        PauseHolders { labels: Vec::new() }
    }
    fn hold(&mut self, label: &str) -> bool {
        if self.labels.iter().any(|l| l == label) {
            return false;
        }
        self.labels.push(label.to_string());
        self.labels.len() == 1
    }
    fn release(&mut self, label: &str) -> bool {
        let before = self.labels.len();
        self.labels.retain(|l| l != label);
        before > 0 && self.labels.is_empty()
    }
}

static HOTKEY_PAUSE_HOLDERS: Mutex<PauseHolders> = Mutex::new(PauseHolders::new());

/// Unregister (paused) or register again the global hotkeys. The caller holds
/// the HOTKEY_PAUSE_HOLDERS lock, so pause and resume never interleave.
fn apply_hotkey_pause(app: &AppHandle, paused: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let all = hotkeys(&state.settings.lock().unwrap());
    let mut result = Ok(());
    for (action, hotkey) in all {
        if hotkey.is_empty() {
            continue;
        }
        if paused {
            unregister_hotkey(&app, &hotkey);
        } else if !hotkey_is_registered(&app, &hotkey) {
            let dictation = action == HotkeyAction::Dictation;
            if let Err(e) = register_hotkey(&app, &hotkey, action) {
                // An optional chord (paste last, rewrite, free GPU, meeting) taken by
                // another app must not block the dictation hotkey; it is
                // logged by register_hotkey.
                if dictation {
                    result = Err(e);
                }
            }
        }
    }
    HOTKEYS_PAUSED.store(paused, Ordering::SeqCst);
    spawn_board_hotkey_sync(app);
    result
}

fn on_hotkey_event(handle: &AppHandle, action: &HotkeyAction, pressed: bool) {
    match action {
        HotkeyAction::Dictation => on_hotkey(handle, pressed),
        HotkeyAction::PasteLast if pressed => paste_last_transcript(handle),
        HotkeyAction::PasteLast => {}
        HotkeyAction::RewriteLast => on_rewrite_hotkey(handle, pressed),
        HotkeyAction::FreeGpu if pressed => on_free_gpu_hotkey(handle),
        HotkeyAction::FreeGpu => {}
        HotkeyAction::Meeting if pressed => toggle_meeting(handle),
        HotkeyAction::Meeting => {}
        HotkeyAction::StopSounds if pressed => on_stop_sounds_hotkey(handle),
        HotkeyAction::StopSounds => {}
        HotkeyAction::ToggleSoundHotkeys if pressed => on_toggle_sound_hotkeys_hotkey(handle),
        HotkeyAction::ToggleSoundHotkeys => {}
        HotkeyAction::Sound(id) if pressed => on_sound_hotkey(handle, id),
        HotkeyAction::Sound(_) => {}
    }
}

/// A sound's hotkey: play it, or stop it while it plays. Off the hotkey's
/// thread (chords arrive on the main thread).
fn on_sound_hotkey(handle: &AppHandle, id: &str) {
    let (handle, id) = (handle.clone(), id.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let soundboard = &handle.state::<AppState>().soundboard;
        // A press that raced the switch going off (its key is released
        // after the change event): nothing. Clicks go through `play` directly.
        if !soundboard.sound_hotkeys_on() {
            return;
        }
        if let Err(e) = soundboard.play(&id) {
            startup_log::log(&format!("[soundboard] {} not played: {}", id, e));
        }
    });
}

/// The stop-all hotkey.
fn on_stop_sounds_hotkey(handle: &AppHandle) {
    let handle = handle.clone();
    tauri::async_runtime::spawn_blocking(move || handle.state::<AppState>().soundboard.stop_all());
}

/// The toggle hotkey: turn the sounds' hotkeys off, or on again. The change
/// event registers or releases them (`sync_board_hotkeys`); the pill says
/// which. Off the hotkey's thread, like the sound hotkeys.
fn on_toggle_sound_hotkeys_hotkey(handle: &AppHandle) {
    let handle = handle.clone();
    tauri::async_runtime::spawn_blocking(move || match handle.state::<AppState>().soundboard.toggle_sound_hotkeys() {
        Ok(on) => {
            startup_log::log(&format!("[soundboard] sound hotkeys {}", if on { "on" } else { "off" }));
            pill_notice(&handle, "soundboard-notice", if on { "hotkeys-on" } else { "hotkeys-off" });
        }
        Err(e) => startup_log::log(&format!("[soundboard] sound hotkeys not switched: {}", e)),
    });
}

/// Whether the rewrite hotkey is held (push-to-talk): a release that comes
/// before the selection is made must not leave a recording running.
static REWRITE_HELD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// "Rewrite last": select the last dictation in the focused field, then
/// record like the dictation hotkey; the release edits the selection with
/// what was said (Edit mode). Pressed while recording (toggle mode) it
/// stops like the dictation hotkey.
fn on_rewrite_hotkey(handle: &AppHandle, pressed: bool) {
    use rudariflow_lib::selection::{select_last, Target};
    REWRITE_HELD.store(pressed, Ordering::SeqCst);
    let state = handle.state::<AppState>();
    if !pressed || state.recorder.get_state() != RecordingState::Ready {
        on_hotkey(handle, pressed);
        return;
    }
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        let settings = state.settings.lock().unwrap().clone();
        let ctx = foreground_app::current();
        if !voice_edit::available(&settings, &state.app_dir, &ctx) {
            startup_log::log(&format!("[rewrite] needs AI cleanup and Edit mode ('{}')", ctx.exe));
            state.recorder.notice(&handle, "rewrite-failed", "needs-ai");
            return;
        }
        let Some(last) = state.history.last_text() else {
            state.recorder.notice(&handle, "rewrite-failed", "missing");
            return;
        };
        let started = std::time::Instant::now();
        match tauri::async_runtime::spawn_blocking(move || select_last(&last)).await {
            Ok(Target::Selected(text)) => {
                startup_log::log(&format!(
                    "[rewrite] selected the last dictation ({} words) in '{}' in {} ms",
                    text.split_whitespace().count(),
                    ctx.exe,
                    started.elapsed().as_millis()
                ));
                let push_to_talk = settings.recording_mode == "push-to-talk";
                if !push_to_talk || REWRITE_HELD.load(Ordering::SeqCst) {
                    on_hotkey(&handle, true);
                } else {
                    // Released before the selection was made (a tap): no
                    // recording, and the dictation must not stay selected.
                    let collapsed =
                        tauri::async_runtime::spawn_blocking(rudariflow_lib::selection::collapse_selection).await;
                    startup_log::log(&format!(
                        "[rewrite] released before recording; selection {}",
                        if collapsed.unwrap_or(false) { "cleared" } else { "left" }
                    ));
                }
            }
            Ok(Target::None(reason)) => {
                startup_log::log(&format!("[rewrite] not rewriting in '{}': {}", ctx.exe, reason));
                state.recorder.notice(&handle, "rewrite-failed", "missing");
            }
            Err(_) => {}
        }
    });
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

/// What a press of the Free GPU hotkey did.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
enum FreeGpuResult {
    Freed,
    Loaded,
    /// Whisper or the AI did not load; the log and the AI tab say why.
    LoadFailed,
    /// A newer press came while the AI was loading.
    Overtaken,
}

/// A Free GPU notice in the pill ("freed", "loading", "loaded", "failed").
fn gpu_notice(handle: &AppHandle, kind: &str) {
    pill_notice(handle, "gpu-notice", kind);
}

/// A short notice in the pill (`event` with `kind`, which the overlay puts
/// in words), but not during a dictation: the pill shows its recording then.
fn pill_notice(handle: &AppHandle, event: &str, kind: &str) {
    let state = handle.state::<AppState>();
    if state.recorder.get_state() == RecordingState::Ready {
        state.recorder.notice(handle, event, kind);
    }
}

/// One press of the Free GPU hotkey, number `press` of `GpuFree::press`:
/// free the GPU, or load the models again when the last press freed it and
/// nothing has loaded them since (`power::gpu_toggle`). Presses run in order,
/// and one during a dictation waits until it is pasted.
async fn free_gpu_press(handle: &AppHandle, press: u64) -> FreeGpuResult {
    let state = handle.state::<AppState>();
    let ops = state.gpu.ops.lock().await;
    // A dictation keeps its models until it is pasted. One after a free
    // loads them again, so the toggle is decided once it is done.
    if state.recorder.get_state() != RecordingState::Ready {
        startup_log::log("[gpu] waiting for the dictation to finish");
        while state.recorder.get_state() != RecordingState::Ready {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
    let toggle = power::gpu_toggle(
        state.gpu.freed.load(Ordering::SeqCst),
        state.whisper_engine.released(),
        state.llm.released(),
    );
    if toggle == GpuToggle::Free {
        state.gpu.freed.store(true, Ordering::SeqCst);
        let (llm, engine) = (state.llm.clone(), state.whisper_engine.clone());
        // Stopping llama-server waits for it to exit; Whisper waits for a
        // block of a file that is running (the file keeps its own reference
        // to the model until it is done).
        let _ = tauri::async_runtime::spawn_blocking(move || {
            llm.release();
            engine.release();
        })
        .await;
        startup_log::log("[gpu] freed: Whisper unloaded, AI server stopped");
        gpu_notice(handle, "freed");
        return FreeGpuResult::Freed;
    }
    state.gpu.freed.store(false, Ordering::SeqCst);
    // Asked for now: the battery watcher must not unload them at its next look.
    *state.last_activity.lock().unwrap() = std::time::Instant::now();
    gpu_notice(handle, "loading");
    let started = std::time::Instant::now();
    // Whisper first, as at start: llama-server's --fit measures the free
    // video memory once, when it loads.
    let whisper_ok = load_whisper(state.inner()).await;
    // A press from here on frees the GPU at once, and its release stops this
    // start. The generation is read while `ops` is held: that release can
    // land before the start has even begun.
    let generation = state.llm.generation();
    drop(ops);
    let settings = state.settings.lock().unwrap().clone();
    let ai_ok = match ai_model_to_run(&settings, &state.app_dir) {
        Some(model) => state
            .llm
            .ensure_running_since(generation, &model, Some(settings.gpu_backend.as_str()))
            .await
            .is_ok(),
        None => true,
    };
    if state.gpu.press.load(Ordering::SeqCst) != press {
        return FreeGpuResult::Overtaken;
    }
    let loaded = whisper_ok && ai_ok;
    startup_log::log(&format!(
        "[gpu] models {} after {} ms",
        if loaded { "loaded" } else { "not all loaded" },
        started.elapsed().as_millis()
    ));
    gpu_notice(handle, if loaded { "loaded" } else { "failed" });
    if loaded {
        FreeGpuResult::Loaded
    } else {
        FreeGpuResult::LoadFailed
    }
}

/// The Free GPU hotkey was pressed. The work runs in the background: chords
/// arrive on the main thread, side buttons on the mouse hook's handler thread.
fn on_free_gpu_hotkey(handle: &AppHandle) {
    let press = handle.state::<AppState>().gpu.press.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let result = free_gpu_press(&handle, press).await;
        startup_log::log(&format!("[gpu] press {}: {:?}", press, result));
    });
}

/// Test hook: one press of the Free GPU hotkey, waited for. Only with
/// RUDARIFLOW_TEST_COMMANDS=1.
#[tauri::command]
async fn free_gpu_test(app: AppHandle, state: State<'_, AppState>) -> Result<FreeGpuResult, String> {
    if std::env::var("RUDARIFLOW_TEST_COMMANDS").as_deref() != Ok("1") {
        return Err("test commands are off".to_string());
    }
    let press = state.gpu.press.fetch_add(1, Ordering::SeqCst) + 1;
    Ok(free_gpu_press(&app, press).await)
}

#[tauri::command]
async fn soundboard_state(state: State<'_, AppState>) -> Result<BoardState, String> {
    Ok(state.soundboard.state())
}

/// The Virtual microphone switch. Returns the status after it (on, off, or
/// the reason it could not turn on).
#[tauri::command]
async fn soundboard_set_enabled(state: State<'_, AppState>, enabled: bool) -> Result<Status, String> {
    let (board, mic) = (state.soundboard.clone(), state.settings.lock().unwrap().microphone.clone());
    tauri::async_runtime::spawn_blocking(move || {
        if enabled {
            let _ = board.turn_on(&mic);
        } else {
            board.turn_off();
        }
        board.status()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Inputs and outputs for the Devices area, with the automatic picks.
#[tauri::command]
async fn soundboard_devices(state: State<'_, AppState>) -> Result<engine::DeviceChoices, String> {
    let mic = state.settings.lock().unwrap().microphone.clone();
    tauri::async_runtime::spawn_blocking(move || engine::choices(&mic)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn soundboard_set_devices(state: State<'_, AppState>, devices: Devices) -> Result<Status, String> {
    let (board, mic) = (state.soundboard.clone(), state.settings.lock().unwrap().microphone.clone());
    tauri::async_runtime::spawn_blocking(move || board.set_devices(devices, &mic)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn soundboard_set_volumes(state: State<'_, AppState>, others: f32, me: f32) -> Result<(), String> {
    state.soundboard.set_volumes(others, me)
}

#[tauri::command]
async fn soundboard_set_layer(state: State<'_, AppState>, layer: bool) -> Result<(), String> {
    state.soundboard.set_layer(layer)
}

/// Add files (copied into the soundboard folder); a result per file.
#[tauri::command]
async fn soundboard_add(state: State<'_, AppState>, paths: Vec<String>) -> Result<Vec<AddResult>, String> {
    let board = state.soundboard.clone();
    tauri::async_runtime::spawn_blocking(move || board.add(&paths)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn soundboard_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let board = state.soundboard.clone();
    tauri::async_runtime::spawn_blocking(move || board.remove(&id).map(|_| ())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn soundboard_rename(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    state.soundboard.rename(&id, &name)
}

#[tauri::command]
async fn soundboard_set_category(state: State<'_, AppState>, id: String, category: String) -> Result<(), String> {
    state.soundboard.set_category(&id, &category)
}

#[tauri::command]
async fn soundboard_set_sound_volume(state: State<'_, AppState>, id: String, volume: f32) -> Result<(), String> {
    state.soundboard.set_sound_volume(&id, volume)
}

/// A sound's hotkey ("" = none): checked against every other hotkey; the
/// board's hotkeys follow from the change event.
#[tauri::command]
async fn soundboard_set_hotkey(state: State<'_, AppState>, id: String, hotkey: String) -> Result<(), String> {
    let board = state.soundboard.board();
    let all = all_hotkeys(&state.settings.lock().unwrap(), &board);
    check_board_hotkey(&all, &board, &HotkeyAction::Sound(id.clone()), &hotkey)?;
    state.soundboard.set_sound_hotkey(&id, &hotkey)
}

/// The stop-all hotkey ("" = off).
#[tauri::command]
async fn soundboard_set_stop_hotkey(state: State<'_, AppState>, hotkey: String) -> Result<(), String> {
    let board = state.soundboard.board();
    let all = all_hotkeys(&state.settings.lock().unwrap(), &board);
    check_board_hotkey(&all, &board, &HotkeyAction::StopSounds, &hotkey)?;
    state.soundboard.set_stop_hotkey(&hotkey)
}

/// Turn the sounds' hotkeys on or off; they keep their keys, and stop all
/// and the toggle stay registered. The board's hotkeys follow from the
/// change event.
#[tauri::command]
async fn soundboard_set_sound_hotkeys(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    state.soundboard.set_sound_hotkeys(enabled)
}

/// The hotkey that turns the sounds' hotkeys on and off ("" = none).
#[tauri::command]
async fn soundboard_set_toggle_hotkey(state: State<'_, AppState>, hotkey: String) -> Result<(), String> {
    let board = state.soundboard.board();
    let all = all_hotkeys(&state.settings.lock().unwrap(), &board);
    check_board_hotkey(&all, &board, &HotkeyAction::ToggleSoundHotkeys, &hotkey)?;
    state.soundboard.set_toggle_hotkey(&hotkey)
}

/// Loop a sound until it is stopped (JS: `{ id, looping }`).
#[tauri::command]
async fn soundboard_set_sound_loop(state: State<'_, AppState>, id: String, looping: bool) -> Result<(), String> {
    state.soundboard.set_sound_loop(&id, looping)
}

/// Play a sound, or stop it while it plays; true when it started.
#[tauri::command]
async fn soundboard_play(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let board = state.soundboard.clone();
    tauri::async_runtime::spawn_blocking(move || board.play(&id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn soundboard_stop_all(state: State<'_, AppState>) -> Result<(), String> {
    state.soundboard.stop_all();
    Ok(())
}

#[tauri::command]
async fn soundboard_category_add(state: State<'_, AppState>, name: String) -> Result<String, String> {
    state.soundboard.category_add(&name)
}

#[tauri::command]
async fn soundboard_category_rename(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    state.soundboard.category_rename(&id, &name)
}

#[tauri::command]
async fn soundboard_category_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.soundboard.category_remove(&id)
}

/// Test hook: record `ms` (at most 10 s) from an input such as "CABLE
/// Output", or with `loopback` what an output plays, and measure it. Only
/// with RUDARIFLOW_TEST_COMMANDS=1.
#[tauri::command]
async fn soundboard_capture_test(device: String, ms: u64, loopback: bool) -> Result<engine::Levels, String> {
    if std::env::var("RUDARIFLOW_TEST_COMMANDS").as_deref() != Ok("1") {
        return Err("test commands are off".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || engine::capture_levels(&device, ms.min(10_000), loopback))
        .await
        .map_err(|e| e.to_string())?
}

/// Test hook: the engine's devices, formats and microphone buffer; "off"
/// while off. Only with RUDARIFLOW_TEST_COMMANDS=1.
#[tauri::command]
async fn soundboard_engine_stats(state: State<'_, AppState>) -> Result<engine::EngineStats, String> {
    if std::env::var("RUDARIFLOW_TEST_COMMANDS").as_deref() != Ok("1") {
        return Err("test commands are off".to_string());
    }
    state.soundboard.stats().ok_or_else(|| "off".to_string())
}

/// Open the board in its own window (label "soundboard"), or bring that
/// window to the front. `focus` false leaves the focus where it is (the
/// live checks). Async: building a window in a sync command deadlocks on
/// Windows.
#[tauri::command]
async fn soundboard_pop_out(app: AppHandle, state: State<'_, AppState>, focus: bool) -> Result<(), String> {
    let show_existing = |app: &AppHandle| {
        let window = app.get_webview_window("soundboard")?;
        let _ = window.show();
        let _ = window.unminimize();
        if focus {
            let _ = window.set_focus();
        }
        Some(())
    };
    if show_existing(&app).is_none() {
        let on_top = state.soundboard.board().window.always_on_top;
        let built = WebviewWindowBuilder::new(&app, "soundboard", WebviewUrl::App("soundboard.html".into()))
            .title("RudariFlow Soundboard")
            .inner_size(460.0, 680.0)
            .min_inner_size(380.0, 420.0)
            .resizable(true)
            .always_on_top(on_top)
            .focused(focus)
            .build();
        if let Err(e) = built {
            // A concurrent call built it first: the label exists, which is fine.
            if show_existing(&app).is_none() {
                return Err(e.to_string());
            }
        }
    }
    state.soundboard.set_window(Some(true), None);
    Ok(())
}

/// Close the pop-out window ("Bring back"); the board goes back to its tab.
#[tauri::command]
async fn soundboard_dock(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("soundboard") {
        window.close().map_err(|e| e.to_string())?;
    }
    state.soundboard.set_window(Some(false), None);
    Ok(())
}

/// The pop-out's Always on top switch, remembered for the next pop-out.
#[tauri::command]
async fn soundboard_set_always_on_top(app: AppHandle, state: State<'_, AppState>, on: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("soundboard") {
        window.set_always_on_top(on).map_err(|e| e.to_string())?;
    }
    state.soundboard.set_window(None, Some(on));
    Ok(())
}

/// What a meeting records and transcribes with: the settings now.
fn meeting_config_from(s: &Settings, app_dir: &std::path::Path) -> meeting::Config {
    let ai_model = if !s.ai_cleanup {
        Err("ai_off".to_string())
    } else {
        ai_models::find(&s.ai_model)
            .map(|m| ai_models::model_path(app_dir, m))
            .filter(|p| p.exists())
            .ok_or_else(|| "no_ai_model".to_string())
    };
    meeting::Config {
        microphone: s.microphone.clone(),
        whisper_model: s.whisper_model.clone(),
        model_path: app_dir.join(rudariflow_lib::whisper_engine::model_filename(&s.whisper_model)),
        gpu_backend: s.gpu_backend.clone(),
        language: s.language.clone(),
        dictionary: screen_context::whisper_prompt(&[], &s.custom_prompt),
        terms: dictionary::terms(&s.custom_prompt),
        swiss_spelling: s.swiss_spelling,
        ai_model,
        german: s.ui_language == "de",
        unload_after: s.engine != "local",
    }
}

fn meeting_config(state: &AppState) -> meeting::Config {
    let settings = state.settings.lock().unwrap().clone();
    meeting_config_from(&settings, &state.app_dir)
}

/// Whether a meeting records or runs its end steps (also "Write notes"):
/// the battery watcher keeps the models loaded, and the PC check is refused.
fn meeting_busy(status: &meeting::Status) -> bool {
    status.recording.is_some() || !status.finishing.is_empty()
}

/// Whether a meeting transcribes with Whisper now: it records, or its end
/// steps transcribe the rest. With the cloud engine the Files tab then
/// leaves the model loaded; the meeting unloads it after its transcript.
fn meeting_uses_whisper(status: &meeting::Status) -> bool {
    status.recording.is_some() || status.finishing.iter().any(|f| f.step == meeting::finish::Step::Transcribing)
}

/// The PC check runs: it loads Whisper beside the engine, past the gate
/// that puts dictations, meeting pieces and file blocks in order, so no
/// meeting starts or finishes meanwhile ("pc_check").
static PC_CHECK_RUNNING: AtomicBool = AtomicBool::new(false);

/// Clears `PC_CHECK_RUNNING` when the check ends, however it ends.
struct PcCheckRunning;

impl PcCheckRunning {
    /// "busy" while another check runs.
    fn begin() -> Result<Self, String> {
        if PC_CHECK_RUNNING.swap(true, Ordering::SeqCst) {
            return Err("busy".to_string());
        }
        Ok(PcCheckRunning)
    }
}

impl Drop for PcCheckRunning {
    fn drop(&mut self) {
        PC_CHECK_RUNNING.store(false, Ordering::SeqCst);
    }
}

/// "pc_check" while the PC check runs: a meeting waits for it.
fn pc_check_idle() -> Result<(), String> {
    if PC_CHECK_RUNNING.load(Ordering::SeqCst) {
        Err("pc_check".to_string())
    } else {
        Ok(())
    }
}

/// The tray's "Start meeting" / "Stop meeting" item.
static TRAY_MEETING: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();
/// A meeting records, as the tray item and the pill show it. Read and
/// written on the main thread only (`show_meeting_state`).
static MEETING_SHOWN: AtomicBool = AtomicBool::new(false);

fn tray_meeting_text(german: bool, recording: bool) -> &'static str {
    match (german, recording) {
        (false, false) => "Start meeting",
        (false, true) => "Stop meeting",
        (true, false) => "Meeting starten",
        (true, true) => "Meeting beenden",
    }
}

/// Bring the tray item and the pill's red dot up to date. The work is
/// handed to the main thread, which looks at what is true when it runs
/// (whether a meeting records, the UI language): status events come from
/// several threads and can overtake each other, so the last one handled
/// need not be the newest. Nothing waits for the main thread here, so a
/// thread that stops a meeting never hangs on a main thread that is busy
/// (Quit closes the devices there). `language` also sets the text again
/// when only the UI language changed.
fn show_meeting_state(app: &AppHandle, language: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<AppState>();
        // The status, not `is_recording`: that lock is held while the
        // devices of a starting meeting open.
        let recording = state.meetings.status().recording.is_some();
        let changed = MEETING_SHOWN.swap(recording, Ordering::SeqCst) != recording;
        if changed || language {
            let german = state.settings.lock().unwrap().ui_language == "de";
            if let Some(item) = TRAY_MEETING.get() {
                let _ = item.set_text(tray_meeting_text(german, recording));
            }
        }
        if changed {
            state.recorder.set_meeting_dot(&handle, recording);
        }
    });
}

/// The meetings' changes as events; the tray item and the pill's red dot
/// follow whether a meeting records.
fn meeting_event(event: meeting::Event) {
    let Some(app) = APP_HANDLE.get() else { return };
    match event {
        meeting::Event::Status(status) => {
            let _ = app.emit("meeting-status", status);
            show_meeting_state(app, false);
        }
        meeting::Event::Lines(lines) => {
            let _ = app.emit("meeting-lines", lines);
        }
        meeting::Event::Changed => {
            let _ = app.emit("meetings-changed", ());
        }
        meeting::Event::Playing(playing) => {
            let _ = app.emit("meeting-playing", playing);
        }
        meeting::Event::Limit => pill_notice(app, "meeting-notice", "limit"),
    }
}

/// Presses of the tray item and the hotkey run one after the other, so a
/// second press while the devices open stops the meeting the first started.
static MEETING_TOGGLE: Mutex<()> = Mutex::new(());

/// The tray item and the hotkey: start a meeting, or stop the one that
/// records. Off the main thread (menu clicks and chords arrive there):
/// starting opens the devices and stopping waits for the capture thread.
/// A failed start shows its reason in the pill ("meeting-notice").
fn toggle_meeting(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _one = MEETING_TOGGLE.lock().unwrap_or_else(|p| p.into_inner());
        let state = app.state::<AppState>();
        if state.meetings.is_recording() {
            // "not_recording": the window's Stop or the 4-hour limit was first.
            if let Err(e) = state.meetings.stop() {
                startup_log::log(&format!("[meeting] not stopped: {}", e));
            }
        } else if let Err(e) = pc_check_idle().and_then(|_| state.meetings.start(None, meeting_config(&state))) {
            startup_log::log(&format!("[meeting] not started: {}", e));
            pill_notice(&app, "meeting-notice", &e);
        }
    });
}

/// A meeting command's work on a blocking thread: the meetings read and
/// write files, open devices and wait for threads.
async fn meeting_work<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

/// Start a meeting; `title` empty or missing = "Meeting 3 Oct 2026, 14:00".
/// Errors: "already_recording", "no_model", "disk_full", "pc_check" (the
/// PC check runs) or a file or device error.
#[tauri::command]
async fn meeting_start(state: State<'_, AppState>, title: Option<String>) -> Result<String, String> {
    pc_check_idle()?;
    let (meetings, config) = (state.meetings.clone(), meeting_config(&state));
    meeting_work(move || meetings.start(title, config)).await
}

/// Stop recording; the end steps follow in the background. Error
/// "not_recording".
#[tauri::command]
async fn meeting_stop(state: State<'_, AppState>) -> Result<(), String> {
    let meetings = state.meetings.clone();
    meeting_work(move || meetings.stop()).await
}

/// The status and the meeting that records, with its paragraphs so far.
#[tauri::command]
async fn meeting_state(state: State<'_, AppState>) -> Result<meeting::Current, String> {
    let meetings = state.meetings.clone();
    meeting_work(move || Ok(meetings.state())).await
}

/// The library, newest first, filtered by title and transcript text.
#[tauri::command]
async fn meeting_list(state: State<'_, AppState>, query: Option<String>) -> Result<Vec<meeting::store::Summary>, String> {
    let meetings = state.meetings.clone();
    meeting_work(move || Ok(meetings.list(&query.unwrap_or_default()))).await
}

/// Error "no_meeting".
#[tauri::command]
async fn meeting_get(state: State<'_, AppState>, id: String) -> Result<meeting::MeetingView, String> {
    let meetings = state.meetings.clone();
    meeting_work(move || meetings.get(&id)).await
}

/// Error "empty_name".
#[tauri::command]
async fn meeting_rename(state: State<'_, AppState>, id: String, title: String) -> Result<(), String> {
    let meetings = state.meetings.clone();
    meeting_work(move || meetings.rename(&id, &title)).await
}

/// Name Speaker `speaker + 1` in one meeting ("" = back to "Speaker n").
#[tauri::command]
async fn meeting_rename_speaker(state: State<'_, AppState>, id: String, speaker: u8, name: String) -> Result<(), String> {
    let meetings = state.meetings.clone();
    meeting_work(move || meetings.rename_speaker(&id, speaker, &name)).await
}

/// Tick an action item of the notes. Error "no_item".
#[tauri::command]
async fn meeting_set_action_done(state: State<'_, AppState>, id: String, index: usize, done: bool) -> Result<(), String> {
    let meetings = state.meetings.clone();
    meeting_work(move || meetings.set_action_done(&id, index, done)).await
}

/// Errors: "busy" (it records, finishes or gets its notes), "no_meeting".
#[tauri::command]
async fn meeting_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let meetings = state.meetings.clone();
    meeting_work(move || meetings.delete(&id)).await
}

/// Run the end steps of an interrupted meeting. Errors: "busy",
/// "no_meeting", "not_interrupted", "no_audio" (deleted after 30 days),
/// "no_model" (Whisper is needed and not downloaded), "pc_check".
#[tauri::command]
async fn meeting_finish(state: State<'_, AppState>, id: String) -> Result<(), String> {
    pc_check_idle()?;
    let (meetings, config) = (state.meetings.clone(), meeting_config(&state));
    meeting_work(move || meetings.finish(&id, config)).await
}

/// Write the notes (the "Write notes" button): needs the AI model
/// downloaded ("no_ai_model"), not AI cleanup switched on. Also "busy",
/// "no_meeting"; why the AI wrote none is the meeting's `notesError`.
#[tauri::command]
async fn meeting_write_notes(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let (model, backend) = {
        let s = state.settings.lock().unwrap();
        (ai_models::find(&s.ai_model).map(|m| ai_models::model_path(&state.app_dir, m)), s.gpu_backend.clone())
    };
    let model = model.filter(|p| p.exists()).ok_or_else(|| "no_ai_model".to_string())?;
    let meetings = state.meetings.clone();
    meeting_work(move || meetings.write_notes(&id, model, backend)).await
}

/// Play a meeting from `from_ms` (JS `fromMs`). Errors: "recording" (a
/// meeting records: it would record what plays), "no_audio", "no_meeting"
/// or a device error.
#[tauri::command]
async fn meeting_play(state: State<'_, AppState>, id: String, from_ms: u64) -> Result<(), String> {
    let meetings = state.meetings.clone();
    meeting_work(move || meetings.play(&id, from_ms)).await
}

#[tauri::command]
async fn meeting_stop_playing(state: State<'_, AppState>) -> Result<(), String> {
    let meetings = state.meetings.clone();
    meeting_work(move || {
        meetings.stop_playing();
        Ok(())
    })
    .await
}

/// The title a meeting started now gets, for the title field's placeholder.
#[tauri::command]
async fn meeting_default_title(state: State<'_, AppState>) -> Result<String, String> {
    let german = state.settings.lock().unwrap().ui_language == "de";
    Ok(meeting::store::default_title(german, &rudariflow_lib::replacements::Moment::now()))
}

/// Quit after "Stop the meeting and quit?": the meeting is saved as
/// interrupted at exit (`Meetings::shutdown`), and Finish runs its end
/// steps later.
#[tauri::command]
async fn meeting_quit(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

/// Test hook: play an audio file on the device RUDARIFLOW_MEETING_LOOPBACK
/// names (the virtual cable), never on a real output. Only with
/// RUDARIFLOW_TEST_COMMANDS=1.
#[tauri::command]
async fn meeting_test_play(state: State<'_, AppState>, path: String) -> Result<(), String> {
    if std::env::var("RUDARIFLOW_TEST_COMMANDS").as_deref() != Ok("1") {
        return Err("test commands are off".to_string());
    }
    let meetings = state.meetings.clone();
    meeting_work(move || {
        let samples = media::decode_16k_mono(std::path::Path::new(&path), |_, _| {})?;
        meetings.test_play(samples)
    })
    .await
}

/// Keyboard chords go through the global-shortcut plugin; mouse side buttons
/// (`Mouse4`, `Mouse5`, optionally with modifiers) through a mouse hook.
fn register_hotkey(app: &AppHandle, hotkey: &str, action: HotkeyAction) -> Result<(), String> {
    startup_log::log(&format!("[hotkey] registering {} for {:?}", hotkey, action));
    // Also refuses such a chord saved before this check existed.
    if rudariflow_lib::settings::is_windows_shortcut(hotkey) {
        let msg = format!("'{}' is a Windows shortcut (select all, copy, paste, ...)", hotkey);
        startup_log::log(&format!("[hotkey] {}", msg));
        return Err(msg);
    }
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
                on_hotkey_event(&handle, &action, pressed);
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
            on_hotkey_event(&handle, &action, event.state == ShortcutState::Pressed);
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

/// What a board hotkey sync works from. A sync with the same inputs as the
/// last one has nothing to do (a volume drag, a rename), so keys another
/// program owns are retried only when the board turns on or a hotkey changes.
#[derive(Clone, PartialEq, Debug)]
struct SyncInputs {
    on: bool,
    paused: bool,
    /// The sounds' hotkeys are switched on.
    sound_hotkeys: bool,
    /// The board hotkeys to register: none while off or paused, no sound's
    /// while the sounds' hotkeys are switched off.
    wanted: Vec<(HotkeyAction, String)>,
    /// The app's own five, which a board key never takes over.
    app: Vec<(HotkeyAction, String)>,
}

fn sync_inputs(on: bool, paused: bool, board: &Board, settings: &Settings) -> SyncInputs {
    SyncInputs {
        on,
        paused,
        sound_hotkeys: board.sound_hotkeys,
        wanted: if on && !paused { active_board_hotkeys(board) } else { Vec::new() },
        app: hotkeys(settings).to_vec(),
    }
}

/// The stop-all, toggle and sound hotkeys registered now, with their
/// actions, and the inputs of the last completed sync.
struct BoardHotkeys {
    registered: Vec<(String, HotkeyAction)>,
    last: Option<SyncInputs>,
}

static BOARD_HOTKEYS: Mutex<BoardHotkeys> = Mutex::new(BoardHotkeys { registered: Vec::new(), last: None });
/// A hotkey is being captured in the UI: the board's hotkeys stay released.
static HOTKEYS_PAUSED: AtomicBool = AtomicBool::new(false);

/// Make the registered board hotkeys what the board wants: while it is on
/// and no hotkey is being captured, its stop-all and toggle hotkeys and,
/// while they are switched on, the sounds'; none otherwise. Keys another
/// program or an app hotkey owns are reported to the board ("Taken by
/// another program"). Never on the main thread: registering waits for it.
fn sync_board_hotkeys(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut sync = BOARD_HOTKEYS.lock().unwrap_or_else(|p| p.into_inner());
    let (on, board) = (state.soundboard.is_on(), state.soundboard.board());
    let paused = HOTKEYS_PAUSED.load(Ordering::SeqCst);
    let inputs = sync_inputs(on, paused, &board, &state.settings.lock().unwrap());
    if sync.last.as_ref() == Some(&inputs) {
        return;
    }
    sync.registered.retain(|(hotkey, action)| {
        let owner = app_hotkey_owner(&inputs.app, hotkey);
        let keep = owner.is_none() && inputs.wanted.iter().any(|(a, h)| h == hotkey && a == action);
        if let Some(owner) = owner {
            // An app hotkey has this key now: releasing it would release that one.
            startup_log::log(&format!("[soundboard] hotkey {} left to {:?}", hotkey, owner));
        } else if !keep {
            unregister_hotkey(app, hotkey);
            startup_log::log(&format!("[soundboard] hotkey {} released", hotkey));
        }
        keep
    });
    let mut taken = Vec::new();
    for (action, hotkey) in &inputs.wanted {
        if sync.registered.iter().any(|(h, a)| h == hotkey && a == action) {
            continue;
        }
        if let Some(owner) = app_hotkey_owner(&inputs.app, hotkey) {
            startup_log::log(&format!("[soundboard] hotkey {} not registered: {:?} has it", hotkey, owner));
            taken.push(action.target());
            continue;
        }
        match register_hotkey(app, hotkey, action.clone()) {
            Ok(()) => sync.registered.push((hotkey.clone(), action.clone())),
            Err(_) => taken.push(action.target()),
        }
    }
    sync.last = Some(inputs);
    drop(sync);
    state.soundboard.set_hotkeys_taken(taken);
}

fn spawn_board_hotkey_sync(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || sync_board_hotkeys(&app));
}

/// The soundboard's changes as events for both views. Its hotkeys follow
/// every change and every status (see `sync_board_hotkeys`).
fn soundboard_event(event: soundboard::Event) {
    let Some(app) = APP_HANDLE.get() else { return };
    match event {
        soundboard::Event::Changed => {
            let _ = app.emit("soundboard-changed", ());
            spawn_board_hotkey_sync(app);
        }
        soundboard::Event::Playing(voices) => {
            let _ = app.emit("soundboard-playing", voices);
        }
        soundboard::Event::Status(status) => {
            let _ = app.emit("soundboard-status", status);
            spawn_board_hotkey_sync(app);
        }
    }
}

/// Shared press/release handling for keyboard and mouse hotkeys.
fn on_hotkey(handle: &AppHandle, pressed: bool) {
    let handle = handle.clone();
    let state = handle.state::<AppState>();
    let mode = state.settings.lock().unwrap().recording_mode.clone();
    println!("[RudariFlow] Recording mode: {}", mode);
    *state.last_activity.lock().unwrap() = std::time::Instant::now();

    if pressed {
        tauri::async_runtime::spawn(async move {
            let state = handle.state::<AppState>();
            // Background warmup: kick off model load in parallel
            // with audio capture. Single-flight via the engine's
            // mutex; ignores errors here — they surface at
            // transcription time.
            let s = state.settings.lock().unwrap().clone();
            if let Some(model) = ai_model_to_run(&s, &state.app_dir) {
                state.llm.warm(model, Some(s.gpu_backend.clone()));
            }
            if let Some(model_path) = whisper_model_to_load(&s, &state.app_dir) {
                let engine = state.whisper_engine.clone();
                let backend = s.gpu_backend.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(e) = engine.ensure_loaded(&model_path, &backend) {
                        eprintln!("[RudariFlow] warmup failed: {}", e);
                    }
                });
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
                            Ok(_) => {
                                state.recorder.capture_context(&handle, &s, &state.app_dir);
                                state.recorder.start_pieces(&s, &state.app_dir, &state.whisper_engine);
                            }
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
                        &state.llm,
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
    *state.last_activity.lock().unwrap() = std::time::Instant::now();
    match current_state {
        RecordingState::Ready => {
            let (mic, mute) = {
                let s = state.settings.lock().unwrap();
                (s.microphone.clone(), s.mute_audio)
            };
            state.recorder.start_recording(app, &mic, mute)?;
            let settings = state.settings.lock().unwrap().clone();
            state.recorder.capture_context(app, &settings, &state.app_dir);
            state.recorder.start_pieces(&settings, &state.app_dir, &state.whisper_engine);
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
                    &state.llm,
                )
                .await?;
            Ok(result)
        }
        RecordingState::Transcribing => {
            Err("Currently transcribing, please wait".to_string())
        }
    }
}

/// Window state kept for the main window and the soundboard pop-out.
fn window_state_flags() -> tauri_plugin_window_state::StateFlags {
    tauri_plugin_window_state::StateFlags::SIZE
        | tauri_plugin_window_state::StateFlags::POSITION
        | tauri_plugin_window_state::StateFlags::MAXIMIZED
}

fn main() {
    let app_dir = get_app_dir();
    startup_log::init(&app_dir);
    let settings = Settings::load(&app_dir);
    startup_log::log("settings loaded");
    let history = Arc::new(History::load(&app_dir));
    let soundboard = Soundboard::new(&app_dir, Box::new(soundboard_event));
    let whisper_engine = Arc::new(WhisperEngine::new());
    let llm = Arc::new(LlmServer::new(
        llama_dir(),
        app_dir.join("llm-server.log"),
        Box::new(|status| {
            if let Some(app) = APP_HANDLE.get() {
                let _ = app.emit("ai-status", status);
            }
        }),
    ));
    llm.set_warm_prompt(polish::system_prompt(&settings));
    let meetings = Meetings::new(&app_dir, whisper_engine.clone(), llm.clone(), Box::new(meeting_event));
    let initial_hotkey = settings.hotkey.clone();
    let initial_paste_last_hotkey = settings.paste_last_hotkey.clone();
    let initial_rewrite_last_hotkey = settings.rewrite_last_hotkey.clone();
    let initial_free_gpu_hotkey = settings.free_gpu_hotkey.clone();
    let initial_meeting_hotkey = settings.meeting_hotkey.clone();
    let initial_german = settings.ui_language == "de";
    let initial_autostart = settings.autostart;

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        // Size, position and maximised state of the main window and the
        // soundboard pop-out, restored when they open (not the overlay pill
        // or the hidden PDF export windows). A saved position on no current
        // monitor is not restored; the window then opens centred.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(window_state_flags())
                .with_filter(|label| label == "main" || label == "soundboard")
                // The state file lives in the app's own data folder, so a
                // RUDARIFLOW_DATA_DIR build stays separate from the real one.
                .with_filename(get_app_dir().join(".window-state.json").to_string_lossy())
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--start-minimized"]),
        ))
        .manage(AppState {
            recorder: Recorder::new(),
            settings: Mutex::new(settings),
            app_dir,
            whisper_engine,
            history,
            llm,
            ai_download: Mutex::new(None),
            last_activity: Mutex::new(std::time::Instant::now()),
            gpu: GpuFree::default(),
            soundboard,
            meetings,
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
            ai_status,
            ai_download_model,
            ai_test,
            ai_edit_test,
            pc_check,
            edit_live_test,
            screen_context_test,
            caret_test,
            free_gpu_test,
            ai_restart,
            list_open_apps,
            dictionary_export,
            dictionary_read_file,
            learn_suggestions,
            learn_resolve,
            transcribe_file,
            cancel_file,
            summarize_text,
            format_file_text,
            speaker_model_status,
            speaker_model_download,
            export_file,
            copy_text,
            diag_log,
            soundboard_state,
            soundboard_set_enabled,
            soundboard_devices,
            soundboard_set_devices,
            soundboard_set_volumes,
            soundboard_set_layer,
            soundboard_add,
            soundboard_remove,
            soundboard_rename,
            soundboard_set_category,
            soundboard_set_sound_volume,
            soundboard_set_sound_loop,
            soundboard_set_hotkey,
            soundboard_set_stop_hotkey,
            soundboard_set_sound_hotkeys,
            soundboard_set_toggle_hotkey,
            soundboard_play,
            soundboard_stop_all,
            soundboard_category_add,
            soundboard_category_rename,
            soundboard_category_remove,
            soundboard_capture_test,
            soundboard_engine_stats,
            soundboard_pop_out,
            soundboard_dock,
            soundboard_set_always_on_top,
            meeting_start,
            meeting_stop,
            meeting_state,
            meeting_list,
            meeting_get,
            meeting_rename,
            meeting_rename_speaker,
            meeting_set_action_done,
            meeting_delete,
            meeting_finish,
            meeting_write_notes,
            meeting_play,
            meeting_stop_playing,
            meeting_default_title,
            meeting_quit,
            meeting_test_play,
        ])
        .on_window_event(|window, event| {
            // Close button (X) on the main window hides to tray instead of quitting.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
            // The pop-out closed (its X or Bring back): the board goes back
            // to its tab, and the window's size and position are saved now,
            // not only at a clean exit.
            // A window destroyed mid-capture no longer holds the hotkey pause.
            if matches!(window.label(), "main" | "soundboard") {
                if let WindowEvent::Destroyed = event {
                    // Off the event loop: re-registering a hotkey goes through it.
                    let app = window.app_handle().clone();
                    let label = window.label().to_string();
                    std::thread::spawn(move || release_hotkey_pause(&app, &label));
                }
            }
            if window.label() == "soundboard" {
                if let WindowEvent::Destroyed = event {
                    let app = window.app_handle();
                    app.state::<AppState>().soundboard.set_window(Some(false), None);
                    let _ = app.save_window_state(window_state_flags());
                }
            }
        })
        .setup(move |app| {
            startup_log::log("setup() entered");
            let _ = APP_HANDLE.set(app.handle().clone());
            // Whisper first, then the AI server: llama-server's --fit measures
            // free video memory once, when it loads, so Whisper's share has to
            // be taken by then. The first dictation also skips the Whisper
            // load (1.2 s from a warm disk, 5.7 s cold).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                load_whisper(state.inner()).await;
                warm_ai(state.inner());
                // Installs from before 0.9 have the model but not its drafter.
                if let Some(model) = active_ai_model(state.inner()) {
                    fetch_ai_draft(state.inner(), model).await;
                }
            });
            watch_idle_on_battery(app.handle().clone());
            // The CUDA runtime and Vulkan loader DLLs are load-time imports and
            // are installed next to rudariflow.exe (see tauri.conf.json).
            if let Ok(rd) = app.path().resource_dir() {
                startup_log::log(&format!("resource_dir: {:?}", rd));
            } else {
                startup_log::log("resource_dir: <unresolved>");
            }
            // PDF export pages a quit or crash in the middle of a print left
            // in the temp folder.
            std::thread::spawn(|| {
                let removed = rudariflow_lib::pdf::remove_stale_pages();
                if removed > 0 {
                    startup_log::log(&format!("[export] removed {} stale PDF export pages", removed));
                }
            });

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

            // Paste-last, rewrite, free GPU and meeting are optional: if another app
            // owns the chord, the setting stays and the failure is in startup.log.
            if !initial_paste_last_hotkey.is_empty() {
                let _ = register_hotkey(
                    app.handle(),
                    &initial_paste_last_hotkey,
                    HotkeyAction::PasteLast,
                );
            }
            if !initial_rewrite_last_hotkey.is_empty() {
                let _ = register_hotkey(app.handle(), &initial_rewrite_last_hotkey, HotkeyAction::RewriteLast);
            }
            if !initial_free_gpu_hotkey.is_empty() {
                let _ = register_hotkey(app.handle(), &initial_free_gpu_hotkey, HotkeyAction::FreeGpu);
            }
            if !initial_meeting_hotkey.is_empty() {
                let _ = register_hotkey(app.handle(), &initial_meeting_hotkey, HotkeyAction::Meeting);
            }
            // The virtual microphone was on when RudariFlow last ran: on
            // again. Its hotkeys follow from the status event.
            if app.state::<AppState>().soundboard.board().enabled {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = handle.state::<AppState>();
                    let mic = state.settings.lock().unwrap().microphone.clone();
                    let _ = state.soundboard.turn_on_at_start(&mic);
                });
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
            let meeting_item =
                MenuItem::with_id(app, "meeting", tray_meeting_text(initial_german, false), true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &meeting_item, &quit_item])?;
            let _ = TRAY_MEETING.set(meeting_item);

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
                    "meeting" => toggle_meeting(app),
                    "quit" => {
                        // A meeting that records: the window asks "Stop the
                        // meeting and quit?" (meeting_quit). The status, not
                        // `is_recording`: this is the main thread, and that
                        // lock is held while a starting meeting's devices open.
                        if app.state::<AppState>().meetings.status().recording.is_some() {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                            let _ = app.emit("meeting-quit-asked", ());
                        } else {
                            app.exit(0);
                        }
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let state = app.state::<AppState>();
                state.llm.stop();
                // Keeps the saved switch: on again at the next start.
                state.soundboard.shutdown();
                // A meeting that records is saved as interrupted.
                state.meetings.shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use rudariflow_lib::soundboard::library::Sound;

    #[test]
    fn hotkey_pause_holders_are_per_window() {
        let mut h = PauseHolders::new();
        // Idempotent per label: a second hold by the same window changes nothing.
        assert!(h.hold("main"));
        assert!(!h.hold("main"));
        // Two windows overlapping: only the first starts, only the last ends.
        assert!(!h.hold("soundboard"));
        assert!(!h.release("main"));
        assert!(!h.release("main"));
        assert!(h.release("soundboard"));
        // A stray release with nobody holding is harmless and ends nothing.
        assert!(!h.release("soundboard"));
        assert!(!h.release("main"));
        // A destroyed holder releases; the pause is not wedged afterwards.
        assert!(h.hold("soundboard"));
        assert!(h.release("soundboard"));
        assert!(h.hold("main"));
        assert!(!h.hold("main"));
    }

    #[test]
    fn free_gpu_is_the_fourth_hotkey() {
        assert_eq!(HotkeyAction::from_target("freeGpu"), Ok(HotkeyAction::FreeGpu));
        assert!(HotkeyAction::from_target("freegpu").is_err());
        let mut s = Settings::default();
        s.free_gpu_hotkey = "Alt+Shift+F10".to_string();
        assert_eq!(hotkeys(&s)[3], (HotkeyAction::FreeGpu, "Alt+Shift+F10".to_string()));
    }

    #[test]
    fn a_hotkey_serves_one_action() {
        let mut s = Settings::default();
        s.rewrite_last_hotkey = "Shift+Mouse5".to_string();
        let all = hotkeys(&s);
        assert_eq!(
            taken_by(&all, &HotkeyAction::FreeGpu, "shift+mouse5"),
            Some(HotkeyAction::RewriteLast),
            "mouse bindings by button and modifiers"
        );
        assert_eq!(taken_by(&all, &HotkeyAction::FreeGpu, "cmdorctrl+shift+space"), Some(HotkeyAction::Dictation), "chords without case");
        assert_eq!(taken_by(&all, &HotkeyAction::RewriteLast, "Shift+Mouse5"), None, "its own hotkey");
        assert_eq!(taken_by(&all, &HotkeyAction::FreeGpu, "Alt+Shift+F10"), None);
    }

    fn board_with(stop: &str, sounds: &[(&str, &str, &str)]) -> Board {
        let mut board = Board::default();
        board.stop_hotkey = stop.to_string();
        for (id, name, hotkey) in sounds {
            board.sounds.push(Sound {
                id: id.to_string(),
                name: name.to_string(),
                file: format!("sounds/{}.wav", id),
                category: String::new(),
                hotkey: hotkey.to_string(),
                volume: 1.0,
                duration_ms: 1000,
                looping: false,
            });
        }
        board
    }

    #[test]
    fn sound_and_stop_hotkeys_join_the_conflict_check() {
        let board = board_with("F14", &[("s-a", "airhorn", "F13"), ("s-b", "drums", "")]);
        assert_eq!(
            board_hotkeys(&board),
            vec![(HotkeyAction::StopSounds, "F14".to_string()), (HotkeyAction::Sound("s-a".into()), "F13".to_string())]
        );
        let all = all_hotkeys(&Settings::default(), &board);
        assert_eq!(all.len(), 7, "the app's five and the board's two");
        let drums = HotkeyAction::Sound("s-b".into());
        assert_eq!(taken_by(&all, &drums, "f13"), Some(HotkeyAction::Sound("s-a".into())));
        assert_eq!(taken_by(&all, &drums, "F14"), Some(HotkeyAction::StopSounds));
        assert_eq!(taken_by(&all, &drums, "CmdOrCtrl+Shift+Space"), Some(HotkeyAction::Dictation));
        assert_eq!(
            taken_by(&all, &HotkeyAction::FreeGpu, "F13"),
            Some(HotkeyAction::Sound("s-a".into())),
            "the app's hotkeys cannot take a sound's key"
        );
        assert_eq!(taken_by(&all, &HotkeyAction::Sound("s-a".into()), "F13"), None, "its own");
        assert_eq!(taken_by(&all, &drums, "F15"), None);
    }

    #[test]
    fn a_taken_hotkey_names_its_owner() {
        let board = board_with("", &[("s-a", "air horn", "F13")]);
        assert_eq!(owner_label(&HotkeyAction::Sound("s-a".into()), &board), "sound:air horn");
        assert_eq!(owner_label(&HotkeyAction::StopSounds, &board), "stopSounds");
        assert_eq!(owner_label(&HotkeyAction::Dictation, &board), "dictation");
        assert_eq!(HotkeyAction::Sound("s-a".into()).target(), "s-a");
    }

    #[test]
    fn board_hotkeys_are_checked_before_saving() {
        let board = board_with("", &[("s-a", "airhorn", "F13"), ("s-b", "drums", "")]);
        let all = all_hotkeys(&Settings::default(), &board);
        let drums = HotkeyAction::Sound("s-b".into());
        assert_eq!(check_board_hotkey(&all, &board, &drums, ""), Ok(()), "off");
        assert_eq!(check_board_hotkey(&all, &board, &drums, "Numpad1"), Ok(()), "a key alone");
        assert_eq!(check_board_hotkey(&all, &board, &drums, "Shift+Mouse4"), Ok(()));
        assert!(check_board_hotkey(&all, &board, &drums, "CmdOrCtrl+C").unwrap_err().contains("Windows shortcut"));
        assert!(check_board_hotkey(&all, &board, &drums, "Banana+Q").unwrap_err().contains("not a valid hotkey"));
        assert_eq!(check_board_hotkey(&all, &board, &drums, "F13"), Err("'F13' is already used by sound:airhorn".to_string()));
        assert_eq!(
            check_board_hotkey(&all, &board, &HotkeyAction::StopSounds, "Alt+Shift+V"),
            Err("'Alt+Shift+V' is already used by pasteLast".to_string())
        );
    }

    #[test]
    fn a_key_alone_is_only_a_numpad_or_function_key() {
        let board = board_with("", &[("s-b", "drums", "")]);
        let all = all_hotkeys(&Settings::default(), &board);
        let drums = HotkeyAction::Sound("s-b".into());
        for alone in ["A", "Space", "Enter", "Digit1", "NumpadEnter", "NumpadEqual"] {
            let err = check_board_hotkey(&all, &board, &drums, alone).unwrap_err();
            assert!(err.contains("is a key alone"), "{}: {}", alone, err);
        }
        for ok in ["F1", "F13", "F24", "Numpad5", "NumpadAdd", "Ctrl+NumpadEnter", "Alt+NumpadEqual", "Ctrl+Q", "Alt+A", "Mouse4", "Shift+Mouse5"] {
            assert_eq!(check_board_hotkey(&all, &board, &drums, ok), Ok(()), "{}", ok);
        }
        assert!(check_board_hotkey(&all, &board, &drums, "F25").unwrap_err().contains("not a valid hotkey"));
    }

    #[test]
    fn a_board_key_never_takes_an_app_hotkey() {
        let mut s = Settings::default();
        s.free_gpu_hotkey = "CmdOrCtrl+Mouse4".to_string();
        let app = hotkeys(&s);
        assert_eq!(app_hotkey_owner(&app, "Ctrl+Shift+Space"), Some(HotkeyAction::Dictation), "CmdOrCtrl is Ctrl");
        assert_eq!(app_hotkey_owner(&app, "shift+control+space"), Some(HotkeyAction::Dictation), "any order and case");
        assert_eq!(app_hotkey_owner(&app, "Ctrl+Mouse4"), Some(HotkeyAction::FreeGpu));
        assert_eq!(app_hotkey_owner(&app, "alt+shift+v"), Some(HotkeyAction::PasteLast));
        assert_eq!(app_hotkey_owner(&app, "Mouse4"), None, "other modifiers");
        assert_eq!(app_hotkey_owner(&app, "F13"), None);
        // The conflict check before saving compares the same way.
        let board = board_with("", &[("s-b", "drums", "")]);
        let all = all_hotkeys(&s, &board);
        assert_eq!(taken_by(&all, &HotkeyAction::Sound("s-b".into()), "Ctrl+Shift+Space"), Some(HotkeyAction::Dictation));
    }

    #[test]
    fn only_a_hotkey_or_switch_change_needs_a_sync() {
        let s = Settings::default();
        let mut board = board_with("F14", &[("s-a", "airhorn", "F13")]);
        let before = sync_inputs(true, false, &board, &s);
        board.others_volume = 0.3;
        board.sounds[0].volume = 0.2;
        board.sounds[0].name = "horn".to_string();
        assert_eq!(sync_inputs(true, false, &board, &s), before, "volumes and names");
        assert!(sync_inputs(false, false, &board, &s).wanted.is_empty(), "off");
        assert!(sync_inputs(true, true, &board, &s).wanted.is_empty(), "capturing a hotkey");
        assert_ne!(sync_inputs(false, false, &board, &s), before, "turning on again retries");
        let mut moved = s.clone();
        moved.free_gpu_hotkey = "F13".to_string();
        assert_ne!(sync_inputs(true, false, &board, &moved), before, "an app hotkey changed");
        board.sounds[0].hotkey = "F15".to_string();
        assert_ne!(sync_inputs(true, false, &board, &s), before, "a sound's hotkey changed");
    }

    #[test]
    fn the_toggle_hotkey_joins_the_conflict_check() {
        let mut board = board_with("F14", &[("s-a", "airhorn", "F13")]);
        board.toggle_hotkey = "F15".to_string();
        let all = all_hotkeys(&Settings::default(), &board);
        let toggle = HotkeyAction::ToggleSoundHotkeys;
        assert_eq!(toggle.target(), "toggleSoundHotkeys");
        assert!(HotkeyAction::from_target("toggleSoundHotkeys").is_err(), "not one of the app's five");
        assert_eq!(owner_label(&toggle, &board), "toggleSoundHotkeys");
        assert_eq!(taken_by(&all, &HotkeyAction::Sound("s-a".into()), "f15"), Some(toggle.clone()));
        assert_eq!(taken_by(&all, &HotkeyAction::FreeGpu, "F15"), Some(toggle.clone()), "an app hotkey cannot take it");
        assert_eq!(
            check_board_hotkey(&all, &board, &HotkeyAction::StopSounds, "F15"),
            Err("'F15' is already used by toggleSoundHotkeys".to_string())
        );
        assert_eq!(check_board_hotkey(&all, &board, &toggle, "F13"), Err("'F13' is already used by sound:airhorn".to_string()));
        assert_eq!(check_board_hotkey(&all, &board, &toggle, "F14"), Err("'F14' is already used by stopSounds".to_string()));
        assert_eq!(check_board_hotkey(&all, &board, &toggle, "Alt+Shift+V"), Err("'Alt+Shift+V' is already used by pasteLast".to_string()));
        assert_eq!(check_board_hotkey(&all, &board, &toggle, "F15"), Ok(()), "its own");
        assert!(check_board_hotkey(&all, &board, &toggle, "CmdOrCtrl+V").unwrap_err().contains("Windows shortcut"));
        // While the sound hotkeys are off, the sounds still own their keys.
        board.sound_hotkeys = false;
        let all = all_hotkeys(&Settings::default(), &board);
        assert_eq!(check_board_hotkey(&all, &board, &toggle, "F13"), Err("'F13' is already used by sound:airhorn".to_string()));
        assert_eq!(taken_by(&all, &HotkeyAction::Sound("s-b".into()), "F15"), Some(toggle));
    }

    #[test]
    fn the_toggle_hotkey_follows_the_key_alone_rule() {
        let board = board_with("", &[]);
        let all = all_hotkeys(&Settings::default(), &board);
        let toggle = HotkeyAction::ToggleSoundHotkeys;
        for alone in ["A", "Space", "Enter", "Digit1", "NumpadEnter", "NumpadEqual"] {
            let err = check_board_hotkey(&all, &board, &toggle, alone).unwrap_err();
            assert!(err.contains("is a key alone"), "{}: {}", alone, err);
        }
        for ok in ["F1", "F24", "Numpad0", "NumpadMultiply", "Ctrl+NumpadEnter", "Ctrl+Alt+S", "Mouse5", "Ctrl+Mouse4"] {
            assert_eq!(check_board_hotkey(&all, &board, &toggle, ok), Ok(()), "{}", ok);
        }
    }

    #[test]
    fn sound_hotkeys_are_registered_only_while_switched_on() {
        let s = Settings::default();
        let mut board = board_with("F14", &[("s-a", "airhorn", "F13"), ("s-b", "drums", "")]);
        board.toggle_hotkey = "F15".to_string();
        let stop_and_toggle = vec![
            (HotkeyAction::StopSounds, "F14".to_string()),
            (HotkeyAction::ToggleSoundHotkeys, "F15".to_string()),
        ];
        let mut every = stop_and_toggle.clone();
        every.push((HotkeyAction::Sound("s-a".into()), "F13".to_string()));
        assert_eq!(board_hotkeys(&board), every, "every set board hotkey");
        assert_eq!(active_board_hotkeys(&board), every);
        let on = sync_inputs(true, false, &board, &s);
        assert_eq!(on.wanted, every);
        board.sound_hotkeys = false;
        assert_eq!(active_board_hotkeys(&board), stop_and_toggle, "stop all and the toggle stay");
        assert_eq!(board_hotkeys(&board), every, "the conflict check still sees the sounds' keys");
        let off = sync_inputs(true, false, &board, &s);
        assert_eq!(off.wanted, stop_and_toggle);
        assert_ne!(off, on, "a flip syncs again");
        assert!(sync_inputs(false, false, &board, &s).wanted.is_empty(), "virtual microphone off: none");
        assert!(sync_inputs(true, true, &board, &s).wanted.is_empty(), "capturing a hotkey: none");
        // A board without sound keys still syncs on a flip (the memo has the switch).
        let mut bare = board_with("F14", &[]);
        let before = sync_inputs(true, false, &bare, &s);
        bare.sound_hotkeys = false;
        assert_ne!(sync_inputs(true, false, &bare, &s), before);
    }

    #[test]
    fn the_meeting_hotkey_is_the_fifth_and_joins_the_conflict_check() {
        assert_eq!(HotkeyAction::from_target("meeting"), Ok(HotkeyAction::Meeting));
        assert_eq!(HotkeyAction::Meeting.target(), "meeting");
        let mut s = Settings::default();
        assert_eq!(hotkeys(&s)[4], (HotkeyAction::Meeting, String::new()), "off by default");
        s.meeting_hotkey = "Ctrl+Alt+M".to_string();
        let board = board_with("", &[("s-a", "airhorn", "F13")]);
        let all = all_hotkeys(&s, &board);
        assert_eq!(taken_by(&all, &HotkeyAction::FreeGpu, "ctrl+alt+m"), Some(HotkeyAction::Meeting));
        assert_eq!(taken_by(&all, &HotkeyAction::Meeting, "F13"), Some(HotkeyAction::Sound("s-a".into())));
        assert_eq!(owner_label(&HotkeyAction::Meeting, &board), "meeting");
        assert_eq!(app_hotkey_owner(&hotkeys(&s), "Ctrl+Alt+M"), Some(HotkeyAction::Meeting), "a board key never takes it");
    }

    #[test]
    fn the_tray_item_starts_or_stops_in_the_ui_language() {
        assert_eq!(tray_meeting_text(false, false), "Start meeting");
        assert_eq!(tray_meeting_text(false, true), "Stop meeting");
        assert_eq!(tray_meeting_text(true, false), "Meeting starten");
        assert_eq!(tray_meeting_text(true, true), "Meeting beenden");
    }

    #[test]
    fn a_meeting_records_with_the_settings_at_start() {
        let dir = std::env::temp_dir().join("rudariflow_meeting_config");
        let mut s = Settings {
            custom_prompt: "Prodega".to_string(),
            language: "de".to_string(),
            ui_language: "de".to_string(),
            engine: "cloud".to_string(),
            ..Settings::default()
        };
        let c = meeting_config_from(&s, &dir);
        assert_eq!(c.model_path, dir.join("ggml-small.bin"));
        assert_eq!((c.language.as_str(), c.german, c.unload_after), ("de", true, true));
        assert!(c.dictionary.contains("Prodega"), "{}", c.dictionary);
        assert_eq!(c.terms, ["Prodega"]);
        assert_eq!(c.ai_model, Err("ai_off".to_string()), "notes need AI cleanup on");
        s.ai_cleanup = true;
        assert_eq!(meeting_config_from(&s, &dir).ai_model, Err("no_ai_model".to_string()), "and the model downloaded");
    }

    #[test]
    fn a_meeting_keeps_the_models_and_holds_off_the_pc_check() {
        use rudariflow_lib::meeting::finish::Step;
        use rudariflow_lib::meeting::{Finishing, Recording, Status};
        let finishing = |step| Finishing { id: "m-000000000002".into(), step };
        let idle = Status::default();
        assert!(!meeting_busy(&idle) && !meeting_uses_whisper(&idle));
        let recording = Status {
            recording: Some(Recording { id: "m-000000000001".into(), title: "Call".into(), started_at: 0, warnings: vec![], paused: true }),
            finishing: vec![],
        };
        assert!(meeting_busy(&recording), "the battery watcher waits, the PC check is refused");
        assert!(meeting_uses_whisper(&recording), "also while paused");
        let transcribing = Status { recording: None, finishing: vec![finishing(Step::Transcribing)] };
        assert!(meeting_busy(&transcribing) && meeting_uses_whisper(&transcribing));
        for step in [Step::Speakers, Step::Notes] {
            let later = Status { recording: None, finishing: vec![finishing(step)] };
            assert!(meeting_busy(&later), "{:?}: the AI must not be stopped under the notes", step);
            assert!(!meeting_uses_whisper(&later), "{:?}: the meeting let go of Whisper already", step);
        }
    }

    #[test]
    fn a_summary_says_gpu_freed_only_for_the_release() {
        use rudariflow_lib::llm_server::STOPPED;
        let dir = std::env::temp_dir().join("rudariflow_summary_error");
        let llm = LlmServer::new(dir.join("llama"), dir.join("llm-server.log"), Box::new(|_| {}));
        assert_eq!(summary_error(&llm, "error sending request".into()), "error sending request");
        assert_eq!(summary_wait_error(&llm, STOPPED.into()), STOPPED, "another stop (settings)");
        llm.release();
        assert_eq!(summary_wait_error(&llm, STOPPED.into()), "gpu_freed", "the Free GPU press");
        // A start after the free that failed, e.g. while a game holds the memory.
        let failed = "The AI model failed to load (exit code: 1); see llm-server.log";
        assert_eq!(summary_wait_error(&llm, failed.into()), failed);
        assert_eq!(summary_wait_error(&llm, "The AI model is still loading".into()), "The AI model is still loading");
        // A request the press cut off mid-answer.
        assert_eq!(summary_error(&llm, "error sending request".into()), "gpu_freed");
    }
}
