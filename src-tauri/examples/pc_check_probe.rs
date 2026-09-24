//! The Whisper part of the PC check without the app: every variant on a
//! recording, the choice and the settings it would write.
//!
//!   cargo run --release --example pc_check_probe -- <model.bin> <clip.wav> [language]

use std::path::Path;

use rudariflow_lib::history::read_wav;
use rudariflow_lib::pc_check::{choose, default_variant, measure, settings_for, system_summary, variants};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: pc_check_probe <model.bin> <clip.wav> [language]");
        std::process::exit(2);
    }
    let clip = read_wav(Path::new(&args[2])).expect("read wav");
    let language = args.get(3).map(String::as_str).unwrap_or("en");
    println!("{}", system_summary());
    let variants = variants();
    let default = default_variant();
    let results = measure(Path::new(&args[1]), &clip, language, &variants, |done, total, label| {
        if !label.is_empty() {
            println!("[{}/{}] {}", done + 1, total, label);
        }
    });
    for m in &results {
        println!("  {}: {:?} ms (load {} ms) {}", m.label, m.median_ms, m.load_ms, m.error.clone().unwrap_or_default());
    }
    match choose(&results, &default) {
        Some(i) => {
            let (backend, flash_attn) = settings_for(&results[i], &default);
            println!("chosen: {} -> gpuBackend {}, whisperFlashAttn {}", results[i].label, backend, flash_attn);
        }
        None => println!("nothing worked"),
    }
}
