//! AI cleanup with all 40 screen terms (before) against only the terms the
//! dictation mentions (after). Runs its own llama-server.
//!
//!   cargo run --release --example terms_bench -- <llama dir> <data dir> [gpuBackend]

use std::path::PathBuf;
use std::sync::Arc;

use rudariflow_lib::ai_cleanup::AppContext;
use rudariflow_lib::ai_models;
use rudariflow_lib::llm_server::LlmServer;
use rudariflow_lib::polish::{polish, system_prompt};
use rudariflow_lib::screen_context::relevant_terms;
use rudariflow_lib::settings::Settings;

/// 40 terms like a busy VS Code window gives.
const SCREEN: &[&str] = &[
    "RudariFlow", "whisper.cpp", "llama-server", "Gemma", "Vulkan", "CUDA", "Tauri", "WebView2", "GitHub",
    "Paperless-ngx", "Grüssen-Shop", "Salon-Agenda", "Yılmaz", "Pratteln", "TWINT", "SumUp", "Vercel", "Neon",
    "Payload", "Manrope", "Kübra", "Şükrü", "Nextcloud", "Tailscale", "Proxmox", "NocoDB", "Plausible",
    "Cloudflare", "AliasVault", "Duplicati", "OBS", "Brave", "Outlook", "WhatsApp", "PowerShell", "RX6800",
    "Ryzen", "screen_context", "llm_server", "polish.rs",
];

const DICTATIONS: &[&str] = &[
    "Can you check why the llama server starts before whisper on the RX 6800?",
    "Hi Umit Yilmaz, thanks for the offer, we'd like to go with the premium package and talk details on Wednesday.",
    "Um so the meeting moved to Friday, please bring the slides and the budget numbers.",
    "Please upload the invoice to paperless NGX and send the link to the Grüssen shop team.",
    "I think we should, uh, refactor the settings page before the release next week.",
];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: terms_bench <llama dir> <data dir> [gpuBackend]");
        std::process::exit(2);
    }
    let data_dir = PathBuf::from(&args[2]);
    let mut settings = Settings::load(&data_dir);
    settings.ai_cleanup = true;
    if let Some(backend) = args.get(3) {
        settings.gpu_backend = backend.clone();
    }
    let model = ai_models::model_path(&data_dir, ai_models::find(&settings.ai_model).expect("AI model"));
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let log_dir = std::env::temp_dir().join("rudariflow_terms_bench");
    let _ = std::fs::create_dir_all(&log_dir);
    let llm = Arc::new(LlmServer::new(PathBuf::from(&args[1]), log_dir.join("llm-server.log"), Box::new(|_| {})));
    llm.set_warm_prompt(system_prompt(&settings));
    runtime.block_on(llm.ensure_running(&model, Some(&settings.gpu_backend))).expect("start");

    let screen: Vec<String> = SCREEN.iter().map(|s| s.to_string()).collect();
    let (mut all_ms, mut kept_ms) = (Vec::new(), Vec::new());
    for round in 0..2 {
        for text in DICTATIONS {
            let kept = relevant_terms(&screen, text);
            for (terms, times) in [(screen.clone(), &mut all_ms), (kept.clone(), &mut kept_ms)] {
                let ctx = AppContext { exe: "code".into(), title: "main.rs - RudariFlow".into(), screen_terms: terms };
                let p = runtime.block_on(polish(&settings, &data_dir, &llm, &ctx, text, Some("English"), || {}));
                times.push(p.ai_ms);
            }
            if round == 0 {
                println!("{} of 40 terms kept: {:?}", kept.len(), kept);
            }
        }
    }
    llm.stop();
    let median = |mut v: Vec<u64>| {
        v.sort();
        v[v.len() / 2]
    };
    println!("AI with all 40 terms: median {} ms", median(all_ms));
    println!("AI with kept terms:   median {} ms", median(kept_ms));
}
