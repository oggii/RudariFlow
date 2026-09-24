pub mod settings;
pub mod audio;
pub mod whisper_engine;
pub mod transcribe_groq;
pub mod cleanup;
pub mod paste;
pub mod recorder;
pub mod downloader;
pub mod mouse_hotkey;
pub mod startup_log;
pub mod replacements;
pub mod send_command;
pub mod history;
pub mod mute;
pub mod ai_cleanup;
pub mod ai_models;
pub mod llm_server;
pub mod foreground_app;
pub mod polish;
pub mod dictionary;
pub mod selection;
pub mod screen_context;
pub mod uia;
pub mod voice_edit;
pub mod power;
pub mod pc_check;
pub mod learn;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
