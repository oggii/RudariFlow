use std::path::{Path, PathBuf};

/// Where the engine decides to run after probing the GPU.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackendChoice {
    Gpu,
    Cpu,
}

/// Decide which backend to attempt first based on the user's `gpuBackend`
/// setting. The actual fallback after a failed GPU load is handled in
/// `ensure_loaded`; this is just the initial intent.
pub(crate) fn initial_backend_intent(requested: &str) -> BackendChoice {
    match requested {
        "cpu" => BackendChoice::Cpu,
        _ => BackendChoice::Gpu, // "auto" and "cuda" both start by trying GPU
    }
}

/// Whether a `use_gpu=true` failure should fall back to CPU.
/// Auto: yes. Explicit "cuda": no — surface the error to the user.
pub(crate) fn should_fallback_on_gpu_failure(requested: &str) -> bool {
    requested == "auto"
}

/// CPU thread count for whisper inference. Mirrors the Phase C clamp.
pub(crate) fn cpu_thread_count() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4)
        .clamp(1, 8)
}

pub fn model_filename(model_size: &str) -> String {
    format!("ggml-{}.bin", model_size)
}

pub fn model_download_url(model_size: &str) -> String {
    format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{}.bin",
        model_size
    )
}

#[derive(Debug, Clone)]
pub(crate) struct LoadedModelKey {
    pub model_path: PathBuf,
    pub use_gpu: bool,
}

/// Whether a settings change requires reloading the model. Reload iff
/// either the model file path or the GPU mode differs.
pub(crate) fn needs_reload(prev: &LoadedModelKey, next: &LoadedModelKey) -> bool {
    prev.model_path != next.model_path || prev.use_gpu != next.use_gpu
}

pub(crate) fn loaded_key(model_path: &Path, use_gpu: bool) -> LoadedModelKey {
    LoadedModelKey {
        model_path: model_path.to_path_buf(),
        use_gpu,
    }
}

use std::sync::Mutex;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

pub struct WhisperEngine {
    inner: Mutex<EngineState>,
}

struct EngineState {
    loaded: Option<Loaded>,
}

struct Loaded {
    key: LoadedModelKey,
    ctx: WhisperContext,
}

impl WhisperEngine {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(EngineState { loaded: None }),
        }
    }

    /// Drop the cached model. Next call reloads. Used when settings change.
    pub fn invalidate(&self) {
        self.inner.lock().unwrap().loaded = None;
    }

    /// Ensure a model is loaded for the given path and gpu mode. Returns
    /// the actual `use_gpu` chosen (may differ from requested when "auto"
    /// falls back to CPU after a failed GPU load).
    pub fn ensure_loaded(&self, model_path: &Path, gpu_backend: &str) -> Result<bool, String> {
        let intent = initial_backend_intent(gpu_backend);
        let try_gpu_first = matches!(intent, BackendChoice::Gpu);
        let allow_fallback = should_fallback_on_gpu_failure(gpu_backend);

        let mut state = self.inner.lock().unwrap();

        if let Some(existing) = &state.loaded {
            let want_gpu = try_gpu_first;
            if existing.key.model_path == model_path
                && (existing.key.use_gpu == want_gpu || !allow_fallback)
            {
                return Ok(existing.key.use_gpu);
            }
            state.loaded = None;
        }

        let first_try_use_gpu = try_gpu_first;
        match load_context(model_path, first_try_use_gpu) {
            Ok(ctx) => {
                state.loaded = Some(Loaded {
                    key: loaded_key(model_path, first_try_use_gpu),
                    ctx,
                });
                Ok(first_try_use_gpu)
            }
            Err(e) if allow_fallback && first_try_use_gpu => {
                eprintln!(
                    "[RudariFlow] GPU load failed ({}); falling back to CPU.",
                    e
                );
                let ctx = load_context(model_path, false)?;
                state.loaded = Some(Loaded {
                    key: loaded_key(model_path, false),
                    ctx,
                });
                Ok(false)
            }
            Err(e) => Err(e),
        }
    }

    /// Run a one-shot transcription on the provided 16 kHz mono samples.
    /// Caller is responsible for `ensure_loaded` before this; this fails
    /// loudly if no model is resident.
    pub fn transcribe(
        &self,
        samples: &[f32],
        language: &str,
        custom_prompt: &str,
    ) -> Result<String, String> {
        let state = self.inner.lock().unwrap();
        let loaded = state
            .loaded
            .as_ref()
            .ok_or_else(|| "WhisperEngine: no model loaded".to_string())?;

        let mut wstate = loaded
            .ctx
            .create_state()
            .map_err(|e| format!("create_state: {e:?}"))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(language));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_temperature(0.0);
        params.set_single_segment(false);

        if !loaded.key.use_gpu {
            params.set_n_threads(cpu_thread_count());
        }

        let prompt = custom_prompt.trim();
        if !prompt.is_empty() {
            params.set_initial_prompt(prompt);
        }

        wstate
            .full(params, samples)
            .map_err(|e| format!("whisper full() failed: {e:?}"))?;

        collect_segments(&wstate)
    }
}

impl Default for WhisperEngine {
    fn default() -> Self {
        Self::new()
    }
}

fn load_context(model_path: &Path, use_gpu: bool) -> Result<WhisperContext, String> {
    let mut params = WhisperContextParameters::default();
    params.use_gpu = use_gpu;
    params.flash_attn = use_gpu; // free perf on Ampere+; degrades elsewhere

    let path_str = model_path
        .to_str()
        .ok_or_else(|| "model path is not valid UTF-8".to_string())?;
    WhisperContext::new_with_params(path_str, params)
        .map_err(|e| format!("WhisperContext::new (use_gpu={}): {e:?}", use_gpu))
}

fn collect_segments(state: &WhisperState) -> Result<String, String> {
    let mut out = String::new();
    for segment in state.as_iter() {
        let s = segment
            .to_str_lossy()
            .map_err(|e| format!("segment text: {e:?}"))?;
        out.push_str(&s);
    }
    Ok(out.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intent_for_cpu_is_cpu() {
        assert_eq!(initial_backend_intent("cpu"), BackendChoice::Cpu);
    }

    #[test]
    fn intent_for_cuda_is_gpu() {
        assert_eq!(initial_backend_intent("cuda"), BackendChoice::Gpu);
    }

    #[test]
    fn intent_for_auto_is_gpu() {
        assert_eq!(initial_backend_intent("auto"), BackendChoice::Gpu);
    }

    #[test]
    fn intent_for_unknown_is_gpu() {
        // Defensive: unknown strings (future settings) attempt GPU first.
        assert_eq!(initial_backend_intent(""), BackendChoice::Gpu);
    }

    #[test]
    fn fallback_only_on_auto() {
        assert!(should_fallback_on_gpu_failure("auto"));
        assert!(!should_fallback_on_gpu_failure("cuda"));
        assert!(!should_fallback_on_gpu_failure("cpu"));
    }

    #[test]
    fn cpu_thread_count_is_clamped() {
        let n = cpu_thread_count();
        assert!((1..=8).contains(&n), "thread count {} out of range", n);
    }

    #[test]
    fn model_filename_format() {
        assert_eq!(model_filename("small"), "ggml-small.bin");
        assert_eq!(model_filename("large-v3-turbo"), "ggml-large-v3-turbo.bin");
    }

    #[test]
    fn model_download_url_format() {
        assert_eq!(
            model_download_url("small"),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
        );
    }

    #[test]
    fn needs_reload_on_path_change() {
        let a = loaded_key(Path::new("/m/small.bin"), true);
        let b = loaded_key(Path::new("/m/medium.bin"), true);
        assert!(needs_reload(&a, &b));
    }

    #[test]
    fn needs_reload_on_gpu_mode_change() {
        let a = loaded_key(Path::new("/m/small.bin"), true);
        let b = loaded_key(Path::new("/m/small.bin"), false);
        assert!(needs_reload(&a, &b));
    }

    #[test]
    fn no_reload_when_identical() {
        let a = loaded_key(Path::new("/m/small.bin"), true);
        let b = loaded_key(Path::new("/m/small.bin"), true);
        assert!(!needs_reload(&a, &b));
    }

    /// Loads a real `ggml-tiny.bin` and transcribes the spike fixture.
    /// Skipped by default; run manually:
    ///   cargo test --lib whisper_engine::tests::integration_tiny_transcribe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn integration_tiny_transcribe() {
        let appdata = std::env::var("APPDATA").expect("APPDATA env var");
        let model = PathBuf::from(&appdata).join("com.rudariflow.app").join("ggml-tiny.bin");
        if !model.exists() {
            panic!("tiny model not found at {:?} — download via the app first", model);
        }
        let wav = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/spike-3s.wav");
        let samples = read_wav_16k_mono(&wav);

        let engine = WhisperEngine::new();
        let used_gpu = engine
            .ensure_loaded(&model, "auto")
            .expect("ensure_loaded");
        eprintln!("ensure_loaded chose use_gpu={}", used_gpu);

        let text = engine.transcribe(&samples, "en", "").expect("transcribe");
        eprintln!("transcribed: {:?}", text);
        assert!(!text.is_empty(), "transcription should be non-empty");
    }

    fn read_wav_16k_mono(path: &PathBuf) -> Vec<f32> {
        let mut reader = hound::WavReader::open(path).expect("open wav");
        let spec = reader.spec();
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, 16_000);
        assert_eq!(spec.bits_per_sample, 16);
        reader
            .samples::<i16>()
            .map(|s| s.expect("sample") as f32 / i16::MAX as f32)
            .collect()
    }
}
