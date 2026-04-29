use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::AudioRecorder;
use crate::cleanup::cleanup_text;
use crate::paste::paste_text;
use crate::settings::Settings;
use crate::startup_log;
use crate::transcribe_local;
use crate::transcribe_groq;

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

pub struct Recorder {
    state: Arc<Mutex<RecordingState>>,
    audio_recorder: Arc<Mutex<AudioRecorder>>,
}

impl Recorder {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(RecordingState::Ready)),
            audio_recorder: Arc::new(Mutex::new(AudioRecorder::new())),
        }
    }

    pub fn get_state(&self) -> RecordingState {
        self.state.lock().unwrap().clone()
    }

    pub fn start_recording(&self, app: &AppHandle, mic_name: &str) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if *state != RecordingState::Ready {
            return Err("Already recording or transcribing".to_string());
        }

        let mut recorder = self.audio_recorder.lock().unwrap();
        recorder.start(app, mic_name)?;

        *state = RecordingState::Recording;
        let _ = app.emit("recording-state", RecordingState::Recording);
        update_overlay(app, &RecordingState::Recording);
        Ok(())
    }

    pub async fn stop_and_transcribe(
        &self,
        app: &AppHandle,
        settings: &Settings,
        app_dir: &PathBuf,
    ) -> Result<String, String> {
        // Stop recording
        {
            let mut state = self.state.lock().unwrap();
            if *state != RecordingState::Recording {
                return Err("Not currently recording".to_string());
            }
            *state = RecordingState::Transcribing;
            let _ = app.emit("recording-state", RecordingState::Transcribing);
            update_overlay(app, &RecordingState::Transcribing);
        }

        let result = self
            .run_transcription_pipeline(app, settings, app_dir)
            .await;

        // Always reset state to Ready, regardless of success/failure.
        {
            let mut state = self.state.lock().unwrap();
            *state = RecordingState::Ready;
            let _ = app.emit("recording-state", RecordingState::Ready);
            update_overlay(app, &RecordingState::Ready);
        }

        result
    }

    async fn run_transcription_pipeline(
        &self,
        app: &AppHandle,
        settings: &Settings,
        app_dir: &PathBuf,
    ) -> Result<String, String> {
        let temp_path = app_dir.join("temp_recording.wav");

        {
            let mut recorder = self.audio_recorder.lock().unwrap();
            recorder.stop_and_save(&temp_path)?;
        }

        let raw_text = match settings.engine.as_str() {
            "local" => {
                let model_path = app_dir.join(transcribe_local::model_filename(&settings.whisper_model));
                transcribe_local::transcribe_local(app, &model_path, &temp_path, &settings.gpu_backend, &settings.language).await?
            }
            "cloud" => {
                transcribe_groq::transcribe_groq(&settings.groq_api_key, &temp_path).await?
            }
            _ => return Err(format!("Unknown engine: {}", settings.engine)),
        };

        let _ = std::fs::remove_file(&temp_path);

        let cleaned = cleanup_text(&raw_text);

        if !cleaned.is_empty() {
            paste_text(&cleaned)?;
        }

        Ok(cleaned)
    }

    pub fn cancel_recording(&self, app: &AppHandle) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if *state != RecordingState::Recording {
            return Err("Not currently recording".to_string());
        }
        let mut recorder = self.audio_recorder.lock().unwrap();
        recorder.discard();
        *state = RecordingState::Ready;
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
