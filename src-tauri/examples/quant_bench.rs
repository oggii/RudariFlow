//! Whisper models against a reference model on real recordings: time, video
//! memory is not measured here, and word differences to the reference text.
//!
//!   cargo run --release --example quant_bench -- <wav dir> <count> <reference.bin> <model.bin>...

use std::path::PathBuf;
use std::time::Instant;

use rudariflow_lib::history::read_wav;
use rudariflow_lib::whisper_engine::{list_gpu_devices, GpuApi};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

fn run(state: &mut WhisperState, clip: &[f32]) -> (String, u128) {
    let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(Some("en"));
    p.set_print_special(false);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_timestamps(false);
    p.set_temperature(0.0);
    p.set_no_context(true);
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
    if args.len() < 5 {
        eprintln!("usage: quant_bench <wav dir> <count> <reference.bin> <model.bin>...");
        std::process::exit(2);
    }
    let count: usize = args[2].parse().unwrap_or(50);
    let mut wavs: Vec<PathBuf> = std::fs::read_dir(&args[1])
        .expect("wav dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "wav"))
        .collect();
    wavs.sort();
    wavs.reverse();
    wavs.truncate(count);
    let clips: Vec<Vec<f32>> = wavs.iter().map(|p| read_wav(p).expect("read wav")).collect();
    let dev = list_gpu_devices().into_iter().find(|d| d.api == GpuApi::Vulkan).expect("Vulkan GPU");

    let mut reference: Vec<String> = Vec::new();
    for model in &args[3..] {
        let mut params = WhisperContextParameters::default();
        params.use_gpu = true;
        params.gpu_device = dev.gpu_index;
        params.flash_attn = false;
        let load = Instant::now();
        let ctx = WhisperContext::new_with_params(model, params).expect("load model");
        let load_ms = load.elapsed().as_millis();
        let mut state = ctx.create_state().expect("state");
        run(&mut state, &clips[0]);
        let (mut times, mut edits, mut total, mut changed) = (Vec::new(), 0, 0, 0);
        for (i, clip) in clips.iter().enumerate() {
            let (text, ms) = run(&mut state, clip);
            times.push(ms);
            if reference.len() < clips.len() {
                reference.push(text.clone());
            }
            let (a, b) = (words(&reference[i]), words(&text));
            let d = word_distance(&a, &b);
            edits += d;
            total += a.len();
            if d > 0 {
                changed += 1;
                if changed <= 3 {
                    println!("  {} word(s) differ:\n    reference: {}\n    this:      {}", d, reference[i], text);
                }
            }
        }
        times.sort();
        let name = PathBuf::from(model).file_name().unwrap().to_string_lossy().into_owned();
        println!(
            "{:<32} load {:>5} ms | median {:>4} ms | {:>2} of {} clips differ | {:.1} % of words",
            name,
            load_ms,
            times[times.len() / 2],
            changed,
            clips.len(),
            100.0 * edits as f32 / total.max(1) as f32
        );
    }
}
