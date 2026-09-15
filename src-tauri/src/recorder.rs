use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::{lock, AudioRecorder};
use crate::cleanup::cleanup_text;
use crate::paste::paste_text;
use crate::settings::Settings;
use crate::startup_log;
use crate::transcribe_groq;
use crate::whisper_engine::WhisperEngine;

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
}

/// Resets the recorder to Ready when dropped, including when transcription
/// panics, so a crash can never leave the app stuck in Transcribing.
struct ReadyOnDrop<'a> {
    app: &'a AppHandle,
    state: &'a Arc<Mutex<RecordingState>>,
}

impl Drop for ReadyOnDrop<'_> {
    fn drop(&mut self) {
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
        }
    }

    pub fn get_state(&self) -> RecordingState {
        lock(&self.state).clone()
    }

    pub fn start_recording(&self, app: &AppHandle, mic_name: &str) -> Result<(), String> {
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
    ) -> Result<String, String> {
        // Stop recording
        {
            let mut state = lock(&self.state);
            if *state != RecordingState::Recording {
                return Err("Not currently recording".to_string());
            }
            *state = RecordingState::Transcribing;
        }
        let _ = app.emit("recording-state", RecordingState::Transcribing);
        update_overlay(app, &RecordingState::Transcribing);

        // Always reset state to Ready, regardless of success, failure or panic.
        let _ready = ReadyOnDrop { app, state: &self.state };

        let result = self
            .run_transcription_pipeline(app, settings, app_dir, engine)
            .await;
        if let Err(e) = &result {
            startup_log::log(&format!("[recorder] transcription failed: {}", e));
        }
        result
    }

    async fn run_transcription_pipeline(
        &self,
        app: &AppHandle,
        settings: &Settings,
        app_dir: &PathBuf,
        engine: &Arc<WhisperEngine>,
    ) -> Result<String, String> {
        let raw_text = match settings.engine.as_str() {
            "local" => {
                // Local path: take samples, hand directly to in-process whisper.
                let samples_result = lock(&self.audio_recorder).stop_and_take_samples();
                if let Err(e) = &samples_result {
                    if e == "no_speech" {
                        emit_audio_empty(app, self.state.clone());
                        return Ok(String::new());
                    }
                }
                let samples = samples_result?;

                let model_path = app_dir
                    .join(crate::whisper_engine::model_filename(&settings.whisper_model));
                if !model_path.exists() {
                    return Err("Whisper model not found. Please download a model first.".to_string());
                }
                engine.ensure_loaded(&model_path, &settings.gpu_backend)?;
                engine.transcribe(app, &samples, &settings.language, &settings.custom_prompt)?
            }
            "cloud" => {
                // Cloud path: still uses a WAV file because Groq accepts uploads.
                let temp_path = app_dir.join("temp_recording.wav");
                let save_result = lock(&self.audio_recorder).stop_and_save(&temp_path);
                if let Err(e) = &save_result {
                    if e == "no_speech" {
                        emit_audio_empty(app, self.state.clone());
                        return Ok(String::new());
                    }
                }
                save_result?;
                let text = transcribe_groq::transcribe_groq(
                    &settings.groq_api_key,
                    &temp_path,
                    &settings.language,
                    &settings.custom_prompt,
                )
                .await?;
                let _ = std::fs::remove_file(&temp_path);
                text
            }
            _ => return Err(format!("Unknown engine: {}", settings.engine)),
        };

        let cleaned = cleanup_text(&raw_text);

        if !cleaned.is_empty() {
            paste_text(&cleaned)?;
        }

        Ok(cleaned)
    }

    pub fn cancel_recording(&self, app: &AppHandle) -> Result<(), String> {
        {
            let mut state = lock(&self.state);
            if *state != RecordingState::Recording {
                return Err("Not currently recording".to_string());
            }
            *state = RecordingState::Ready;
        }
        lock(&self.audio_recorder).discard();
        let _ = app.emit("recording-state", RecordingState::Ready);
        update_overlay(app, &RecordingState::Ready);
        Ok(())
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
