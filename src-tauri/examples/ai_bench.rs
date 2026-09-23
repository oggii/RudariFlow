//! Benchmark AI cleanup models on this PC with the product's prompt, server
//! manager and output guard.
//!
//! cargo run --release --example ai_bench -- <llama dir> <report.md> <model.gguf>...

use std::path::PathBuf;
use std::time::{Duration, Instant};

use rudariflow_lib::ai_cleanup::{build_messages, complete, guard, sampling, AppContext, AppRule};
use rudariflow_lib::llm_server::LlmServer;

struct Sample {
    name: &'static str,
    exe: &'static str,
    title: &'static str,
    rule: &'static str,
    text: &'static str,
    placeholders: usize,
}

const SAMPLES: &[Sample] = &[
    Sample {
        name: "EN fillers + self-correction",
        exe: "",
        title: "",
        rule: "",
        text: "Um so I think we should, uh, meet on Tuesday, no wait, Wednesday at 3 and, uh, bring the the slides.",
        placeholders: 0,
    },
    Sample {
        name: "EN list",
        exe: "",
        title: "",
        rule: "",
        text: "For the trip we need to buy sunscreen, a new phone charger, two beach towels and, uh, snacks for the kids.",
        placeholders: 0,
    },
    Sample {
        name: "EN question to the AI (must not answer)",
        exe: "chrome",
        title: "ChatGPT - Google Chrome",
        rule: "",
        text: "Hey, can you tell me what the capital of Australia is? I need it for the quiz tomorrow.",
        placeholders: 0,
    },
    Sample {
        name: "EN placeholder",
        exe: "outlook",
        title: "Untitled - Message (HTML)",
        rule: "",
        text: "Please send the invoice to ⟦1⟧ by Friday and, um, copy in the finance team.",
        placeholders: 1,
    },
    Sample {
        name: "EN WhatsApp rule",
        exe: "whatsapp.root",
        title: "WhatsApp",
        rule: "casual, all lowercase, no period at the end",
        text: "Yeah sure, I'll be there in like ten minutes, just parking the car.",
        placeholders: 0,
    },
    Sample {
        name: "DE fillers + self-correction",
        exe: "",
        title: "",
        rule: "",
        text: "Ähm, also ich wollte fragen, ob wir das Meeting, äh, auf Donnerstag verschieben können, nein, auf Freitag.",
        placeholders: 0,
    },
    Sample {
        name: "DE list",
        exe: "",
        title: "",
        rule: "",
        text: "Für das Wochenende brauchen wir noch Milch, Eier, äh, Brot und zwei Flaschen Rotwein.",
        placeholders: 0,
    },
    Sample {
        name: "DE Outlook rule",
        exe: "outlook",
        title: "Posteingang - Outlook",
        rule: "formal, complete sentences, German: Sie-Form",
        text: "Hallo Herr Meier, danke für Ihre Nachricht, ich schau mir das morgen an und melde mich dann bei Ihnen.",
        placeholders: 0,
    },
    Sample {
        name: "EN Outlook rule mentioning German",
        exe: "outlook",
        title: "Posteingang - Outlook",
        rule: "formal, complete sentences, German: Sie-Form",
        text: "Hey, I would like to test this mail inside Outlook. How are we transcribing this?",
        placeholders: 0,
    },
    Sample {
        name: "EN short, Outlook rule mentioning German",
        exe: "outlook",
        title: "Posteingang - Outlook",
        rule: "formal, complete sentences, German: Sie-Form",
        text: "Done.",
        placeholders: 0,
    },
    Sample {
        name: "DE request to the AI (must not do it)",
        exe: "",
        title: "",
        rule: "",
        text: "Schreib mir bitte eine kurze Zusammenfassung von dem Artikel über die Klimakonferenz.",
        placeholders: 0,
    },
    Sample {
        name: "DE long ramble",
        exe: "",
        title: "",
        rule: "",
        text: "Also das Projekt läuft eigentlich ganz gut, wir haben, ähm, die ersten drei Module fertig und das Testing startet nächste Woche. Ähm, das einzige Problem ist halt das Budget, das ist ein bisschen knapp, aber ich denke, wenn wir die Lizenzen erst im Oktober kaufen, dann kriegen wir das hin.",
        placeholders: 0,
    },
];

const RUNS: usize = 3;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: ai_bench <llama dir> <report.md> <model.gguf>...");
        std::process::exit(2);
    }
    let llama_dir = PathBuf::from(&args[1]);
    let report_path = PathBuf::from(&args[2]);
    let models: Vec<PathBuf> = args[3..].iter().map(PathBuf::from).collect();

    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let mut report = String::from("# AI cleanup benchmark\n\n");
    let mut summary = String::from("| Model | Load | Median | Worst | Guard failures |\n|---|---|---|---|---|\n");

    for model in &models {
        let name = model.file_name().unwrap().to_string_lossy().to_string();
        println!("== {}", name);
        let server = LlmServer::new(
            llama_dir.clone(),
            std::env::temp_dir().join("rudariflow-ai-bench-server.log"),
            Box::new(|status| println!("   status: {:?}", status)),
        );
        let started = Instant::now();
        let endpoint = match runtime.block_on(server.ensure_running(model, None)) {
            Ok(e) => e,
            Err(e) => {
                println!("   start failed: {}", e);
                summary.push_str(&format!("| {} | failed: {} | | | |\n", name, e));
                continue;
            }
        };
        let load_ms = started.elapsed().as_millis();

        // Warm-up: fills the prompt cache like the first dictation after start.
        let (system, user) = build_messages("polished", "", &[], &[], &AppContext::default(), None, None, "Hello there.");
        let _ = runtime.block_on(complete(&endpoint, &system, &user, 0.2, 64, Duration::from_secs(60)));

        report.push_str(&format!("## {}\n\nLoaded in {} ms.\n\n", name, load_ms));
        let mut medians = Vec::new();
        let mut worst = 0u128;
        let mut guard_failures = 0;
        for sample in SAMPLES {
            let ctx = AppContext { exe: sample.exe.into(), title: sample.title.into(), ..Default::default() };
            let rule = AppRule { app: sample.exe.into(), instructions: sample.rule.into(), off: false };
            let rules: Vec<&AppRule> = if sample.rule.is_empty() { vec![] } else { vec![&rule] };
            // Whisper reports the spoken language with every dictation.
            let language = if sample.name.starts_with("DE") { "German" } else { "English" };
            let (system, user) = build_messages("polished", "", &[], &rules, &ctx, Some(language), None, sample.text);
            let (temperature, max_tokens) = sampling("polished", sample.text);

            let mut times = Vec::new();
            let mut last = String::new();
            for _ in 0..RUNS {
                let t = Instant::now();
                let answer = runtime.block_on(complete(
                    &endpoint,
                    &system,
                    &user,
                    temperature,
                    max_tokens,
                    Duration::from_secs(60),
                ));
                times.push(t.elapsed().as_millis());
                last = answer.unwrap_or_else(|e| format!("ERROR: {}", e));
            }
            times.sort();
            let median = times[times.len() / 2];
            worst = worst.max(*times.last().unwrap());
            medians.push(median);
            let verdict = match guard(sample.text, &last, sample.placeholders, None) {
                Ok(_) => "ok".to_string(),
                Err(reason) => {
                    guard_failures += 1;
                    format!("GUARD: {}", reason)
                }
            };
            println!("   {:<42} {:>5} ms  {}", sample.name, median, verdict);
            report.push_str(&format!(
                "**{}** ({} ms, {})\n\n> {}\n\n```\n{}\n```\n\n",
                sample.name,
                median,
                verdict,
                sample.text,
                last.trim()
            ));
        }
        medians.sort();
        let median = medians[medians.len() / 2];
        summary.push_str(&format!(
            "| {} | {} ms | {} ms | {} ms | {} |\n",
            name, load_ms, median, worst, guard_failures
        ));
        server.stop();
    }

    let full = format!("{}\n{}", summary, report);
    std::fs::write(&report_path, &full).expect("write report");
    println!("\n{}", summary);
    println!("report: {}", report_path.display());
}
