//! Dictations and Edit mode requests in turn: does a dictation after an edit
//! pay for its system prompt again? Runs its own llama-server; extra server
//! arguments (e.g. "-np 2") come from RUDARIFLOW_LLAMA_ARGS.
//!
//!   cargo run --release --example edit_bench -- <llama dir> <data dir> [gpuBackend]

use std::path::PathBuf;
use std::sync::Arc;

use rudariflow_lib::ai_cleanup::AppContext;
use rudariflow_lib::ai_models;
use rudariflow_lib::llm_server::LlmServer;
use rudariflow_lib::polish::{polish, system_prompt};
use rudariflow_lib::settings::Settings;
use rudariflow_lib::voice_edit;

const DICTATIONS: &[&str] = &[
    "Um so the meeting moved to Friday, please bring the slides and the budget numbers.",
    "I think we should, uh, refactor the settings page before the release next week.",
    "Can you send me the invoice by the end of the week so I can pay it this month?",
    "The new laptop arrives tomorrow, I'll set it up in the afternoon.",
];

const SELECTION: &str = "Hi Anna, thanks for the offer. We would like to go with the premium package and talk about the details on Wednesday evening.";
const EDITS: &[&str] = &["make it more formal", "make it shorter", "translate this into German"];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: edit_bench <llama dir> <data dir> [gpuBackend]");
        std::process::exit(2);
    }
    let data_dir = PathBuf::from(&args[2]);
    let mut settings = Settings::load(&data_dir);
    settings.ai_cleanup = true;
    settings.edit_mode = true;
    if let Some(backend) = args.get(3) {
        settings.gpu_backend = backend.clone();
    }
    let model = ai_models::model_path(&data_dir, ai_models::find(&settings.ai_model).expect("AI model"));
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let log_dir = std::env::temp_dir().join("rudariflow_edit_bench");
    let _ = std::fs::create_dir_all(&log_dir);
    let llm = Arc::new(LlmServer::new(PathBuf::from(&args[1]), log_dir.join("llm-server.log"), Box::new(|_| {})));
    llm.set_warm_prompt(system_prompt(&settings));
    runtime.block_on(llm.ensure_running(&model, Some(&settings.gpu_backend))).expect("start");
    println!("extra llama-server args: {:?}", std::env::var("RUDARIFLOW_LLAMA_ARGS").unwrap_or_default());

    let ctx = AppContext { exe: "code".into(), title: "main.rs - RudariFlow".into(), ..Default::default() };
    let dictate = |i: usize| {
        let p = runtime.block_on(polish(&settings, &data_dir, &llm, &ctx, DICTATIONS[i], Some("English"), || {}));
        println!("  dictation {}: {} ms", i + 1, p.ai_ms);
        p.ai_ms
    };
    let edit = |i: usize| {
        let (result, ms) =
            runtime.block_on(voice_edit::edit(&settings, &data_dir, &llm, &ctx, SELECTION, EDITS[i], || {}));
        println!("  edit {} ({}): {} ms{}", i + 1, EDITS[i], ms, if result.is_err() { " (failed)" } else { "" });
        ms
    };

    let base = dictate(0);
    let mut after_edit = Vec::new();
    for i in 0..EDITS.len() {
        edit(i);
        after_edit.push(dictate(i + 1));
    }
    llm.stop();
    println!("dictation without an edit before it: {} ms; right after an edit: {:?} ms", base, after_edit);
    println!("llama-server log: {}", log_dir.join("llm-server.log").display());
}
