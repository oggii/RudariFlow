//! Long dictations: one transcription after the release against pieces cut
//! in the quietest spot while recording (only the rest counts after the
//! release). Compares time and words on recordings over 30 s.
//!
//!   cargo run --release --example pieces_bench -- <model.bin> <wav dir> [language]

use std::path::PathBuf;
use std::time::Instant;

use rudariflow_lib::audio::quiet_cut;
use rudariflow_lib::history::read_wav;
use rudariflow_lib::whisper_engine::{list_gpu_devices, timed_run, GpuApi};
use whisper_rs::{WhisperContext, WhisperContextParameters, WhisperState};

fn text(state: &WhisperState) -> String {
    state.as_iter().map(|s| s.to_str_lossy().map(|t| t.into_owned()).unwrap_or_default()).collect::<String>().trim().to_string()
}

fn words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
        .filter(|w| !w.is_empty())
        .collect()
}

fn word_distance(a: &[String], b: &[String]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, wa) in a.iter().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, wb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + usize::from(wa != wb)).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: pieces_bench <model.bin> <wav dir> [language]");
        std::process::exit(2);
    }
    let language = args.get(3).map(String::as_str).unwrap_or("en");
    let mut wavs: Vec<PathBuf> = std::fs::read_dir(&args[2])
        .expect("wav dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "wav"))
        .collect();
    wavs.sort();
    let clips: Vec<Vec<f32>> = wavs
        .iter()
        .map(|p| read_wav(p).expect("read wav"))
        .filter(|c| c.len() > 30 * 16_000)
        .collect();
    // Too few long recordings: string short ones together into 40-70 s
    // dictations (their trimmed ends leave short pauses between them).
    let mut clips = clips;
    let short: Vec<Vec<f32>> = wavs.iter().map(|p| read_wav(p).expect("read wav")).filter(|c| c.len() <= 30 * 16_000).collect();
    let mut joined: Vec<f32> = Vec::new();
    for c in &short {
        joined.extend_from_slice(c);
        joined.extend(std::iter::repeat(0.0).take(8_000));
        if joined.len() > 40 * 16_000 {
            clips.push(std::mem::take(&mut joined));
            if clips.len() >= 8 {
                break;
            }
        }
    }
    println!("{} recordings over 30 s (with joined short ones)", clips.len());

    let dev = list_gpu_devices().into_iter().find(|d| d.api == GpuApi::Vulkan).expect("Vulkan GPU");
    let mut params = WhisperContextParameters::default();
    params.use_gpu = true;
    params.gpu_device = dev.gpu_index;
    params.flash_attn = false;
    let ctx = WhisperContext::new_with_params(&args[1], params).expect("load");
    let mut state = ctx.create_state().expect("state");
    timed_run(&mut state, &clips[0][..16_000 * 5], language).expect("warm");

    for clip in &clips {
        let secs = clip.len() as f32 / 16_000.0;
        let one_ms = timed_run(&mut state, clip, language).expect("full");
        let one = text(&state);

        // Pieces as the recorder cuts them: every 29 s, in the quietest spot from 22 s.
        let mut from = 0;
        let mut pieces = Vec::new();
        while clip.len() - from >= 29 * 16_000 {
            let cut = quiet_cut(&clip[from..], 22.0, 29.0);
            timed_run(&mut state, &clip[from..from + cut], language).expect("piece");
            pieces.push(text(&state));
            from += cut;
        }
        let started = Instant::now();
        let rest_ms = timed_run(&mut state, &clip[from..], language).expect("rest");
        let _ = started;
        pieces.push(text(&state));
        let joined = pieces.join(" ");
        let d = word_distance(&words(&one), &words(&joined));
        println!(
            "{:5.1} s: one pass {} ms after release, pieces {} + rest {:.1} s: {} ms after release; {} of {} words differ",
            secs,
            one_ms,
            pieces.len() - 1,
            (clip.len() - from) as f32 / 16_000.0,
            rest_ms,
            d,
            words(&one).len()
        );
        if d > 0 {
            println!("    one pass: {}\n    pieces:   {}", one, joined);
        }
    }
}
