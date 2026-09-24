use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::ai_cleanup::AppContext;
use crate::audio::{lock, samples_to_wav, AudioRecorder};
use crate::cleanup::cleanup_text;
use crate::dictionary;
use crate::foreground_app;
use crate::history::History;
use crate::llm_server::LlmServer;
use crate::mute;
use crate::paste::{paste_text_timed, press_delete, press_submit};
use crate::polish::polish;
use crate::screen_context;
use crate::selection::{self, Target};
use crate::send_command::strip_send_command;
use crate::settings::Settings;
use crate::startup_log;
use crate::transcribe_groq;
use crate::voice_edit::{self, Edit};
use crate::whisper_engine::WhisperEngine;

/// Start of the error an Edit mode failure returns; the pill then says the
/// text was left unchanged.
const EDIT_FAILED: &str = "edit failed";

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum RecordingState {
    Ready,
    Recording,
    Transcribing,
}

fn update_overlay(app: &AppHandle, state: &RecordingState) {
    let Some(overlay) = app.get_webview_window("overlay") else {
        startup_log::log("[overlay] no window handle");
        return;
    };

    let was_visible = overlay.is_visible().unwrap_or(false);
    let pos = overlay.outer_position().ok();
    let size = overlay.outer_size().ok();
    startup_log::log(&format!(
        "[overlay] update_overlay state={:?} pre_visible={} pos={:?} size={:?}",
        state, was_visible, pos, size
    ));

    match state {
        RecordingState::Ready => {
            if let Err(e) = overlay.hide() {
                startup_log::log(&format!("[overlay] hide() failed: {}", e));
            }
        }
        RecordingState::Recording | RecordingState::Transcribing => {
            // Defensive: force always-on-top off then on, then show.
            // This kicks Windows' compositor into re-stacking the window correctly
            // after fullscreen apps / monitor switches have left it stale.
            // We deliberately do NOT call set_focus() — stealing focus would break
            // the auto-paste target since the user is typing in another app.
            let _ = overlay.set_always_on_top(false);
            let _ = overlay.set_always_on_top(true);
            if let Err(e) = overlay.show() {
                startup_log::log(&format!("[overlay] show() failed: {}", e));
            }
        }
    }
    let class = match state {
        RecordingState::Ready => "ready",
        RecordingState::Recording => "recording",
        RecordingState::Transcribing => "transcribing",
    };
    let js = format!(
        "document.body.dataset.state = '{}'; if (window.__overlayUpdate) window.__overlayUpdate('{}'); window.__rfPing && window.__rfPing('post-eval-{}');",
        class, class, class
    );
    if let Err(e) = overlay.eval(&js) {
        startup_log::log(&format!("[overlay] eval() failed: {}", e));
    }

    let post_visible = overlay.is_visible().unwrap_or(false);
    startup_log::log(&format!(
        "[overlay] update_overlay done state={:?} post_visible={}",
        state, post_visible
    ));
}

/// The pill shows the Whisper text with a "Polishing" label while the AI runs.
fn show_polishing(app: &AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.eval(
            "document.body.dataset.state = 'polishing'; if (window.__overlayUpdate) window.__overlayUpdate('polishing');",
        );
    }
}

/// The pill's chip: how many words the dictation will edit, or none.
fn emit_edit_target(app: &AppHandle, words: Option<usize>) {
    let _ = app.emit("edit-target", words);
}

/// Screen terms of the recording `generation`, filled in the background.
type ScreenSlot = Arc<Mutex<Option<(u64, Vec<String>)>>>;

/// Step times of one dictation from the stop press on, logged as one
/// "[timing]" line in startup.log.
struct Laps {
    kind: &'static str,
    started: Instant,
    last: Instant,
    steps: Vec<String>,
    audio_secs: Option<f32>,
}

impl Laps {
    fn new() -> Self {
        let now = Instant::now();
        Self { kind: "dictation", started: now, last: now, steps: Vec::new(), audio_secs: None }
    }

    /// The time since the previous step goes to `name`.
    fn lap(&mut self, name: &str) {
        let now = Instant::now();
        self.steps.push(format!("{} {}", name, (now - self.last).as_millis()));
        self.last = now;
    }

    /// Extra information for the line, without a time.
    fn note(&mut self, text: String) {
        self.steps.push(text);
    }

    /// A step measured by the callee; the next lap starts after it.
    fn add(&mut self, name: &str, took: Duration) {
        self.steps.push(format!("{} {}", name, took.as_millis()));
        self.last += took;
    }

    fn log(&self) {
        let audio = self.audio_secs.map(|s| format!(" ({:.1} s audio)", s)).unwrap_or_default();
        startup_log::log(&format!(
            "[timing] {} {} ms: {}{}",
            self.kind,
            self.started.elapsed().as_millis(),
            self.steps.join(", "),
            audio
        ));
    }
}

/// How long the release waits for the screen terms of a very short
/// recording before it goes on without them.
const SCREEN_WAIT: std::time::Duration = std::time::Duration::from_millis(250);

/// The selection the dictation edits, read on release; `None` means a normal
/// dictation.
async fn edit_selection(settings: &Settings, app_dir: &Path, ctx: &AppContext) -> Option<String> {
    if !voice_edit::available(settings, app_dir, ctx) {
        return None;
    }
    match tauri::async_runtime::spawn_blocking(selection::read).await {
        Ok(Target::Selected(text)) => Some(text),
        Ok(Target::None(reason)) => {
            if reason != "nothing selected" {
                startup_log::log(&format!("[edit] not editing: {}", reason));
            }
            None
        }
        Err(_) => None,
    }
}

fn emit_audio_empty(app: &AppHandle, state: Arc<Mutex<RecordingState>>) {
    show_notice(app, state, "audio-empty", 1700);
}

/// Briefly show the overlay with a notice (`audio-empty`, `mic-error`) so a
/// failed hotkey press is visible instead of silently doing nothing.
fn show_notice(app: &AppHandle, state: Arc<Mutex<RecordingState>>, event: &str, hide_after_ms: u64) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.set_always_on_top(false);
        let _ = overlay.set_always_on_top(true);
        let _ = overlay.show();
    }
    let _ = app.emit(event, ());
    let app_clone = app.clone();
    let state_clone = state.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(hide_after_ms)).await;
        // If a new recording started during the grace window, leave the
        // overlay alone — don't hide it mid-dictation.
        let current = lock(&state_clone).clone();
        if current == RecordingState::Ready {
            if let Some(overlay) = app_clone.get_webview_window("overlay") {
                let _ = overlay.hide();
            }
        }
    });
}

pub struct Recorder {
    state: Arc<Mutex<RecordingState>>,
    audio_recorder: Arc<Mutex<AudioRecorder>>,
    /// Set while the microphone is being opened, so the state lock is never
    /// held across device I/O.
    starting: AtomicBool,
    /// Screen context read when the recording started.
    screen: ScreenSlot,
    /// Counts recordings, so a slow read never lands in a later one.
    generation: AtomicU64,
}

/// Resets the recorder to Ready when dropped, including when transcription
/// panics, so a crash can never leave the app stuck in Transcribing.
struct ReadyOnDrop<'a> {
    app: &'a AppHandle,
    state: &'a Arc<Mutex<RecordingState>>,
}

impl Drop for ReadyOnDrop<'_> {
    fn drop(&mut self) {
        mute::restore();
        *lock(self.state) = RecordingState::Ready;
        let _ = self.app.emit("recording-state", RecordingState::Ready);
        update_overlay(self.app, &RecordingState::Ready);
    }
}

impl Recorder {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(RecordingState::Ready)),
            audio_recorder: Arc::new(Mutex::new(AudioRecorder::new())),
            starting: AtomicBool::new(false),
            screen: Arc::new(Mutex::new(None)),
            generation: AtomicU64::new(0),
        }
    }

    pub fn get_state(&self) -> RecordingState {
        lock(&self.state).clone()
    }

    /// Called right after recording starts, in the background: shows the
    /// Edit mode chip when text is selected (decided again on release) and
    /// reads the screen context for this recording.
    pub fn capture_context(&self, app: &AppHandle, settings: &Settings, app_dir: &Path) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *lock(&self.screen) = None;
        let edit = voice_edit::available(settings, app_dir, &foreground_app::current());
        let screen = settings.screen_context;
        if !edit && !screen {
            return;
        }
        let dictionary = dictionary::terms(&settings.custom_prompt);
        let (app, slot) = (app.clone(), self.screen.clone());
        tauri::async_runtime::spawn_blocking(move || {
            if edit {
                if let Target::Selected(text) = selection::read() {
                    emit_edit_target(&app, Some(selection::word_count(&text)));
                }
            }
            if screen {
                let started = std::time::Instant::now();
                let text = screen_context::read_window_text(screen_context::MAX_CHARS).unwrap_or_default();
                let terms = screen_context::terms(&text, &dictionary, screen_context::MAX_TERMS);
                startup_log::log(&format!(
                    "[screen] {} terms from {} chars in {} ms",
                    terms.len(),
                    text.chars().count(),
                    started.elapsed().as_millis()
                ));
                *lock(&slot) = Some((generation, terms));
            }
        });
    }

    /// The screen terms of the current recording, waiting briefly when the
    /// read is still running.
    async fn take_screen_terms(&self, settings: &Settings) -> Vec<String> {
        if !settings.screen_context {
            return Vec::new();
        }
        let generation = self.generation.load(Ordering::SeqCst);
        let started = std::time::Instant::now();
        loop {
            if let Some((g, terms)) = lock(&self.screen).take() {
                if g == generation {
                    return terms;
                }
            }
            if started.elapsed() >= SCREEN_WAIT {
                startup_log::log("[screen] not ready, dictating without it");
                return Vec::new();
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    /// Start capturing. With `mute_others`, other apps are muted until the
    /// recording stops or is cancelled.
    pub fn start_recording(&self, app: &AppHandle, mic_name: &str, mute_others: bool) -> Result<(), String> {
        if *lock(&self.state) != RecordingState::Ready {
            return Err("Already recording or transcribing".to_string());
        }
        if self
            .starting
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("Microphone is still opening".to_string());
        }

        let opened = lock(&self.audio_recorder).start(app, mic_name);
        let result = match opened {
            Ok(()) => {
                if mute_others {
                    mute::mute_others();
                }
                *lock(&self.state) = RecordingState::Recording;
                let _ = app.emit("recording-state", RecordingState::Recording);
                update_overlay(app, &RecordingState::Recording);
                Ok(())
            }
            Err(e) => {
                startup_log::log(&format!("[recorder] start failed: {}", e));
                show_notice(app, self.state.clone(), "mic-error", 2600);
                Err(e)
            }
        };
        self.starting.store(false, Ordering::SeqCst);
        result
    }

    pub async fn stop_and_transcribe(
        &self,
        app: &AppHandle,
        settings: &Settings,
        app_dir: &PathBuf,
        engine: &Arc<WhisperEngine>,
        history: &History,
        llm: &Arc<LlmServer>,
    ) -> Result<String, String> {
        let mut laps = Laps::new();
        // The app the text will go into, read before anything else can take focus.
        let mut ctx = foreground_app::current();
        let selection = if *lock(&self.state) == RecordingState::Recording {
            edit_selection(settings, app_dir, &ctx).await
        } else {
            None
        };

        // Stop recording
        {
            let mut state = lock(&self.state);
            if *state != RecordingState::Recording {
                return Err("Not currently recording".to_string());
            }
            *state = RecordingState::Transcribing;
        }
        mute::restore();
        let _ = app.emit("recording-state", RecordingState::Transcribing);
        emit_edit_target(app, selection.as_deref().map(selection::word_count));
        update_overlay(app, &RecordingState::Transcribing);

        // Always reset state to Ready, regardless of success, failure or panic.
        let ready = ReadyOnDrop { app, state: &self.state };
        laps.lap("start");

        ctx.screen_terms = self.take_screen_terms(settings).await;
        laps.lap("screen wait");
        let result = self
            .run_transcription_pipeline(app, settings, app_dir, engine, history, llm, &ctx, selection, &mut laps)
            .await;
        if let Err(e) = &result {
            startup_log::log(&format!("[recorder] transcription failed: {}", e));
        }
        drop(ready);
        laps.lap("ready");
        laps.log();
        if result.as_ref().is_err_and(|e| e.starts_with(EDIT_FAILED)) {
            show_notice(app, self.state.clone(), "edit-failed", 2600);
        }
        result
    }

    async fn run_transcription_pipeline(
        &self,
        app: &AppHandle,
        settings: &Settings,
        app_dir: &PathBuf,
        engine: &Arc<WhisperEngine>,
        history: &History,
        llm: &Arc<LlmServer>,
        ctx: &AppContext,
        selection: Option<String>,
        laps: &mut Laps,
    ) -> Result<String, String> {
        let taken = lock(&self.audio_recorder).stop_and_take_samples();
        laps.lap("audio");
        let samples = match taken {
            Err(e) if e == "no_speech" => {
                laps.kind = "no speech";
                emit_audio_empty(app, self.state.clone());
                return Ok(String::new());
            }
            other => other?,
        };
        laps.audio_secs = Some(samples.len() as f32 / 16_000.0);

        let (raw_text, language) =
            transcribe_samples(Some(app), settings, app_dir, engine, &samples, &ctx.screen_terms).await?;
        laps.lap("whisper");
        // Only the screen terms the dictation (or the selection it edits)
        // mentions go to the AI; each one costs prompt time.
        let mut ctx = ctx.clone();
        if !ctx.screen_terms.is_empty() {
            let heard = match &selection {
                Some(selected) => format!("{} {}", raw_text, selected),
                None => raw_text.clone(),
            };
            let total = ctx.screen_terms.len();
            ctx.screen_terms = screen_context::relevant_terms(&ctx.screen_terms, &heard);
            laps.note(format!("screen terms {}/{}", ctx.screen_terms.len(), total));
        }
        let ctx = &ctx;
        if let Some(selection) = selection {
            laps.kind = "edit";
            return self
                .run_edit(app, settings, app_dir, history, llm, ctx, &selection, &raw_text, &samples, laps)
                .await;
        }
        let cleaned = dictionary::apply_spelling(&cleanup_text(&raw_text), &dictionary::terms(&settings.custom_prompt));

        let (text, submit) = match strip_send_command(&cleaned) {
            Some(rest) if settings.send_command != "off" => (rest, true),
            _ => (cleaned, false),
        };
        laps.lap("text");
        let polished =
            polish(settings, app_dir, llm, ctx, &text, language.as_deref(), || show_polishing(app)).await;
        laps.lap("ai");
        let text = polished.text;

        let pasted = if text.is_empty() { Ok(()) } else { paste_timed(&text, laps) };
        if !text.is_empty() {
            // Recorded even when the paste failed, so the text is not lost.
            let model = model_label(settings);
            let raw = polished.raw.as_deref();
            if history.record(&text, raw, ctx, &samples, &model, &settings.history).is_some() {
                let _ = app.emit("history-updated", ());
            }
            laps.lap("history");
        }
        pasted?;
        if submit {
            press_submit(&settings.send_command)?;
            laps.lap("send");
        }

        Ok(text)
    }

    /// Edit mode: `spoken` says what to do with `selection`; the result
    /// replaces it (or deletes it). On failure the selection stays as it was.
    #[allow(clippy::too_many_arguments)]
    async fn run_edit(
        &self,
        app: &AppHandle,
        settings: &Settings,
        app_dir: &PathBuf,
        history: &History,
        llm: &Arc<LlmServer>,
        ctx: &AppContext,
        selection: &str,
        raw_text: &str,
        samples: &[f32],
        laps: &mut Laps,
    ) -> Result<String, String> {
        let spoken = cleanup_text(raw_text);
        if spoken.trim().is_empty() {
            emit_audio_empty(app, self.state.clone());
            return Ok(String::new());
        }
        let (result, _) =
            voice_edit::edit(settings, app_dir, llm, ctx, selection, &spoken, || show_polishing(app)).await;
        laps.lap("ai");
        match result.map_err(|e| format!("{}: {}", EDIT_FAILED, e))? {
            Edit::Delete => {
                press_delete()?;
                laps.lap("delete");
                Ok(String::new())
            }
            Edit::Replace(text) => {
                let pasted = paste_timed(&text, laps);
                let model = model_label(settings);
                if history
                    .record_edit(&text, selection, &spoken, ctx, samples, &model, &settings.history)
                    .is_some()
                {
                    let _ = app.emit("history-updated", ());
                }
                laps.lap("history");
                pasted?;
                Ok(text)
            }
        }
    }

    pub fn cancel_recording(&self, app: &AppHandle) -> Result<(), String> {
        {
            let mut state = lock(&self.state);
            if *state != RecordingState::Recording {
                return Err("Not currently recording".to_string());
            }
            *state = RecordingState::Ready;
        }
        mute::restore();
        lock(&self.audio_recorder).discard();
        let _ = app.emit("recording-state", RecordingState::Ready);
        update_overlay(app, &RecordingState::Ready);
        Ok(())
    }
}

/// Paste `text`: "paste" is the time until Ctrl+V went out, "restore" the
/// wait for the previous clipboard.
fn paste_timed(text: &str, laps: &mut Laps) -> Result<(), String> {
    let pasted = paste_text_timed(text);
    if let Ok(to_keystroke) = &pasted {
        laps.add("paste", *to_keystroke);
    }
    laps.lap("restore");
    pasted.map(|_| ())
}

/// Model name stored with a history entry.
pub fn model_label(settings: &Settings) -> String {
    if settings.engine == "cloud" {
        "groq".to_string()
    } else {
        settings.whisper_model.clone()
    }
}

/// Transcribe 16 kHz mono samples with the engine chosen in `settings`.
/// With `overlay`, the local engine streams partial text into the pill.
/// `screen_terms` go into Whisper's prompt ahead of the dictionary.
/// Also returns the spoken language when the engine reports it (local only).
pub async fn transcribe_samples(
    overlay: Option<&AppHandle>,
    settings: &Settings,
    app_dir: &PathBuf,
    engine: &Arc<WhisperEngine>,
    samples: &[f32],
    screen_terms: &[String],
) -> Result<(String, Option<String>), String> {
    let prompt = screen_context::whisper_prompt(screen_terms, &settings.custom_prompt);
    match settings.engine.as_str() {
        "local" => {
            let model_path =
                app_dir.join(crate::whisper_engine::model_filename(&settings.whisper_model));
            if !model_path.exists() {
                return Err("Whisper model not found. Please download a model first.".to_string());
            }
            engine.ensure_loaded(&model_path, &settings.gpu_backend)?;
            engine.transcribe(overlay, samples, &settings.language, &prompt)
        }
        "cloud" => {
            // Groq takes a WAV upload.
            let temp_path = app_dir.join("temp_recording.wav");
            samples_to_wav(samples, &temp_path)?;
            let text = transcribe_groq::transcribe_groq(
                &settings.groq_api_key,
                &temp_path,
                &settings.language,
                &prompt,
            )
            .await;
            let _ = std::fs::remove_file(&temp_path);
            text.map(|t| (t, None))
        }
        _ => Err(format!("Unknown engine: {}", settings.engine)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state_is_ready() {
        let recorder = Recorder::new();
        assert_eq!(recorder.get_state(), RecordingState::Ready);
    }
}
