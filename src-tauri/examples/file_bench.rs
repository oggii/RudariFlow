//! File transcription without the app: decode, then Whisper block by block
//! on the Vulkan GPU, as the Files tab does. Prints timing and, with
//! --text, the transcript.
//!
//!   cargo run --release --example file_bench -- <model.bin> <file> [language] [--text]

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use rudariflow_lib::file_transcribe::{format, transcribe};
use rudariflow_lib::media::decode_16k_mono;
use rudariflow_lib::whisper_engine::WhisperEngine;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: file_bench <model.bin> <file> [language] [--text]");
        std::process::exit(2);
    }
    let language = args.get(3).filter(|a| !a.starts_with("--")).map(String::as_str).unwrap_or("auto");
    let show_text = args.iter().any(|a| a == "--text");

    let started = Instant::now();
    let audio = decode_16k_mono(Path::new(&args[2]), |_, _| {}).expect("decode");
    let decode_ms = started.elapsed().as_millis();

    let engine = WhisperEngine::new();
    let started = Instant::now();
    engine.ensure_loaded(Path::new(&args[1]), "vulkan").expect("load");
    let load_ms = started.elapsed().as_millis();

    let started = Instant::now();
    let mut blocks = 0;
    let (segments, language) = transcribe(&engine, &audio, language, "", |t| t.to_string(), &AtomicBool::new(false), |p| {
        blocks += 1;
        println!("  block {}: {:.0} of {:.0} s, {} segments", blocks, p.done_ms as f64 / 1000.0, p.total_ms as f64 / 1000.0, p.segments.len());
    })
    .expect("transcribe");
    let secs = audio.len() as f64 / 16_000.0;
    let run_s = started.elapsed().as_secs_f64();
    let text = format(&segments, false);
    println!(
        "{:.0} s audio: decode {} ms, load {} ms, transcribe {:.1} s ({:.0}x realtime), language {}, {} segments, {} words, {} paragraphs",
        secs,
        decode_ms,
        load_ms,
        run_s,
        secs / run_s,
        language,
        segments.len(),
        text.split_whitespace().count(),
        text.split("\n\n").count()
    );
    if show_text {
        println!("{}", format(&segments, true));
    }
}
