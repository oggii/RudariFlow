# -*- coding: utf-8 -*-
# The backend additions of Task 3 (speech status, no-model notice, tray and
# pill language) and Task 5 (microphone meter), as exact replacements on a
# copy of src-tauri/src.
import io, sys

SRC = sys.argv[1]


def edit(path, pairs):
    p = SRC + "/" + path
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, old[:70], s.count(old))
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)


# ── whisper_engine.rs: the load state ─────────────────────────────────────
edit(
    "whisper_engine.rs",
    [
        (
            """impl ActiveBackend {
    fn label(&self) -> String {
        match self {
            ActiveBackend::Gpu(d) => format!("{} ({})", d.api.label(), d.name),
            ActiveBackend::Cpu => "CPU".to_string(),
        }
    }
}
""",
            """impl ActiveBackend {
    fn label(&self) -> String {
        match self {
            ActiveBackend::Gpu(d) => format!("{} ({})", d.api.label(), d.name),
            ActiveBackend::Cpu => "CPU".to_string(),
        }
    }

    /// The device as the window names it: "NVIDIA GeForce RTX 5080 (CUDA)", "CPU".
    fn device_name(&self) -> String {
        match self {
            ActiveBackend::Gpu(d) => format!("{} ({})", d.name, d.api.label()),
            ActiveBackend::Cpu => "CPU".to_string(),
        }
    }
}
""",
        ),
        (
            """use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
""",
            """use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
""",
        ),
        (
            """pub struct WhisperEngine {
    inner: Mutex<EngineState>,
    /// Flash attention from the settings (PC check); `None` = per API.
    flash_attn: Mutex<Option<bool>>,
    /// Unloaded by the Free GPU hotkey and not loaded since (see `release`).
    released: AtomicBool,
    /// Who runs next when a dictation, a meeting and a file wait.
    gate: Gate,
}
""",
            """/// What the window's status shows about the model in memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LoadState {
    /// No model in memory: not loaded yet, unloaded or let go of.
    Unloaded,
    /// `ensure_loaded` is loading one.
    Loading,
    Loaded,
    /// The last load failed; the next dictation tries again.
    Failed,
}

impl LoadState {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Loading,
            2 => Self::Loaded,
            3 => Self::Failed,
            _ => Self::Unloaded,
        }
    }
}

pub struct WhisperEngine {
    inner: Mutex<EngineState>,
    /// Flash attention from the settings (PC check); `None` = per API.
    flash_attn: Mutex<Option<bool>>,
    /// Unloaded by the Free GPU hotkey and not loaded since (see `release`).
    released: AtomicBool,
    /// Who runs next when a dictation, a meeting and a file wait.
    gate: Gate,
    /// `LoadState` as a number, read without the engine's lock (which
    /// waits for a load or a transcription that runs).
    load_state: AtomicU8,
    /// Where the loaded model runs (`ActiveBackend::device_name`); empty
    /// while none is loaded.
    device: Mutex<String>,
    /// Called when the load state changes (`on_load_change`).
    load_changed: OnceLock<Box<dyn Fn() + Send + Sync>>,
}
""",
        ),
        (
            """            inner: Mutex::new(EngineState { loaded: None, loads: 0 }),
            flash_attn: Mutex::new(None),
            released: AtomicBool::new(false),
            gate: Gate::new(),
        }
    }
""",
            """            inner: Mutex::new(EngineState { loaded: None, loads: 0 }),
            flash_attn: Mutex::new(None),
            released: AtomicBool::new(false),
            gate: Gate::new(),
            load_state: AtomicU8::new(LoadState::Unloaded as u8),
            device: Mutex::new(String::new()),
            load_changed: OnceLock::new(),
        }
    }

    /// Whether a model is in memory, loading or failed to load. Never waits.
    pub fn load_state(&self) -> LoadState {
        LoadState::from_u8(self.load_state.load(Ordering::SeqCst))
    }

    /// Where the loaded model runs, e.g. "NVIDIA GeForce RTX 5080 (CUDA)";
    /// empty while none is loaded.
    pub fn device(&self) -> String {
        self.device.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Have `changed` called whenever the load state changes or the model
    /// is let go of. Set once, at start. It is called with the engine's
    /// lock held: it must not load, unload or transcribe.
    pub fn on_load_change(&self, changed: Box<dyn Fn() + Send + Sync>) {
        let _ = self.load_changed.set(changed);
    }

    /// True when the state changed (the change was then announced).
    fn set_load_state(&self, state: LoadState) -> bool {
        if state != LoadState::Loaded {
            self.device.lock().unwrap_or_else(|p| p.into_inner()).clear();
        }
        let changed = self.load_state.swap(state as u8, Ordering::SeqCst) != state as u8;
        if changed {
            self.notify_load_change();
        }
        changed
    }

    fn notify_load_change(&self) {
        if let Some(changed) = self.load_changed.get() {
            changed();
        }
    }
""",
        ),
        (
            """    pub fn invalidate(&self) {
        self.lock().loaded = None;
    }
""",
            """    pub fn invalidate(&self) {
        let mut state = self.lock();
        state.loaded = None;
        self.set_load_state(LoadState::Unloaded);
    }
""",
        ),
        (
            """        let mut state = self.lock();
        state.loaded = None;
        self.released.store(true, Ordering::SeqCst);
    }
""",
            """        let mut state = self.lock();
        state.loaded = None;
        let was = self.released.swap(true, Ordering::SeqCst);
        // Let go of while nothing was loaded: the state stays, "freed" is news.
        if !self.set_load_state(LoadState::Unloaded) && !was {
            self.notify_load_change();
        }
    }
""",
        ),
        (
            """        let devices = list_gpu_devices();
        let candidates = backend_candidates(gpu_backend, &devices);
        if candidates.is_empty() {
            let wanted = if gpu_backend == "cuda" { "NVIDIA CUDA" } else { "Vulkan" };
            return Err(format!("No {} GPU found (detected: {:?})", wanted, devices));
        }
""",
            """        self.set_load_state(LoadState::Loading);
        let devices = list_gpu_devices();
        let candidates = backend_candidates(gpu_backend, &devices);
        if candidates.is_empty() {
            let wanted = if gpu_backend == "cuda" { "NVIDIA CUDA" } else { "Vulkan" };
            self.set_load_state(LoadState::Failed);
            return Err(format!("No {} GPU found (detected: {:?})", wanted, devices));
        }
""",
        ),
        (
            """                    state.loads += 1;
                    self.released.store(false, Ordering::SeqCst);
                    return Ok(backend);
""",
            """                    state.loads += 1;
                    self.released.store(false, Ordering::SeqCst);
                    *self.device.lock().unwrap_or_else(|p| p.into_inner()) = backend.device_name();
                    self.set_load_state(LoadState::Loaded);
                    return Ok(backend);
""",
        ),
        (
            """                    last_err = e;
                }
            }
        }
        Err(last_err)
    }
""",
            """                    last_err = e;
                }
            }
        }
        self.set_load_state(LoadState::Failed);
        Err(last_err)
    }
""",
        ),
        (
            """    #[test]
    fn a_meeting_needs_a_loaded_model() {
""",
            """    #[test]
    fn the_load_state_follows_loads_and_unloads() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Arc;
        let engine = WhisperEngine::new();
        let changes = Arc::new(AtomicUsize::new(0));
        let seen = changes.clone();
        engine.on_load_change(Box::new(move || {
            seen.fetch_add(1, Ordering::SeqCst);
        }));
        assert_eq!(engine.load_state(), LoadState::Unloaded);
        assert_eq!(engine.device(), "");
        // A load that fails: loading, then failed.
        assert!(engine.ensure_loaded(Path::new("no-such-model.bin"), "cpu").is_err());
        assert_eq!(engine.load_state(), LoadState::Failed);
        assert_eq!(changes.load(Ordering::SeqCst), 2);
        // A settings change drops the model (and the failure).
        engine.invalidate();
        assert_eq!(engine.load_state(), LoadState::Unloaded);
        assert_eq!(changes.load(Ordering::SeqCst), 3);
        engine.invalidate();
        assert_eq!(changes.load(Ordering::SeqCst), 3, "nothing changed");
        // Free GPU with nothing loaded: still unloaded, but freed is news.
        engine.release();
        assert_eq!(engine.load_state(), LoadState::Unloaded);
        assert_eq!(changes.load(Ordering::SeqCst), 4);
        engine.release();
        assert_eq!(changes.load(Ordering::SeqCst), 4, "already let go of");
        assert_eq!(serde_json::to_string(&LoadState::Loading).unwrap(), "\\"loading\\"");
        assert_eq!(ActiveBackend::Cpu.device_name(), "CPU");
        let card = GpuDevice { gpu_index: 0, api: GpuApi::Cuda, name: "NVIDIA GeForce RTX 5080".into(), integrated: false, memory_mib: 16_303 };
        assert_eq!(ActiveBackend::Gpu(card).device_name(), "NVIDIA GeForce RTX 5080 (CUDA)");
    }

    #[test]
    fn a_meeting_needs_a_loaded_model() {
""",
        ),
    ],
)

# ── audio.rs: the level, and the setup's microphone meter ─────────────────
edit(
    "audio.rs",
    [
        (
            """fn open_stream(
    app: &AppHandle,
    mic_name: &str,
    samples: Arc<Mutex<Vec<f32>>>,
) -> Result<OpenedStream, String> {
    let host = cpal::default_host();

    let device = if mic_name == "default" {
        host.default_input_device()
            .ok_or("No default input device found")?
    } else {
        host.input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|n| n == mic_name).unwrap_or(false))
            .ok_or(format!("Microphone '{}' not found", mic_name))?
    };
    let device_name = device.name().unwrap_or_else(|_| mic_name.to_string());
""",
            """/// The input device `mic_name` names; "default" is Windows' own.
fn input_device(mic_name: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if mic_name == "default" {
        host.default_input_device().ok_or("No default input device found".to_string())
    } else {
        host.input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|n| n == mic_name).unwrap_or(false))
            .ok_or(format!("Microphone '{}' not found", mic_name))
    }
}

/// The level a meter shows for one chunk of samples: its RMS, boosted so a
/// quiet voice still moves the meter, at most 1.
pub(crate) fn meter_level(data: &[f32]) -> f32 {
    let sum_sq: f32 = data.iter().map(|s| s * s).sum();
    let rms = (sum_sq / data.len().max(1) as f32).sqrt();
    (rms * 4.0).min(1.0)
}

fn open_stream(
    app: &AppHandle,
    mic_name: &str,
    samples: Arc<Mutex<Vec<f32>>>,
) -> Result<OpenedStream, String> {
    let device = input_device(mic_name)?;
    let device_name = device.name().unwrap_or_else(|_| mic_name.to_string());
""",
        ),
        (
            """                    last_emit_ms.store(now_ms, Ordering::Relaxed);
                    // RMS over this chunk (mono mix if multi-channel).
                    let sum_sq: f32 = data.iter().map(|s| s * s).sum();
                    let rms = (sum_sq / data.len().max(1) as f32).sqrt();
                    // Boost so quiet voice still moves the meter; cap at 1.
                    let level = (rms * 4.0).min(1.0);
                    let _ = app_handle.emit("audio-level", level);
""",
            """                    last_emit_ms.store(now_ms, Ordering::Relaxed);
                    let _ = app_handle.emit("audio-level", meter_level(data));
""",
        ),
        (
            """/// Interleaved frames at `rate` as mono 16 kHz.
fn mono_16k(""",
            """/// The microphone's level for the first-run setup on Home: "mic-level"
/// events (0 to 1, about 30 a second) while it runs. Nothing is recorded:
/// each chunk is measured and dropped.
pub struct MicMeter {
    stream: Mutex<Option<SendStream>>,
    /// Counts starts and stops: a stream that opens late for an earlier
    /// start is dropped, and the time limit of an earlier start stops
    /// nothing.
    run: AtomicU64,
}

impl Default for MicMeter {
    fn default() -> Self {
        Self::new()
    }
}

impl MicMeter {
    pub fn new() -> Self {
        Self { stream: Mutex::new(None), run: AtomicU64::new(0) }
    }

    /// The number of the start or stop that came last.
    pub fn run(&self) -> u64 {
        self.run.load(Ordering::SeqCst)
    }

    /// Open `mic_name` ("default": Windows' own input) and send its level
    /// until `stop`. Returns the device's name and this start's number.
    /// Like a recording's start, the device is opened on a thread of its
    /// own with a time limit: a sleeping USB interface can take seconds.
    pub fn start(&self, app: &AppHandle, mic_name: &str) -> Result<(String, u64), String> {
        let run = self.run.fetch_add(1, Ordering::SeqCst) + 1;
        *lock(&self.stream) = None;
        let (tx, rx) = std::sync::mpsc::channel();
        let (app, mic) = (app.clone(), mic_name.to_string());
        std::thread::Builder::new()
            .name("rf-mic-meter".into())
            .spawn(move || {
                let _ = tx.send(open_meter(&app, &mic));
            })
            .map_err(|e| e.to_string())?;
        let (stream, name) = match rx.recv_timeout(MIC_OPEN_TIMEOUT) {
            Ok(opened) => opened?,
            Err(_) => return Err(format!("Microphone '{}' did not respond within {} s", mic_name, MIC_OPEN_TIMEOUT.as_secs())),
        };
        // Stopped, or started again, while the device opened: this stream goes.
        if self.run() != run {
            return Err("stopped".to_string());
        }
        *lock(&self.stream) = Some(stream);
        Ok((name, run))
    }

    /// Close the microphone. Fine when the meter is not running.
    pub fn stop(&self) {
        self.run.fetch_add(1, Ordering::SeqCst);
        *lock(&self.stream) = None;
    }

    pub fn running(&self) -> bool {
        lock(&self.stream).is_some()
    }
}

fn open_meter(app: &AppHandle, mic_name: &str) -> Result<(SendStream, String), String> {
    let device = input_device(mic_name)?;
    let name = device.name().unwrap_or_else(|_| mic_name.to_string());
    let config = device.default_input_config().map_err(|e| format!("Failed to get default input config: {}", e))?;
    let config = cpal::StreamConfig {
        channels: config.channels(),
        sample_rate: config.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };
    let app = app.clone();
    let last_emit_ms = AtomicU64::new(0);
    let start = std::time::Instant::now();
    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let now_ms = start.elapsed().as_millis() as u64;
                if now_ms.saturating_sub(last_emit_ms.load(Ordering::Relaxed)) >= 33 {
                    last_emit_ms.store(now_ms, Ordering::Relaxed);
                    let _ = app.emit("mic-level", meter_level(data));
                }
            },
            |err| startup_log::log(&format!("[audio] meter stream error: {}", err)),
            None,
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((SendStream(stream), name))
}

/// Interleaved frames at `rate` as mono 16 kHz.
fn mono_16k(""",
        ),
        (
            """    #[test]
    fn speech_spans_split_at_long_pauses_only() {
""",
            """    #[test]
    fn the_meter_level_is_zero_for_silence_and_capped_for_loud() {
        assert_eq!(meter_level(&[]), 0.0);
        assert_eq!(meter_level(&[0.0; 480]), 0.0);
        // A quiet voice (RMS 0.05) still moves the meter.
        let quiet = meter_level(&[0.05; 480]);
        assert!((quiet - 0.2).abs() < 1e-4, "{}", quiet);
        assert_eq!(meter_level(&[0.9; 480]), 1.0);
    }

    #[test]
    fn a_meter_that_is_not_running_stops_quietly() {
        let meter = MicMeter::new();
        assert!(!meter.running());
        assert_eq!(meter.run(), 0);
        meter.stop();
        meter.stop();
        assert!(!meter.running());
        assert_eq!(meter.run(), 2, "each stop counts, so an earlier start's time limit stops nothing");
    }

    #[test]
    fn speech_spans_split_at_long_pauses_only() {
""",
        ),
    ],
)

# ── main.rs ───────────────────────────────────────────────────────────────
edit(
    "main.rs",
    [
        (
            "use rudariflow_lib::whisper_engine::WhisperEngine;\n",
            "use rudariflow_lib::whisper_engine::{LoadState, WhisperEngine};\n",
        ),
        (
            """    /// Meeting mode: the meeting that records, the ones finishing, ▶.
    meetings: Arc<Meetings>,
}
""",
            """    /// Meeting mode: the meeting that records, the ones finishing, ▶.
    meetings: Arc<Meetings>,
    /// The microphone's level for the first-run setup on Home.
    mic_meter: audio::MicMeter,
}
""",
        ),
        (
            """/// Start the AI server in the background when the settings use it.
fn start_ai(state: &AppState) {
""",
            """/// The speech model's state for the window's status (`speech_status`, and
/// "speech-status" whenever it changes).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeechStatus {
    /// "local" or "cloud".
    engine: String,
    /// The selected Whisper model, e.g. "small".
    model: String,
    /// The selected model's file is there.
    downloaded: bool,
    load: LoadState,
    /// Unloaded by Free GPU, for a game or when idle; the next dictation
    /// loads it.
    freed: bool,
    /// The cloud engine has an API key.
    cloud_key: bool,
    /// Where the model runs while it is loaded; empty otherwise.
    device: String,
}

/// `SpeechStatus` from its parts. The cloud engine loads nothing for a
/// dictation (a meeting's local model is not the dictation's): it is never
/// "loaded", "failed" or "freed".
fn speech_status_of(settings: &Settings, downloaded: bool, load: LoadState, freed: bool, device: String) -> SpeechStatus {
    let local = settings.engine == "local";
    let load = if local { load } else { LoadState::Unloaded };
    SpeechStatus {
        engine: settings.engine.clone(),
        model: settings.whisper_model.clone(),
        downloaded,
        load,
        freed: local && freed && load == LoadState::Unloaded,
        cloud_key: !settings.groq_api_key.trim().is_empty(),
        device: if load == LoadState::Loaded { device } else { String::new() },
    }
}

fn speech_status_now(state: &AppState) -> SpeechStatus {
    let settings = state.settings.lock().unwrap().clone();
    let downloaded = state.app_dir.join(rudariflow_lib::whisper_engine::model_filename(&settings.whisper_model)).exists();
    let freed = state.whisper_engine.released() || state.gpu.idle_unloaded.load(Ordering::SeqCst);
    speech_status_of(&settings, downloaded, state.whisper_engine.load_state(), freed, state.whisper_engine.device())
}

/// Tell the window the speech model's state ("speech-status"). On a task of
/// its own: the engine calls this with its lock held, and the settings
/// lock is taken here.
fn emit_speech_status() {
    let Some(app) = APP_HANDLE.get() else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let status = speech_status_now(app.state::<AppState>().inner());
        let _ = app.emit("speech-status", status);
    });
}

/// Why a dictation cannot start with these settings: "no_model" while the
/// local engine's model is not downloaded. The pill then says so
/// ("speech-notice") instead of a recording that ends in nothing.
fn dictation_blocked(settings: &Settings, model_downloaded: bool) -> Option<&'static str> {
    (settings.engine == "local" && !model_downloaded).then_some("no_model")
}

/// Start the AI server in the background when the settings use it.
fn start_ai(state: &AppState) {
""",
        ),
        (
            """    let warm_prompt = polish::system_prompt(&settings);
    let language_changed = state.settings.lock().unwrap().ui_language != settings.ui_language;
    let games = settings.free_gpu_for_games;
""",
            """    let warm_prompt = polish::system_prompt(&settings);
    let language_changed = state.settings.lock().unwrap().ui_language != settings.ui_language;
    let ui_language = settings.ui_language.clone();
    let games = settings.free_gpu_for_games;
""",
        ),
        (
            """    if language_changed {
        show_meeting_state(&app, true);
    }
    if engine_invalidate {
""",
            """    if language_changed {
        // The tray's items, and the pill (it has its own small table).
        show_meeting_state(&app, true);
        let _ = app.emit("ui-language", ui_language);
    }
    // The engine, the model or the cloud key may be another now.
    emit_speech_status();
    if engine_invalidate {
""",
        ),
        (
            """#[tauri::command]
fn get_recording_state(state: State<AppState>) -> RecordingState {
    state.recorder.get_state()
}
""",
            """#[tauri::command]
fn get_recording_state(state: State<AppState>) -> RecordingState {
    state.recorder.get_state()
}

/// The speech model for the window's status: which, downloaded, loaded.
#[tauri::command]
fn speech_status(state: State<AppState>) -> SpeechStatus {
    speech_status_now(&state)
}

/// First-run setup on Home: send the microphone's level ("mic-level") until
/// `mic_meter_stop`, at most `MIC_METER_MAX`. Returns the device's name.
#[tauri::command]
async fn mic_meter_start(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let mic = state.settings.lock().unwrap().microphone.clone();
    let handle = app.clone();
    let (name, run) = tauri::async_runtime::spawn_blocking(move || handle.state::<AppState>().mic_meter.start(&handle, &mic))
        .await
        .map_err(|e| e.to_string())??;
    // A window that never says stop (hidden, crashed page) does not keep
    // the microphone open.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(MIC_METER_MAX).await;
        let state = app.state::<AppState>();
        if state.mic_meter.run() == run {
            state.mic_meter.stop();
        }
    });
    Ok(name)
}

#[tauri::command]
fn mic_meter_stop(state: State<AppState>) {
    state.mic_meter.stop();
}

/// The longest the setup's microphone meter runs without a new start.
const MIC_METER_MAX: std::time::Duration = std::time::Duration::from_secs(120);
""",
        ),
        (
            """    let dest = state.app_dir.join(&model_file);
    downloader::download_model(app, &url, &dest, "download-progress").await
}
""",
            """    let dest = state.app_dir.join(&model_file);
    downloader::download_model(app.clone(), &url, &dest, "download-progress").await?;
    // The model the settings use is there now: load it, so the status says
    // Ready before the first dictation (not after a Free GPU press: then
    // the next use loads it).
    let selected = state.settings.lock().unwrap().whisper_model == model_size;
    if selected && !state.whisper_engine.released() {
        tauri::async_runtime::spawn(async move {
            load_whisper(app.state::<AppState>().inner()).await;
        });
    }
    emit_speech_status();
    Ok(())
}
""",
        ),
        (
            """fn tray_meeting_text(german: bool, recording: bool) -> &'static str {
""",
            """/// The tray's "Show RudariFlow" and "Quit" items; their texts follow the
/// Display Language like the meeting item's.
static TRAY_SHOW: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();
static TRAY_QUIT: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();

fn tray_show_text(german: bool) -> &'static str {
    if german {
        "RudariFlow anzeigen"
    } else {
        "Show RudariFlow"
    }
}

fn tray_quit_text(german: bool) -> &'static str {
    if german {
        "Beenden"
    } else {
        "Quit"
    }
}

fn tray_meeting_text(german: bool, recording: bool) -> &'static str {
""",
        ),
        (
            """            if let Some(item) = TRAY_MEETING.get() {
                let _ = item.set_text(tray_meeting_text(german, recording));
            }
        }
""",
            """            if let Some(item) = TRAY_MEETING.get() {
                let _ = item.set_text(tray_meeting_text(german, recording));
            }
            if language {
                if let Some(item) = TRAY_SHOW.get() {
                    let _ = item.set_text(tray_show_text(german));
                }
                if let Some(item) = TRAY_QUIT.get() {
                    let _ = item.set_text(tray_quit_text(german));
                }
            }
        }
""",
        ),
        (
            """            let starting = state.recorder.get_state() == RecordingState::Ready;
            if starting {
                dictation_started(state.inner());
            }
""",
            """            let starting = state.recorder.get_state() == RecordingState::Ready;
            if starting {
                // No speech model yet: say so in the pill and record nothing.
                let blocked = {
                    let s = state.settings.lock().unwrap();
                    let model = state.app_dir.join(rudariflow_lib::whisper_engine::model_filename(&s.whisper_model));
                    dictation_blocked(&s, model.exists())
                };
                if let Some(reason) = blocked {
                    startup_log::log(&format!("[hotkey] no dictation: {}", reason));
                    state.recorder.notice(&handle, "speech-notice", reason);
                    return;
                }
                dictation_started(state.inner());
            }
""",
        ),
        (
            """    let whisper_engine = Arc::new(WhisperEngine::new());
""",
            """    let whisper_engine = Arc::new(WhisperEngine::new());
    whisper_engine.on_load_change(Box::new(emit_speech_status));
""",
        ),
        (
            """            soundboard,
            meetings,
        })
""",
            """            soundboard,
            meetings,
            mic_meter: audio::MicMeter::new(),
        })
""",
        ),
        (
            """            get_recording_state,
            check_model_downloaded,
""",
            """            get_recording_state,
            speech_status,
            mic_meter_start,
            mic_meter_stop,
            check_model_downloaded,
""",
        ),
        (
            """            let show_item = MenuItem::with_id(app, "show", "Show RudariFlow", true, None::<&str>)?;
""",
            """            let show_item = MenuItem::with_id(app, "show", tray_show_text(initial_german), true, None::<&str>)?;
""",
        ),
        (
            """            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &meeting_item, &quit_item])?;
            let _ = TRAY_MEETING.set(meeting_item);
""",
            """            let quit_item = MenuItem::with_id(app, "quit", tray_quit_text(initial_german), true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &meeting_item, &quit_item])?;
            let _ = TRAY_MEETING.set(meeting_item);
            let _ = TRAY_SHOW.set(show_item);
            let _ = TRAY_QUIT.set(quit_item);
""",
        ),
        (
            """    #[test]
    fn the_tray_item_starts_or_stops_in_the_ui_language() {
""",
            """    #[test]
    fn the_tray_menu_follows_the_display_language() {
        assert_eq!((tray_show_text(false), tray_quit_text(false)), ("Show RudariFlow", "Quit"));
        assert_eq!((tray_show_text(true), tray_quit_text(true)), ("RudariFlow anzeigen", "Beenden"));
    }

    #[test]
    fn the_speech_status_says_what_a_dictation_needs() {
        let local = Settings::default();
        let ready = speech_status_of(&local, true, LoadState::Loaded, false, "NVIDIA GeForce RTX 5080 (CUDA)".into());
        assert_eq!(
            (ready.engine.as_str(), ready.model.as_str(), ready.downloaded, ready.load, ready.freed, ready.device.as_str()),
            ("local", "small", true, LoadState::Loaded, false, "NVIDIA GeForce RTX 5080 (CUDA)")
        );
        // Freed counts only while nothing is loaded (the idle flag outlives a reload).
        assert!(!speech_status_of(&local, true, LoadState::Loaded, true, "CPU".into()).freed);
        let freed = speech_status_of(&local, true, LoadState::Unloaded, true, "stale".into());
        assert!(freed.freed);
        assert_eq!(freed.device, "", "no device while nothing is loaded");
        // The cloud engine: its key counts; the local model's state does not show.
        let cloud = Settings { engine: "cloud".into(), groq_api_key: " gsk_x ".into(), ..Settings::default() };
        let c = speech_status_of(&cloud, false, LoadState::Failed, true, "CPU".into());
        assert_eq!((c.cloud_key, c.load, c.freed, c.device.as_str()), (true, LoadState::Unloaded, false, ""));
        assert!(!speech_status_of(&Settings { groq_api_key: "  ".into(), ..cloud }, false, LoadState::Unloaded, false, String::new()).cloud_key);
        // The window reads camelCase and lower-case states.
        let json = serde_json::to_string(&ready).unwrap();
        for part in ["\\"cloudKey\\":false", "\\"load\\":\\"loaded\\"", "\\"downloaded\\":true"] {
            assert!(json.contains(part), "{} in {}", part, json);
        }
    }

    #[test]
    fn a_dictation_without_a_speech_model_is_not_started() {
        let local = Settings::default();
        assert_eq!(dictation_blocked(&local, false), Some("no_model"));
        assert_eq!(dictation_blocked(&local, true), None);
        // The cloud engine needs no local model.
        let cloud = Settings { engine: "cloud".into(), ..Settings::default() };
        assert_eq!(dictation_blocked(&cloud, false), None);
    }

    #[test]
    fn the_tray_item_starts_or_stops_in_the_ui_language() {
""",
        ),
    ],
)
print("ok")
