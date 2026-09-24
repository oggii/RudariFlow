//! Encoder window (audio_ctx) sized to the clip against the full 30 s window,
//! on real recordings: time and word differences to the full-window text.
//!
//!   cargo run --release --example ctx_bench -- <model.bin> <wav dir> [count] [language] [gpuBackend]

use std::path::PathBuf;
use std::time::Instant;

use rudariflow_lib::history::read_wav;
use rudariflow_lib::whisper_engine::{list_gpu_devices, GpuApi};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

fn run(state: &mut WhisperState, clip: &[f32], language: &str, audio_ctx: i32) -> (String, u128) {
    let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(Some(language));
    p.set_print_special(false);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_timestamps(false);
    p.set_temperature(0.0);
    p.set_no_context(true);
    p.set_audio_ctx(audio_ctx);
    p.set_n_threads(std::thread::available_parallelism().map(|n| n.get() as i32).unwrap_or(4).clamp(1, 8));
    let t = Instant::now();
    state.full(p, clip).expect("full");
    let ms = t.elapsed().as_millis();
    let text = state.as_iter().map(|s| s.to_str_lossy().map(|t| t.into_owned()).unwrap_or_default()).collect::<String>();
    (text.trim().to_string(), ms)
}

fn words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
        .filter(|w| !w.is_empty())
        .collect()
}

/// Word edits needed to turn `a` into `b`.
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
        eprintln!("usage: ctx_bench <model.bin> <wav dir> [count] [language] [gpuBackend]");
        std::process::exit(2);
    }
    let count: usize = args.get(3).and_then(|c| c.parse().ok()).unwrap_or(50);
    let language = args.get(4).map(String::as_str).unwrap_or("en");
    let backend = args.get(5).map(String::as_str).unwrap_or("vulkan");
    let mut wavs: Vec<PathBuf> = std::fs::read_dir(&args[2])
        .expect("wav dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "wav"))
        .collect();
    wavs.sort();
    wavs.reverse();
    let clips: Vec<Vec<f32>> = wavs
        .iter()
        .map(|p| read_wav(p).expect("read wav"))
        .filter(|c| c.len() < 29 * 16_000)
        .take(count)
        .collect();

    let mut ctx_params = WhisperContextParameters::default();
    ctx_params.flash_attn = false;
    if backend == "cpu" {
        ctx_params.use_gpu = false;
    } else {
        let api = if backend == "cuda" { GpuApi::Cuda } else { GpuApi::Vulkan };
        let dev = list_gpu_devices().into_iter().find(|d| d.api == api).expect("GPU");
        ctx_params.use_gpu = true;
        ctx_params.gpu_device = dev.gpu_index;
    }
    let ctx = WhisperContext::new_with_params(&args[1], ctx_params).expect("load model");
    let mut state = ctx.create_state().expect("state");
    run(&mut state, &clips[0], language, 0);

    // Frames of 20 ms: 50 per second, 1500 for 30 s.
    let frames = |clip: &Vec<f32>| (clip.len() as f32 / 16_000.0 * 50.0).ceil() as i32;
    let variants: [(&str, Box<dyn Fn(i32) -> i32>); 4] = [
        ("full 1500", Box::new(|_| 0)),
        ("len+128", Box::new(|f| (f + 128).min(1500))),
        ("len+256", Box::new(|f| (f + 256).min(1500))),
        ("max(len+128, 768)", Box::new(|f| (f + 128).max(768).min(1500))),
    ];
    let mut reference = Vec::new();
    for (name, size) in &variants {
        let (mut times, mut edits, mut total_words, mut changed) = (Vec::new(), 0, 0, 0);
        for (i, clip) in clips.iter().enumerate() {
            let (text, ms) = run(&mut state, clip, language, size(frames(clip)));
            times.push(ms);
            if reference.len() < clips.len() {
                reference.push(text.clone());
            }
            let (a, b) = (words(&reference[i]), words(&text));
            let d = word_distance(&a, &b);
            edits += d;
            total_words += a.len();
            if d > 0 {
                changed += 1;
                if changed <= 3 {
                    println!("  [{}] {} word(s) differ:\n    full: {}\n    this: {}", name, d, reference[i], text);
                }
            }
        }
        times.sort();
        println!(
            "{:<18} median {:>4} ms | {:>2} of {} clips differ | {:.1} % of words",
            name,
            times[times.len() / 2],
            changed,
            clips.len(),
            100.0 * edits as f32 / total_words.max(1) as f32
        );
    }
}
