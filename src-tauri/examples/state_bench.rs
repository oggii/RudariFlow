//! Whisper state per dictation: a fresh state each time (before) against one
//! reused state (after), on real recordings. Checks that the texts match.
//!
//!   cargo run --release --example state_bench -- <model.bin> <wav dir> [count] [language] [gpuBackend]
//!
//! <wav dir> is e.g. the history folder (16 kHz mono WAVs).

use std::path::PathBuf;
use std::time::Instant;

use rudariflow_lib::history::read_wav;
use rudariflow_lib::whisper_engine::{list_gpu_devices, GpuApi};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

fn params(language: &str) -> FullParams<'_, 'static> {
    let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(Some(language));
    p.set_print_special(false);
    p.set_print_progress(false);
    p.set_print_realtime(false);
    p.set_print_timestamps(false);
    p.set_temperature(0.0);
    p.set_no_context(true);
    p.set_n_threads(std::thread::available_parallelism().map(|n| n.get() as i32).unwrap_or(4).clamp(1, 8));
    p
}

fn text(state: &WhisperState) -> String {
    state.as_iter().map(|s| s.to_str_lossy().map(|t| t.into_owned()).unwrap_or_default()).collect::<String>().trim().to_string()
}

fn median(mut v: Vec<u128>) -> u128 {
    v.sort();
    v[v.len() / 2]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: state_bench <model.bin> <wav dir> [count] [language] [gpuBackend]");
        std::process::exit(2);
    }
    let model = &args[1];
    let count: usize = args.get(3).and_then(|c| c.parse().ok()).unwrap_or(15);
    let language = args.get(4).map(String::as_str).unwrap_or("en");
    let backend = args.get(5).map(String::as_str).unwrap_or("vulkan");

    let mut wavs: Vec<PathBuf> = std::fs::read_dir(&args[2])
        .expect("wav dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "wav"))
        .collect();
    wavs.sort();
    wavs.reverse();
    wavs.truncate(count);
    let clips: Vec<Vec<f32>> = wavs.iter().map(|p| read_wav(p).expect("read wav")).collect();

    let mut ctx_params = WhisperContextParameters::default();
    ctx_params.flash_attn = false;
    if backend == "cpu" {
        ctx_params.use_gpu = false;
    } else {
        let api = if backend == "cuda" { GpuApi::Cuda } else { GpuApi::Vulkan };
        let dev = list_gpu_devices().into_iter().find(|d| d.api == api).expect("GPU");
        println!("device: {} ({:?})", dev.name, dev.api);
        ctx_params.use_gpu = true;
        ctx_params.gpu_device = dev.gpu_index;
    }
    let ctx = WhisperContext::new_with_params(model, ctx_params).expect("load model");

    // Warm the GPU pipelines once so neither mode pays for them.
    let mut warm = ctx.create_state().expect("state");
    warm.full(params(language), &clips[0]).expect("full");
    drop(warm);

    let (mut create_ms, mut fresh_full_ms, mut fresh_texts) = (Vec::new(), Vec::new(), Vec::new());
    for clip in &clips {
        let t = Instant::now();
        let mut state = ctx.create_state().expect("state");
        create_ms.push(t.elapsed().as_millis());
        let t = Instant::now();
        state.full(params(language), clip).expect("full");
        fresh_full_ms.push(t.elapsed().as_millis());
        fresh_texts.push(text(&state));
    }

    let mut state = ctx.create_state().expect("state");
    let (mut reused_full_ms, mut same) = (Vec::new(), 0);
    for (clip, fresh) in clips.iter().zip(&fresh_texts) {
        let t = Instant::now();
        state.full(params(language), clip).expect("full");
        reused_full_ms.push(t.elapsed().as_millis());
        let reused = text(&state);
        if &reused == fresh {
            same += 1;
        } else {
            println!("DIFFERENT:\n  fresh:  {}\n  reused: {}", fresh, reused);
        }
    }

    let audio: f32 = clips.iter().map(|c| c.len() as f32 / 16_000.0).sum::<f32>() / clips.len() as f32;
    println!("{} clips, {:.1} s audio on average, language {}", clips.len(), audio, language);
    println!(
        "fresh state:  create {} ms + full {} ms (medians)",
        median(create_ms.clone()),
        median(fresh_full_ms.clone())
    );
    println!("reused state: full {} ms (median)", median(reused_full_ms));
    println!("create_state max {} ms; same text {}/{}", create_ms.iter().max().unwrap(), same, clips.len());
}
