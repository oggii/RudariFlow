//! First dictations after an AI server start: warm-up with the default
//! prompt (before) against warm-up with the settings' dictation prompt.
//! Runs its own llama-server, so an app that is running stays untouched.
//!
//!   cargo run --release --example warm_bench -- <llama dir> <data dir> [gpuBackend]
//!
//! <data dir> holds config.json and llm\<model>.gguf (e.g. C:\t\rf-test-data).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use rudariflow_lib::ai_cleanup::AppContext;
use rudariflow_lib::llm_server::LlmServer;
use rudariflow_lib::polish::{polish, system_prompt};
use rudariflow_lib::settings::Settings;
use rudariflow_lib::ai_models;

const DICTATIONS: &[(&str, &str, &str)] = &[
    ("code", "main.rs - RudariFlow - Visual Studio Code", "Um so the warm up should use the same system prompt as the real dictation, otherwise the first one is slow."),
    ("brave", "Inbox - Gmail - Brave", "Hi Anna, thanks for the offer, uh, we'd like to go with the premium package and talk details on Wednesday."),
    ("code", "llm_server.rs - RudariFlow - Visual Studio Code", "Can you check whether the idle touch runs before the dictation or after it?"),
];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: warm_bench <llama dir> <data dir> [gpuBackend]");
        std::process::exit(2);
    }
    let llama_dir = PathBuf::from(&args[1]);
    let data_dir = PathBuf::from(&args[2]);
    let mut settings = Settings::load(&data_dir);
    settings.ai_cleanup = true;
    if let Some(backend) = args.get(3) {
        settings.gpu_backend = backend.clone();
    }
    let model = ai_models::model_path(&data_dir, ai_models::find(&settings.ai_model).expect("AI model"));
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let log_dir = std::env::temp_dir().join("rudariflow_warm_bench");
    let _ = std::fs::create_dir_all(&log_dir);

    for (label, real_prompt) in [("default warm-up (before)", false), ("settings warm-up (after)", true)] {
        let llm = Arc::new(LlmServer::new(llama_dir.clone(), log_dir.join("llm-server.log"), Box::new(|_| {})));
        if real_prompt {
            llm.set_warm_prompt(system_prompt(&settings));
        }
        let started = Instant::now();
        if let Err(e) = runtime.block_on(llm.ensure_running(&model, Some(&settings.gpu_backend))) {
            eprintln!("start failed: {}", e);
            std::process::exit(1);
        }
        println!("{}: ready after {} ms", label, started.elapsed().as_millis());
        for (i, (exe, title, text)) in DICTATIONS.iter().enumerate() {
            let ctx = AppContext { exe: exe.to_string(), title: title.to_string(), ..Default::default() };
            let polished = runtime.block_on(polish(&settings, &data_dir, &llm, &ctx, text, Some("English"), || {}));
            println!(
                "  dictation {}: AI {} ms{}",
                i + 1,
                polished.ai_ms,
                polished.fallback.map(|f| format!(" (fallback: {})", f)).unwrap_or_default()
            );
        }
        llm.stop();
    }
}
