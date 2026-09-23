use std::ffi::CStr;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// GPU API a ggml device belongs to. One build carries both backends, so an
/// NVIDIA card shows up twice (CUDA0 and Vulkan0) and an AMD/Intel card once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum GpuApi {
    Cuda,
    Vulkan,
}

impl GpuApi {
    pub fn label(self) -> &'static str {
        match self {
            GpuApi::Cuda => "CUDA",
            GpuApi::Vulkan => "Vulkan",
        }
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct GpuDevice {
    /// Position among GPU-type devices, which is what whisper.cpp's
    /// `gpu_device` parameter counts.
    pub gpu_index: i32,
    pub api: GpuApi,
    pub name: String,
}

/// Backend a model is actually loaded on.
#[derive(Debug, Clone, PartialEq)]
pub enum ActiveBackend {
    Gpu(GpuDevice),
    Cpu,
}

impl ActiveBackend {
    fn label(&self) -> String {
        match self {
            ActiveBackend::Gpu(d) => format!("{} ({})", d.api.label(), d.name),
            ActiveBackend::Cpu => "CPU".to_string(),
        }
    }
}

/// Name of the GPU Whisper uses (or will use) for this `gpuBackend` setting;
/// `None` for CPU. The AI cleanup server runs on the same card.
pub fn preferred_gpu_name(gpu_backend: &str) -> Option<String> {
    match backend_candidates(gpu_backend, &list_gpu_devices()).into_iter().next()? {
        ActiveBackend::Gpu(device) => Some(device.name),
        ActiveBackend::Cpu => None,
    }
}

/// Enumerate GPU devices the same way whisper.cpp does when it resolves
/// `gpu_device`, tagging each with its backend.
pub fn list_gpu_devices() -> Vec<GpuDevice> {
    use whisper_rs::whisper_rs_sys as sys;
    let mut out = Vec::new();
    // SAFETY: the ggml backend registry is process-global and initialised on
    // first access; these calls only read device metadata.
    unsafe {
        let mut gpu_index = 0;
        for i in 0..sys::ggml_backend_dev_count() {
            let dev = sys::ggml_backend_dev_get(i);
            let ty = sys::ggml_backend_dev_type(dev);
            if ty != sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_GPU
                && ty != sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_IGPU
            {
                continue;
            }
            let reg_name = CStr::from_ptr(sys::ggml_backend_reg_name(sys::ggml_backend_dev_backend_reg(dev)))
                .to_string_lossy()
                .into_owned();
            let api = match reg_name.as_str() {
                "CUDA" => Some(GpuApi::Cuda),
                "Vulkan" => Some(GpuApi::Vulkan),
                _ => None,
            };
            if let Some(api) = api {
                let name = CStr::from_ptr(sys::ggml_backend_dev_description(dev))
                    .to_string_lossy()
                    .trim()
                    .to_string();
                out.push(GpuDevice { gpu_index, api, name });
            }
            gpu_index += 1;
        }
    }
    out
}

/// Order of backends to try for the user's `gpuBackend` setting.
/// `auto` prefers CUDA (fastest on NVIDIA), then Vulkan (AMD, Intel, or NVIDIA
/// without a working CUDA runtime), then CPU. An explicit choice does not
/// fall back, so a broken setup surfaces as an error instead of silently
/// running slowly.
pub(crate) fn backend_candidates(requested: &str, devices: &[GpuDevice]) -> Vec<ActiveBackend> {
    let first = |api: GpuApi| {
        devices
            .iter()
            .find(|d| d.api == api)
            .cloned()
            .map(ActiveBackend::Gpu)
    };
    match requested {
        "cpu" => vec![ActiveBackend::Cpu],
        "cuda" => first(GpuApi::Cuda).into_iter().collect(),
        "vulkan" => first(GpuApi::Vulkan).into_iter().collect(),
        _ => first(GpuApi::Cuda)
            .into_iter()
            .chain(first(GpuApi::Vulkan))
            .chain(std::iter::once(ActiveBackend::Cpu))
            .collect(),
    }
}

/// Flash attention default per backend. On CUDA it is a free win. On Vulkan it
/// only pays off with cooperative-matrix support (RX 7000+, Arc, RTX); on an
/// RX 6800 (no matrix cores) large-v3-turbo ran 910 ms with it vs 434 ms
/// without for 17.5 s of audio, so Vulkan defaults to off.
/// Override with RUDARIFLOW_FLASH_ATTN=1 or =0.
pub(crate) fn flash_attn_default(api: GpuApi, env_override: Option<&str>) -> bool {
    match env_override {
        Some("1") | Some("true") => true,
        Some("0") | Some("false") => false,
        _ => api == GpuApi::Cuda,
    }
}

fn flash_attn_enabled(api: GpuApi) -> bool {
    flash_attn_default(api, std::env::var("RUDARIFLOW_FLASH_ATTN").ok().as_deref())
}

/// CPU thread count for whisper inference. Mirrors the Phase C clamp.
/// Also used on GPU: log-mel extraction and the ops the GPU backend does not
/// offload still run on the CPU.
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

use std::sync::Mutex;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

#[derive(Debug, Clone, serde::Serialize)]
pub struct PartialTranscript {
    pub text: String,
    pub is_final: bool,
}

pub struct WhisperEngine {
    inner: Mutex<EngineState>,
}

struct EngineState {
    loaded: Option<Loaded>,
}

struct Loaded {
    model_path: PathBuf,
    backend: ActiveBackend,
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
        self.lock().loaded = None;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, EngineState> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Ensure a model is loaded for the given path and `gpuBackend` setting.
    /// Returns the backend it ended up on. Changing the setting invalidates
    /// the engine (see `save_settings`), so a resident model for the same
    /// path is reused as is.
    pub fn ensure_loaded(&self, model_path: &Path, gpu_backend: &str) -> Result<ActiveBackend, String> {
        let mut state = self.lock();

        if let Some(existing) = &state.loaded {
            if existing.model_path == model_path {
                return Ok(existing.backend.clone());
            }
            state.loaded = None;
        }

        let devices = list_gpu_devices();
        let candidates = backend_candidates(gpu_backend, &devices);
        if candidates.is_empty() {
            let wanted = if gpu_backend == "cuda" { "NVIDIA CUDA" } else { "Vulkan" };
            return Err(format!("No {} GPU found (detected: {:?})", wanted, devices));
        }

        let mut last_err = String::new();
        for backend in candidates {
            match load_context(model_path, &backend) {
                Ok(ctx) => {
                    state.loaded = Some(Loaded {
                        model_path: model_path.to_path_buf(),
                        backend: backend.clone(),
                        ctx,
                    });
                    return Ok(backend);
                }
                Err(e) => {
                    crate::startup_log::log(&format!(
                        "[engine] load on {} failed: {}",
                        backend.label(),
                        e
                    ));
                    last_err = e;
                }
            }
        }
        Err(last_err)
    }

    /// Run a one-shot transcription on the provided 16 kHz mono samples.
    /// Caller is responsible for `ensure_loaded` before this; this fails
    /// loudly if no model is resident. With `overlay`, partial transcripts
    /// stream into the recording pill.
    /// Returns the text and the language Whisper used (detected, or the one
    /// set in the settings), as an English name such as "German".
    pub fn transcribe(
        &self,
        overlay: Option<&AppHandle>,
        samples: &[f32],
        language: &str,
        custom_prompt: &str,
    ) -> Result<(String, Option<String>), String> {
        let state = self.lock();
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

        params.set_n_threads(cpu_thread_count());

        let prompt = custom_prompt.trim();
        if !prompt.is_empty() {
            params.set_initial_prompt(prompt);
        }

        // Per-segment callback: emit cumulative text to the overlay.
        if let Some(app) = overlay {
            let app_for_cb = app.clone();
            params.set_segment_callback_safe(move |seg: whisper_rs::SegmentCallbackData| {
                let payload = PartialTranscript {
                    text: seg.text.trim().to_string(),
                    is_final: false,
                };
                // Emit only to the overlay window — main window doesn't need this.
                if let Some(overlay) = app_for_cb.get_webview_window("overlay") {
                    let _ = overlay.emit("partial-transcript", payload);
                }
            });
        }

        wstate
            .full(params, samples)
            .map_err(|e| format!("whisper full() failed: {e:?}"))?;

        let text = collect_segments(&wstate)?;
        let language = whisper_rs::get_lang_str_full(wstate.full_lang_id_from_state()).map(capitalize);

        // Final event so the overlay knows to stop accumulating.
        if let Some(overlay) = overlay.and_then(|app| app.get_webview_window("overlay")) {
            let _ = overlay.emit(
                "partial-transcript",
                PartialTranscript {
                    text: text.clone(),
                    is_final: true,
                },
            );
        }

        Ok((text, language))
    }
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

impl Default for WhisperEngine {
    fn default() -> Self {
        Self::new()
    }
}

fn load_context(model_path: &Path, backend: &ActiveBackend) -> Result<WhisperContext, String> {
    let mut params = WhisperContextParameters::default();
    match backend {
        ActiveBackend::Gpu(dev) => {
            params.use_gpu = true;
            params.gpu_device = dev.gpu_index;
            params.flash_attn = flash_attn_enabled(dev.api);
        }
        ActiveBackend::Cpu => {
            params.use_gpu = false;
            params.flash_attn = false;
        }
    }
    let flash_attn = params.flash_attn;

    let path_str = model_path
        .to_str()
        .ok_or_else(|| "model path is not valid UTF-8".to_string())?;
    let ctx = WhisperContext::new_with_params(path_str, params)
        .map_err(|e| format!("WhisperContext::new on {}: {e:?}", backend.label()))?;
    crate::startup_log::log(&format!(
        "whisper model loaded: {:?} backend={} flash_attn={}",
        model_path,
        backend.label(),
        flash_attn
    ));
    Ok(ctx)
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

    fn dev(gpu_index: i32, api: GpuApi) -> GpuDevice {
        GpuDevice { gpu_index, api, name: format!("{api:?}{gpu_index}") }
    }

    fn nvidia() -> Vec<GpuDevice> {
        // CUDA registers before Vulkan, so the same RTX card is index 0 and 1.
        vec![dev(0, GpuApi::Cuda), dev(1, GpuApi::Vulkan)]
    }

    fn amd() -> Vec<GpuDevice> {
        vec![dev(0, GpuApi::Vulkan)]
    }

    #[test]
    fn auto_prefers_cuda_then_vulkan_then_cpu() {
        let c = backend_candidates("auto", &nvidia());
        assert_eq!(
            c,
            vec![
                ActiveBackend::Gpu(dev(0, GpuApi::Cuda)),
                ActiveBackend::Gpu(dev(1, GpuApi::Vulkan)),
                ActiveBackend::Cpu
            ]
        );
    }

    #[test]
    fn auto_on_amd_uses_vulkan_then_cpu() {
        let c = backend_candidates("auto", &amd());
        assert_eq!(c, vec![ActiveBackend::Gpu(dev(0, GpuApi::Vulkan)), ActiveBackend::Cpu]);
    }

    #[test]
    fn auto_without_gpu_is_cpu() {
        assert_eq!(backend_candidates("auto", &[]), vec![ActiveBackend::Cpu]);
        // Unknown or legacy values behave like auto.
        assert_eq!(backend_candidates("gpu", &[]), vec![ActiveBackend::Cpu]);
    }

    #[test]
    fn explicit_choice_does_not_fall_back() {
        assert_eq!(
            backend_candidates("vulkan", &nvidia()),
            vec![ActiveBackend::Gpu(dev(1, GpuApi::Vulkan))]
        );
        assert!(backend_candidates("cuda", &amd()).is_empty());
        assert_eq!(backend_candidates("cpu", &nvidia()), vec![ActiveBackend::Cpu]);
    }

    #[test]
    fn flash_attn_defaults_per_api_and_env_wins() {
        assert!(flash_attn_default(GpuApi::Cuda, None));
        assert!(!flash_attn_default(GpuApi::Vulkan, None));
        assert!(flash_attn_default(GpuApi::Vulkan, Some("1")));
        assert!(!flash_attn_default(GpuApi::Cuda, Some("0")));
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
    #[ignore = "integration test now requires a Tauri AppHandle; exercise via npm run tauri dev"]
    fn integration_tiny_transcribe() {
        // Streaming transcribe takes &AppHandle which is impractical to
        // construct in a unit test. End-to-end coverage moved to manual
        // smoke testing of the running app.
    }
}
