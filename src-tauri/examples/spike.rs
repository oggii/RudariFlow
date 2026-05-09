use std::env;
use std::path::PathBuf;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

fn read_wav_samples_f32(path: &PathBuf) -> Vec<f32> {
    let mut reader = hound::WavReader::open(path).expect("open wav");
    let spec = reader.spec();
    assert_eq!(spec.channels, 1, "spike fixture must be mono");
    assert_eq!(spec.sample_rate, 16_000, "spike fixture must be 16 kHz");
    assert_eq!(spec.bits_per_sample, 16, "spike fixture must be 16-bit");
    reader
        .samples::<i16>()
        .map(|s| s.expect("sample") as f32 / i16::MAX as f32)
        .collect()
}

fn try_transcribe(model_path: &PathBuf, samples: &[f32], use_gpu: bool) -> Result<String, String> {
    let mut ctx_params = WhisperContextParameters::default();
    ctx_params.use_gpu = use_gpu;
    ctx_params.flash_attn = use_gpu;

    let ctx = WhisperContext::new_with_params(
        model_path.to_str().ok_or("non-utf8 model path")?,
        ctx_params,
    )
    .map_err(|e| format!("WhisperContext::new failed: {e:?}"))?;

    let mut state = ctx.create_state().map_err(|e| format!("create_state: {e:?}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_temperature(0.0);

    state
        .full(params, samples)
        .map_err(|e| format!("full() failed: {e:?}"))?;

    let mut out = String::new();
    for segment in state.as_iter() {
        let s = segment
            .to_str_lossy()
            .map_err(|e| format!("segment text: {e:?}"))?;
        out.push_str(&s);
    }
    Ok(out.trim().to_string())
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: spike <model_path> <wav_path>");
        std::process::exit(2);
    }
    let model_path = PathBuf::from(&args[1]);
    let wav_path = PathBuf::from(&args[2]);
    let samples = read_wav_samples_f32(&wav_path);

    println!("=== Phase B spike ===");
    println!("model: {:?}", model_path);
    println!("wav:   {:?} ({} samples)", wav_path, samples.len());

    println!("\n[1] use_gpu=true");
    match try_transcribe(&model_path, &samples, true) {
        Ok(t) => println!("  OK: {:?}", t),
        Err(e) => println!("  FAIL: {}", e),
    }

    println!("\n[2] use_gpu=false");
    match try_transcribe(&model_path, &samples, false) {
        Ok(t) => println!("  OK: {:?}", t),
        Err(e) => println!("  FAIL: {}", e),
    }
}
