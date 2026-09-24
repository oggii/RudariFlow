//! Language "auto" against a set language on real recordings: time, the
//! detected language and whether the texts match.
//!
//!   cargo run --release --example lang_bench -- <model.bin> <wav dir> [count] [language] [gpuBackend]

use std::path::PathBuf;
use std::time::Instant;

use rudariflow_lib::history::read_wav;
use rudariflow_lib::whisper_engine::{list_gpu_devices, GpuApi};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

fn run(state: &mut WhisperState, clip: &[f32], language: &str) -> (String, String, u128) {
    let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    p.set_language(Some(language));
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
    let lang = whisper_rs::get_lang_str(state.full_lang_id_from_state()).unwrap_or("?").to_string();
    (text.trim().to_string(), lang, ms)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: lang_bench <model.bin> <wav dir> [count] [language] [gpuBackend]");
        std::process::exit(2);
    }
    let count: usize = args.get(3).and_then(|c| c.parse().ok()).unwrap_or(20);
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
        ctx_params.use_gpu = true;
        ctx_params.gpu_device = dev.gpu_index;
    }
    let ctx = WhisperContext::new_with_params(&args[1], ctx_params).expect("load model");
    let mut state = ctx.create_state().expect("state");
    run(&mut state, &clips[0], "auto");

    let (mut auto_ms, mut set_ms, mut same, mut detected_same) = (Vec::new(), Vec::new(), 0, 0);
    for clip in &clips {
        let (auto_text, detected, a) = run(&mut state, clip, "auto");
        let (set_text, _, s) = run(&mut state, clip, language);
        auto_ms.push(a);
        set_ms.push(s);
        if detected == language {
            detected_same += 1;
            if auto_text == set_text {
                same += 1;
            } else {
                println!("DIFFERENT:\n  auto: {}\n  {}:   {}", auto_text, language, set_text);
            }
        }
    }
    auto_ms.sort();
    set_ms.sort();
    println!(
        "{} clips: auto median {} ms, {} median {} ms; detected {} in {}; same text {}/{}",
        clips.len(),
        auto_ms[auto_ms.len() / 2],
        language,
        set_ms[set_ms.len() / 2],
        language,
        detected_same,
        same,
        detected_same
    );
}
