use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::ai_cleanup::AppRule;
use crate::replacements::Replacement;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    pub microphone: String,
    pub engine: String,
    #[serde(rename = "whisperModel")]
    pub whisper_model: String,
    #[serde(rename = "groqApiKey")]
    pub groq_api_key: String,
    #[serde(rename = "recordingMode")]
    pub recording_mode: String,
    pub hotkey: String,
    #[serde(rename = "gpuBackend", default = "default_gpu_backend")]
    pub gpu_backend: String,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(rename = "uiLanguage", default)]
    pub ui_language: String,
    #[serde(default = "default_volume")]
    pub volume: f32,
    #[serde(default)]
    pub autostart: bool,
    #[serde(rename = "customPrompt", default)]
    pub custom_prompt: String,
    /// Spoken phrases expanded into longer text after transcription.
    #[serde(default)]
    pub replacements: Vec<Replacement>,
    /// Key pressed after a dictation that ends with "send it":
    /// "off", "enter" or "ctrl+enter".
    #[serde(rename = "sendCommand", default = "default_send_command")]
    pub send_command: String,
    /// "off", "text" (transcripts only) or "audio" (transcripts and recordings).
    #[serde(default = "default_history")]
    pub history: String,
    /// Keyboard chord that pastes the last transcript again; empty = none.
    #[serde(rename = "pasteLastHotkey", default = "default_paste_last_hotkey")]
    pub paste_last_hotkey: String,
    /// Mute other apps while recording.
    #[serde(rename = "muteAudio", default)]
    pub mute_audio: bool,
    /// Polish dictations with the local language model.
    #[serde(rename = "aiCleanup", default)]
    pub ai_cleanup: bool,
    /// Id from `ai_models::MODELS`.
    #[serde(rename = "aiModel", default = "default_ai_model")]
    pub ai_model: String,
    /// "polished" or "light".
    #[serde(rename = "aiStyle", default = "default_ai_style")]
    pub ai_style: String,
    /// Instructions for all apps.
    #[serde(rename = "aiInstructions", default)]
    pub ai_instructions: String,
    #[serde(rename = "aiRules", default)]
    pub ai_rules: Vec<AppRule>,
    /// Swiss spelling: ss instead of ß in every dictation.
    #[serde(rename = "swissSpelling", default)]
    pub swiss_spelling: bool,
    /// "Write in": Whisper language code the AI writes everything in
    /// (translating if needed); empty = the language that was spoken.
    #[serde(rename = "aiOutputLanguage", default)]
    pub ai_output_language: String,
    /// Edit mode: with text selected, the hotkey edits it by voice (needs
    /// AI cleanup).
    #[serde(rename = "editMode", default = "default_true")]
    pub edit_mode: bool,
    /// Screen context: names and terms visible in the window help Whisper
    /// and the AI spell them.
    #[serde(rename = "screenContext", default = "default_true")]
    pub screen_context: bool,
}

fn default_true() -> bool {
    true
}

fn default_volume() -> f32 {
    0.4
}

fn default_gpu_backend() -> String {
    "auto".to_string()
}

fn default_language() -> String {
    "auto".to_string()
}

fn default_send_command() -> String {
    "off".to_string()
}

fn default_history() -> String {
    "audio".to_string()
}

fn default_paste_last_hotkey() -> String {
    "Alt+Shift+V".to_string()
}

fn default_ai_model() -> String {
    crate::ai_models::DEFAULT_MODEL.to_string()
}

fn default_ai_style() -> String {
    "polished".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            microphone: "default".to_string(),
            engine: "local".to_string(),
            whisper_model: "small".to_string(),
            groq_api_key: String::new(),
            recording_mode: "toggle".to_string(),
            hotkey: "CmdOrCtrl+Shift+Space".to_string(),
            gpu_backend: "auto".to_string(),
            language: "auto".to_string(),
            ui_language: String::new(),
            volume: 0.4,
            autostart: false,
            custom_prompt: String::new(),
            replacements: Vec::new(),
            send_command: default_send_command(),
            history: default_history(),
            paste_last_hotkey: default_paste_last_hotkey(),
            mute_audio: false,
            ai_cleanup: false,
            ai_model: default_ai_model(),
            ai_style: default_ai_style(),
            ai_instructions: String::new(),
            ai_rules: Vec::new(),
            swiss_spelling: false,
            ai_output_language: String::new(),
            edit_mode: true,
            screen_context: true,
        }
    }
}

impl Settings {
    pub fn config_path(app_dir: &PathBuf) -> PathBuf {
        app_dir.join("config.json")
    }

    pub fn load(app_dir: &PathBuf) -> Self {
        let path = Self::config_path(app_dir);
        let Ok(contents) = fs::read_to_string(&path) else {
            return Self::default();
        };
        let mut settings: Self = match serde_json::from_str(&contents) {
            Ok(s) => s,
            Err(_) => return Self::default(),
        };
        // Migration: pre-0.2.0 used `useGpu: bool`. Map it onto gpuBackend.
        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&contents) {
            if !raw.get("gpuBackend").is_some() {
                if let Some(use_gpu) = raw.get("useGpu").and_then(|v| v.as_bool()) {
                    settings.gpu_backend = if use_gpu { "auto".to_string() } else { "cpu".to_string() };
                }
            }
        }
        // Accepted values are auto / cuda / vulkan / cpu. Anything else (e.g. a
        // "gpu" value from a pre-release build) behaves like and becomes auto.
        if !matches!(settings.gpu_backend.as_str(), "auto" | "cuda" | "vulkan" | "cpu") {
            settings.gpu_backend = "auto".to_string();
        }
        // An empty microphone (saved by the settings UI before it listed
        // "default") means the system default input.
        if settings.microphone.trim().is_empty() {
            settings.microphone = "default".to_string();
        }
        if !matches!(settings.send_command.as_str(), "off" | "enter" | "ctrl+enter") {
            settings.send_command = default_send_command();
        }
        if !matches!(settings.history.as_str(), "off" | "text" | "audio") {
            settings.history = default_history();
        }
        if crate::ai_models::find(&settings.ai_model).is_none() {
            settings.ai_model = default_ai_model();
        }
        if !matches!(settings.ai_style.as_str(), "polished" | "light") {
            settings.ai_style = default_ai_style();
        }
        if crate::whisper_engine::language_name(&settings.ai_output_language).is_none() {
            settings.ai_output_language = String::new();
        }
        settings
    }

    pub fn save(&self, app_dir: &PathBuf) -> Result<(), String> {
        let path = Self::config_path(app_dir);
        fs::create_dir_all(app_dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    #[test]
    fn test_default_settings() {
        let settings = Settings::default();
        assert_eq!(settings.microphone, "default");
        assert_eq!(settings.engine, "local");
        assert_eq!(settings.whisper_model, "small");
        assert_eq!(settings.groq_api_key, "");
        assert_eq!(settings.recording_mode, "toggle");
        assert_eq!(settings.hotkey, "CmdOrCtrl+Shift+Space");
    }

    #[test]
    fn test_save_and_load() {
        let dir = temp_dir().join("typr_test_settings");
        let _ = fs::remove_dir_all(&dir);

        let mut settings = Settings::default();
        settings.engine = "cloud".to_string();
        settings.groq_api_key = "test-key-123".to_string();

        settings.save(&dir).unwrap();
        let loaded = Settings::load(&dir);

        assert_eq!(loaded.engine, "cloud");
        assert_eq!(loaded.groq_api_key, "test-key-123");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_load_missing_file_returns_default() {
        let dir = temp_dir().join("typr_test_missing");
        let _ = fs::remove_dir_all(&dir);
        let settings = Settings::load(&dir);
        assert_eq!(settings, Settings::default());
    }

    #[test]
    fn test_load_corrupt_json_returns_default() {
        let dir = temp_dir().join("typr_test_corrupt");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("config.json"), "not json").unwrap();

        let settings = Settings::load(&dir);
        assert_eq!(settings, Settings::default());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_unknown_gpu_backend_becomes_auto() {
        let dir = temp_dir().join("typr_test_gpu_backend");
        let _ = fs::remove_dir_all(&dir);

        for (saved, expected) in [("gpu", "auto"), ("cuda", "cuda"), ("vulkan", "vulkan"), ("cpu", "cpu")] {
            let mut settings = Settings::default();
            settings.gpu_backend = saved.to_string();
            settings.save(&dir).unwrap();
            assert_eq!(Settings::load(&dir).gpu_backend, expected);
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_custom_prompt_default_empty() {
        let s = Settings::default();
        assert_eq!(s.custom_prompt, "");
    }

    #[test]
    fn test_custom_prompt_roundtrip() {
        let dir = temp_dir().join("typr_test_prompt");
        let _ = fs::remove_dir_all(&dir);

        let mut settings = Settings::default();
        settings.custom_prompt = "Tauri whisper.cpp ggml".to_string();
        settings.save(&dir).unwrap();
        let loaded = Settings::load(&dir);
        assert_eq!(loaded.custom_prompt, "Tauri whisper.cpp ggml");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_custom_prompt_missing_field_loads_as_empty() {
        let dir = temp_dir().join("typr_test_prompt_missing");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let pre_v3 = r#"{
            "microphone": "default",
            "engine": "local",
            "whisperModel": "small",
            "groqApiKey": "",
            "recordingMode": "toggle",
            "hotkey": "CmdOrCtrl+Shift+Space",
            "gpuBackend": "auto",
            "language": "auto",
            "uiLanguage": "",
            "volume": 0.4,
            "autostart": false
        }"#;
        fs::write(dir.join("config.json"), pre_v3).unwrap();

        let loaded = Settings::load(&dir);
        assert_eq!(loaded.custom_prompt, "");
        assert!(loaded.replacements.is_empty());
        assert_eq!(loaded.send_command, "off");
        assert_eq!(loaded.history, "audio");
        assert_eq!(loaded.paste_last_hotkey, "Alt+Shift+V");
        assert!(!loaded.mute_audio);
        assert!(!loaded.ai_cleanup);
        assert_eq!(loaded.ai_model, crate::ai_models::DEFAULT_MODEL);
        assert_eq!(loaded.ai_style, "polished");
        assert!(loaded.ai_rules.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_new_fields_roundtrip() {
        let dir = temp_dir().join("typr_test_v06_fields");
        let _ = fs::remove_dir_all(&dir);

        let mut settings = Settings::default();
        settings.replacements = vec![Replacement { from: "my email".into(), to: "a@b.ch".into() }];
        settings.send_command = "ctrl+enter".to_string();
        settings.history = "off".to_string();
        settings.paste_last_hotkey = String::new();
        settings.mute_audio = true;
        settings.save(&dir).unwrap();
        assert_eq!(Settings::load(&dir), settings);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_ai_fields_roundtrip_and_fallbacks() {
        let dir = temp_dir().join("typr_test_ai_fields");
        let _ = fs::remove_dir_all(&dir);

        let mut settings = Settings::default();
        settings.ai_cleanup = true;
        settings.ai_model = "gemma-4-12b".to_string();
        settings.ai_style = "light".to_string();
        settings.ai_instructions = "Use ss instead of ß.".to_string();
        settings.ai_rules = vec![AppRule { app: "whatsapp".into(), instructions: "lowercase".into(), ..Default::default() }];
        settings.save(&dir).unwrap();
        assert_eq!(Settings::load(&dir), settings);

        settings.ai_model = "gpt-9".to_string();
        settings.ai_style = "shouty".to_string();
        settings.save(&dir).unwrap();
        let loaded = Settings::load(&dir);
        assert_eq!(loaded.ai_model, crate::ai_models::DEFAULT_MODEL);
        assert_eq!(loaded.ai_style, "polished");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_output_language_roundtrip_and_fallback() {
        let dir = temp_dir().join("typr_test_output_language");
        let _ = fs::remove_dir_all(&dir);
        let mut settings = Settings::default();
        assert_eq!(settings.ai_output_language, "");
        settings.ai_output_language = "en".to_string();
        settings.save(&dir).unwrap();
        assert_eq!(Settings::load(&dir).ai_output_language, "en");
        settings.ai_output_language = "klingon".to_string();
        settings.save(&dir).unwrap();
        assert_eq!(Settings::load(&dir).ai_output_language, "");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_empty_microphone_loads_as_default() {
        let dir = temp_dir().join("typr_test_empty_mic");
        let _ = fs::remove_dir_all(&dir);

        let mut settings = Settings::default();
        settings.microphone = String::new();
        settings.save(&dir).unwrap();
        assert_eq!(Settings::load(&dir).microphone, "default");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_unknown_send_command_and_history_fall_back() {
        let dir = temp_dir().join("typr_test_v06_invalid");
        let _ = fs::remove_dir_all(&dir);

        let mut settings = Settings::default();
        settings.send_command = "shift+enter".to_string();
        settings.history = "forever".to_string();
        settings.save(&dir).unwrap();
        let loaded = Settings::load(&dir);
        assert_eq!(loaded.send_command, "off");
        assert_eq!(loaded.history, "audio");

        let _ = fs::remove_dir_all(&dir);
    }
}
