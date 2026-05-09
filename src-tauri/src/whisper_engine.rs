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
}
