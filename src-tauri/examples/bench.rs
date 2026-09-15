//! Backend benchmark: times model load and transcription for GPU with and
//! without flash attention, and for CPU.
//!
//!   cargo run --release --example bench -- <model_path> <wav_path> [runs]

use std::env;
use std::path::PathBuf;
use std::time::Instant;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

fn read_wav_samples_f32(path: &PathBuf) -> Vec<f32> {
    let mut reader = hound::WavReader::open(path).expect("open wav");
    let spec = reader.spec();
    assert_eq!(spec.channels, 1, "bench wav must be mono");
    assert_eq!(spec.sample_rate, 16_000, "bench wav must be 16 kHz");
    assert_eq!(spec.bits_per_sample, 16, "bench wav must be 16-bit");
    reader
        .samples::<i16>()
        .map(|s| s.expect("sample") as f32 / i16::MAX as f32)
        .collect()
}

fn bench(model_path: &PathBuf, samples: &[f32], use_gpu: bool, flash_attn: bool, runs: usize) {
    let label = format!("use_gpu={use_gpu} flash_attn={flash_attn}");
    let mut ctx_params = WhisperContextParameters::default();
    ctx_params.use_gpu = use_gpu;
    ctx_params.flash_attn = flash_attn;

    let t0 = Instant::now();
    let ctx = match WhisperContext::new_with_params(model_path.to_str().unwrap(), ctx_params) {
        Ok(c) => c,
        Err(e) => {
            println!("[{label}] load FAILED: {e:?}");
            return;
        }
    };
    let load_ms = t0.elapsed().as_millis();

    let threads = std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4)
        .clamp(1, 8);

    let mut times = Vec::new();
    let mut text = String::new();
    for _ in 0..runs {
        let mut state = ctx.create_state().expect("create_state");
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_temperature(0.0);
        params.set_n_threads(threads);
        let t = Instant::now();
        state.full(params, samples).expect("full");
        times.push(t.elapsed().as_millis());
        text = state
            .as_iter()
            .map(|s| s.to_str_lossy().unwrap().to_string())
            .collect::<String>();
    }
    let warm: Vec<_> = times.iter().skip(1).copied().collect();
    let warm_avg = if warm.is_empty() {
        times[0]
    } else {
        warm.iter().sum::<u128>() / warm.len() as u128
    };
    println!(
        "[{label}] load {load_ms} ms | first {} ms | warm avg {warm_avg} ms | {:?}",
        times[0],
        text.trim()
    );
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: bench <model_path> <wav_path> [runs]");
        std::process::exit(2);
    }
    let model_path = PathBuf::from(&args[1]);
    let samples = read_wav_samples_f32(&PathBuf::from(&args[2]));
    let runs = args.get(3).and_then(|r| r.parse().ok()).unwrap_or(4);
    println!(
        "audio {:.1} s, {runs} runs each",
        samples.len() as f32 / 16_000.0
    );

    bench(&model_path, &samples, true, true, runs);
    bench(&model_path, &samples, true, false, runs);
    if env::var("BENCH_SKIP_CPU").is_err() {
        bench(&model_path, &samples, false, false, runs.min(2));
    }
}
