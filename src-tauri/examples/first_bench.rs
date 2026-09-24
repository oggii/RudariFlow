//! The first transcription after loading a model, without ("cold") and
//! with ("warm") the warm-up run WhisperEngine does while loading. Run each
//! mode in its own process.
//!
//!   cargo run --release --example first_bench -- <cold|warm> <model.bin> <clip.wav>

use std::path::Path;
use std::time::Instant;

use rudariflow_lib::history::read_wav;
use rudariflow_lib::whisper_engine::{list_gpu_devices, warm_up, GpuApi};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const PROMPT: &str = "GitHub, Tauri, Grüssen-Shop, RudariFlow";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: first_bench <cold|warm> <model.bin> <clip.wav>");
        std::process::exit(2);
    }
    let (mode, model) = (args[1].as_str(), &args[2]);
    let clip = read_wav(Path::new(&args[3])).expect("read wav");

    let load = Instant::now();
    let dev = list_gpu_devices().into_iter().find(|d| d.api == GpuApi::Vulkan).expect("Vulkan GPU");
    let mut params = WhisperContextParameters::default();
    params.use_gpu = true;
    params.gpu_device = dev.gpu_index;
    params.flash_attn = false;
    let ctx = WhisperContext::new_with_params(model, params).expect("load");
    let mut state = ctx.create_state().expect("state");
    if mode == "warm" {
        warm_up(&mut state);
    }
    println!("{}: load {} ms", mode, load.elapsed().as_millis());
    let mut times = Vec::new();
    for _ in 0..2 {
        let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        p.set_language(Some("en"));
        p.set_print_progress(false);
        p.set_print_realtime(false);
        p.set_temperature(0.0);
        p.set_no_context(true);
        p.set_initial_prompt(PROMPT);
        let t = Instant::now();
        state.full(p, &clip).expect("full");
        times.push(t.elapsed().as_millis());
    }
    println!("{}: first dictation {} ms, second {} ms", mode, times[0], times[1]);
}
