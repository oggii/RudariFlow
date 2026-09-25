#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use rudariflow_lib::ai_cleanup::AppContext;
use rudariflow_lib::ai_models;
use rudariflow_lib::audio;
use rudariflow_lib::cleanup::cleanup_text;
use rudariflow_lib::dictionary;
use rudariflow_lib::downloader;
use rudariflow_lib::foreground_app;
use rudariflow_lib::history::{self, History, HistoryEntry};
use rudariflow_lib::llm_server::{LlmServer, ServerStatus};
use rudariflow_lib::mouse_hotkey;
use rudariflow_lib::paste::paste_text;
use rudariflow_lib::polish::{self, polish, Polished};
use rudariflow_lib::power;
use rudariflow_lib::recorder::{model_label, transcribe_samples, Recorder, RecordingState};
use rudariflow_lib::send_command::strip_send_command;
use rudariflow_lib::settings::Settings;
use rudariflow_lib::startup_log;
use rudariflow_lib::voice_edit::{self, Edit};
use rudariflow_lib::whisper_engine::WhisperEngine;
use rudariflow_lib::{ai_cleanup, file_transcribe, media, screen_context};

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
}

/// On battery, free the GPU after `power::IDLE_UNLOAD` without dictation
/// (about 5 GB of video memory and 3 GB of RAM with the default models), so
/// a laptop's graphics card can sleep. The next hotkey press loads both
/// again while the user speaks.
fn watch_idle_on_battery(handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let state = handle.state::<AppState>();
            let on_battery = power::on_battery();
            let idle = state.last_activity.lock().unwrap().elapsed();
            let busy = state.recorder.get_state() != RecordingState::Ready;
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

/// Load the Whisper model now instead of at the first dictation.
async fn load_whisper(state: &AppState) {
    let settings = state.settings.lock().unwrap().clone();
    state.whisper_engine.set_flash_attn(settings.flash_attn_pref());
    let Some(model) = whisper_model_to_load(&settings, &state.app_dir) else {
        return;
    };
    let engine = state.whisper_engine.clone();
    let started = std::time::Instant::now();
    let loaded = tauri::async_runtime::spawn_blocking(move || engine.ensure_loaded(&model, &settings.gpu_backend)).await;
    match loaded {
        Ok(Ok(_)) => startup_log::log(&format!("[engine] ready after {} ms", started.elapsed().as_millis())),
        Ok(Err(e)) => startup_log::log(&format!("[engine] load failed: {}", e)),
        Err(e) => startup_log::log(&format!("[engine] load task failed: {}", e)),
    }
}

/// Start the AI server in the background when it should run.
fn warm_ai(state: &AppState) {
    let settings = state.settings.lock().unwrap().clone();
    if let Some(model) = ai_model_to_run(&settings, &state.app_dir) {
        state.llm.warm(model, Some(settings.gpu_backend));
    }
}

/// What a global hotkey does.
#[derive(Clone, Copy, PartialEq, Debug)]
enum HotkeyAction {
    /// Start / stop dictation (the main hotkey).
    Dictation,
    /// Paste the last transcript again.
    PasteLast,
    /// Select the last dictation and record what to change about it.
    RewriteLast,
}

impl HotkeyAction {
    fn from_target(target: &str) -> Result<Self, String> {
        match target {
            "dictation" => Ok(Self::Dictation),
            "pasteLast" => Ok(Self::PasteLast),
            "rewriteLast" => Ok(Self::RewriteLast),
            _ => Err(format!("Unknown hotkey target: {}", target)),
        }
    }
}

/// Every hotkey setting with its action.
fn hotkeys(s: &Settings) -> [(HotkeyAction, String); 3] {
    [
        (HotkeyAction::Dictation, s.hotkey.clone()),
        (HotkeyAction::PasteLast, s.paste_last_hotkey.clone()),
        (HotkeyAction::RewriteLast, s.rewrite_last_hotkey.clone()),
    ]
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
    *state.settings.lock().unwrap() = settings;
    if engine_invalidate {
        state.whisper_engine.invalidate();
        // Load the new model or backend now, not at the next dictation.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            load_whisper(app.state::<AppState>().inner()).await;
        });
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
    /// "no_runtime" or an error text.
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
/// the Engine setting. Errors "busy", "no_model", "no_speech", "cancelled"
/// are shown by the UI in words.
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

        // Speakers: on the CPU while Whisper runs on the GPU.
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
                let handle = std::thread::Builder::new()
                    .name("rf-speakers".into())
                    .spawn(move || {
                        let turns = speakers::separate(&audio, count, &app_dir, &mut |done, total| {
                            if total > 0 {
                                percent.store(done * 100 / total, SeqCst);
                            }
                        });
                        (turns, started.elapsed())
                    })
                    .map_err(|e| e.to_string())?;
                Some(handle)
            }
        };

        emit("loading", 0, 1, String::new());
        engine.ensure_loaded(&model, &settings.gpu_backend)?;
        let terms = dictionary::terms(&settings.custom_prompt);
        let prompt = screen_context::whisper_prompt(&[], &settings.custom_prompt);
        let spelling = |text: &str| {
            let text = dictionary::apply_spelling(&file_transcribe::tidy_segment(text), &terms);
            if settings.swiss_spelling { dictionary::swiss_spelling(&text) } else { text }
        };
        let (mut segments, language) =
            file_transcribe::transcribe(&engine, &audio, &language, &prompt, spelling, &FILE_CANCEL, |p| {
                let text = p.segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
                emit("transcribing", p.done_ms, p.total_ms, text);
            })?;

        let mut found = 0u8;
        if let Some(handle) = separation {
            while !handle.is_finished() {
                if FILE_CANCEL.load(SeqCst) {
                    // The thread finishes on its own; its result is dropped.
                    return Err(file_transcribe::CANCELLED.to_string());
                }
                emit("speakers", percent.load(SeqCst) as u64, 100, String::new());
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            match handle.join() {
                Ok((Ok(turns), took)) => {
                    let spans: Vec<(u64, u64)> = segments.iter().map(|s| (s.start_ms, s.end_ms)).collect();
                    for (segment, speaker) in segments.iter_mut().zip(speakers::assign(&spans, &turns)) {
                        segment.speaker = speaker;
                    }
                    found = segments.iter().filter_map(|s| s.speaker).max().map_or(0, |m| m + 1);
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
    // With the cloud engine the local model is not kept loaded.
    if settings.engine != "local" {
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

/// Summarise a transcript with the AI model, even with AI cleanup off. A
/// long one is summarised in parts first ("summary-progress" events with
/// done and total requests).
#[tauri::command]
async fn summarize_text(app: AppHandle, state: State<'_, AppState>, text: String) -> Result<String, String> {
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
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
        .await?;
    let started = std::time::Instant::now();
    let mut material = text.trim().to_string();
    let chunk_chars = file_transcribe::summary_chunk_chars(&material);
    let mut requests = 0;
    // Each round turns parts into notes; three rounds cover hours of text.
    for _ in 0..3 {
        let parts = file_transcribe::chunks(&material, chunk_chars);
        if parts.len() <= 1 {
            break;
        }
        let mut notes = Vec::new();
        for part in &parts {
            let _ = app.emit("summary-progress", (requests, requests + parts.len() - notes.len() + 1));
            let answer = ai_cleanup::complete_in(
                &endpoint,
                ai_cleanup::LONG_SLOT,
                &file_transcribe::notes_prompt(language),
                part,
                0.2,
                700,
                TIMEOUT,
            )
            .await?;
            notes.push(answer.text.trim().to_string());
            requests += 1;
        }
        material = notes.join("\n");
    }
    let _ = app.emit("summary-progress", (requests, requests + 1));
    let answer = ai_cleanup::complete_in(
        &endpoint,
        ai_cleanup::LONG_SLOT,
        &file_transcribe::summary_prompt(language),
        &material,
        0.2,
        900,
        TIMEOUT,
    )
    .await?;
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
/// server's speed measured, and a report to copy.
#[tauri::command]
async fn pc_check(app: AppHandle, state: State<'_, AppState>) -> Result<PcCheckResult, String> {
    use rudariflow_lib::pc_check as check;
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

/// Restart the AI server, e.g. after it failed twice.
#[tauri::command]
fn ai_restart(state: State<AppState>) {
    state.llm.stop();
    warm_ai(&state);
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

/// `target` is "dictation", "pasteLast" or "rewriteLast"; each takes a
/// keyboard chord or a mouse side button. An empty `new_hotkey` turns
/// paste-last or rewrite off; dictation always needs one.
#[tauri::command]
fn change_hotkey(
    app: tauri::AppHandle,
    state: State<AppState>,
    target: String,
    new_hotkey: String,
) -> Result<(), String> {
    let action = HotkeyAction::from_target(&target)?;
    let all = hotkeys(&state.settings.lock().unwrap());
    let current = all.iter().find(|(a, _)| *a == action).map(|(_, h)| h.clone()).unwrap_or_default();
    if new_hotkey.is_empty() && action == HotkeyAction::Dictation {
        return Err("The dictation hotkey cannot be empty".to_string());
    }
    let same = |h: &str| match (mouse_hotkey::parse(&new_hotkey), mouse_hotkey::parse(h)) {
        (Some(a), Some(b)) => a == b,
        _ => new_hotkey.eq_ignore_ascii_case(h),
    };
    let taken = all.iter().any(|(a, h)| *a != action && !h.is_empty() && same(h));
    if !new_hotkey.is_empty() && taken {
        return Err(format!("'{}' is already used by another hotkey", new_hotkey));
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
        HotkeyAction::RewriteLast => settings.rewrite_last_hotkey = new_hotkey,
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
    let all = hotkeys(&state.settings.lock().unwrap());
    let mut result = Ok(());
    for (action, hotkey) in all {
        if hotkey.is_empty() {
            continue;
        }
        if paused {
            unregister_hotkey(&app, &hotkey);
        } else if !hotkey_is_registered(&app, &hotkey) {
            if let Err(e) = register_hotkey(&app, &hotkey, action) {
                // A paste-last or rewrite chord taken by another app must not
                // block the dictation hotkey; it is logged by register_hotkey.
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
        HotkeyAction::RewriteLast => on_rewrite_hotkey(handle, pressed),
    }
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
    use std::sync::atomic::Ordering;
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

fn main() {
    let app_dir = get_app_dir();
    startup_log::init(&app_dir);
    let settings = Settings::load(&app_dir);
    startup_log::log("settings loaded");
    let history = Arc::new(History::load(&app_dir));
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
    let initial_hotkey = settings.hotkey.clone();
    let initial_paste_last_hotkey = settings.paste_last_hotkey.clone();
    let initial_rewrite_last_hotkey = settings.rewrite_last_hotkey.clone();
    let initial_autostart = settings.autostart;

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
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
            llm,
            ai_download: Mutex::new(None),
            last_activity: Mutex::new(std::time::Instant::now()),
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

            // Paste-last and rewrite are optional: if another app owns the
            // chord, the setting stays and the failure is in startup.log.
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<AppState>().llm.stop();
            }
        });
}
