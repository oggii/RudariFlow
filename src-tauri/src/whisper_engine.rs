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
    /// Integrated GPU sharing system memory; a dedicated card goes first.
    pub integrated: bool,
    pub memory_mib: u64,
}

/// Oldest NVIDIA generation the release build has CUDA kernels for
/// (CUDAARCHS 75;80;86;89;120: GTX 16 / RTX 20 and newer). On an older card
/// the first kernel aborts the process, so such a card goes through Vulkan.
const MIN_CUDA_CC: (i32, i32) = (7, 5);

/// Whether CUDA can run on a card with this compute capability; unknown
/// counts as yes.
pub(crate) fn cuda_cc_supported(cc: Option<(i32, i32)>) -> bool {
    cc.is_none_or(|cc| cc >= MIN_CUDA_CC)
}

/// Compute capability of CUDA device `ordinal` from the CUDA runtime that
/// ggml already loads.
#[cfg(feature = "cuda")]
fn cuda_compute_capability(ordinal: i32) -> Option<(i32, i32)> {
    extern "C" {
        fn cudaDeviceGetAttribute(value: *mut i32, attr: i32, device: i32) -> i32;
    }
    // cudaDevAttrComputeCapabilityMajor / Minor
    const MAJOR: i32 = 75;
    const MINOR: i32 = 76;
    let (mut major, mut minor) = (0, 0);
    // SAFETY: plain out-parameters; a failing call only returns an error code.
    let ok = unsafe {
        cudaDeviceGetAttribute(&mut major, MAJOR, ordinal) == 0
            && cudaDeviceGetAttribute(&mut minor, MINOR, ordinal) == 0
    };
    ok.then_some((major, minor))
}

#[cfg(not(feature = "cuda"))]
fn cuda_compute_capability(_ordinal: i32) -> Option<(i32, i32)> {
    None
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
/// `gpu_device`, tagging each with its backend. NVIDIA cards too old for the
/// bundled CUDA kernels are left out of the CUDA list (they keep Vulkan).
pub fn list_gpu_devices() -> Vec<GpuDevice> {
    use whisper_rs::whisper_rs_sys as sys;
    static LOGGED_OLD_CUDA: std::sync::Once = std::sync::Once::new();
    let mut out = Vec::new();
    let mut too_old = Vec::new();
    // SAFETY: the ggml backend registry is process-global and initialised on
    // first access; these calls only read device metadata.
    unsafe {
        let mut gpu_index = 0;
        for i in 0..sys::ggml_backend_dev_count() {
            let dev = sys::ggml_backend_dev_get(i);
            let ty = sys::ggml_backend_dev_type(dev);
            let integrated = ty == sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_IGPU;
            if ty != sys::ggml_backend_dev_type_GGML_BACKEND_DEVICE_TYPE_GPU && !integrated {
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
                let usable = api != GpuApi::Cuda || {
                    // ggml names CUDA devices "CUDA<ordinal>".
                    let dev_name = CStr::from_ptr(sys::ggml_backend_dev_name(dev)).to_string_lossy();
                    let ordinal = dev_name.trim_start_matches("CUDA").parse().unwrap_or(0);
                    let cc = cuda_compute_capability(ordinal);
                    if !cuda_cc_supported(cc) {
                        too_old.push(format!("{} (compute capability {:?})", name, cc));
                    }
                    cuda_cc_supported(cc)
                };
                if usable {
                    let (mut free, mut total) = (0usize, 0usize);
                    sys::ggml_backend_dev_memory(dev, &mut free, &mut total);
                    let memory_mib = (total / (1024 * 1024)) as u64;
                    out.push(GpuDevice { gpu_index, api, name, integrated, memory_mib });
                }
            }
            gpu_index += 1;
        }
    }
    if !too_old.is_empty() {
        LOGGED_OLD_CUDA.call_once(|| {
            crate::startup_log::log(&format!("[engine] too old for CUDA, using Vulkan: {}", too_old.join(", ")));
        });
    }
    out
}

/// Order of backends to try for the user's `gpuBackend` setting.
/// `auto` prefers CUDA (fastest on NVIDIA), then Vulkan (AMD, Intel, or NVIDIA
/// without a working CUDA runtime), then CPU. Within an API a dedicated card
/// goes before an integrated GPU, then the one with more memory: Vulkan can
/// list a laptop's iGPU first. An explicit choice does not fall back, so a
/// broken setup surfaces as an error instead of silently running slowly.
pub(crate) fn backend_candidates(requested: &str, devices: &[GpuDevice]) -> Vec<ActiveBackend> {
    let first = |api: GpuApi| {
        devices
            .iter()
            .filter(|d| d.api == api)
            .min_by_key(|d| (d.integrated, std::cmp::Reverse(d.memory_mib), d.gpu_index))
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
/// The PC check can set it per PC (`pref`); RUDARIFLOW_FLASH_ATTN=1 or =0
/// overrides both.
pub(crate) fn flash_attn_default(api: GpuApi, env_override: Option<&str>, pref: Option<bool>) -> bool {
    match env_override {
        Some("1") | Some("true") => true,
        Some("0") | Some("false") => false,
        _ => pref.unwrap_or(api == GpuApi::Cuda),
    }
}

fn flash_attn_enabled(api: GpuApi, pref: Option<bool>) -> bool {
    flash_attn_default(api, std::env::var("RUDARIFLOW_FLASH_ATTN").ok().as_deref(), pref)
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
    /// Flash attention from the settings (PC check); `None` = per API.
    flash_attn: Mutex<Option<bool>>,
}

struct EngineState {
    loaded: Option<Loaded>,
}

struct Loaded {
    model_path: PathBuf,
    backend: ActiveBackend,
    ctx: WhisperContext,
    /// Kept between dictations: creating a state sets up the GPU backend,
    /// the KV caches and the compute buffers each time.
    state: WhisperState,
}

impl WhisperEngine {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(EngineState { loaded: None }),
            flash_attn: Mutex::new(None),
        }
    }

    /// Flash attention setting; a change drops the loaded model.
    pub fn set_flash_attn(&self, pref: Option<bool>) {
        let mut current = self.flash_attn.lock().unwrap_or_else(|p| p.into_inner());
        if *current != pref {
            *current = pref;
            drop(current);
            self.invalidate();
        }
    }

    /// Drop the cached model. Next call reloads. Used when settings change
    /// and to free the GPU on battery.
    pub fn invalidate(&self) {
        self.lock().loaded = None;
    }

    pub fn is_loaded(&self) -> bool {
        self.lock().loaded.is_some()
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
            let flash_attn = *self.flash_attn.lock().unwrap_or_else(|p| p.into_inner());
            let loaded = load_context(model_path, &backend, flash_attn).and_then(|ctx| {
                let mut wstate = new_state(&ctx)?;
                warm_up(&mut wstate);
                Ok((ctx, wstate))
            });
            match loaded {
                Ok((ctx, wstate)) => {
                    state.loaded = Some(Loaded {
                        model_path: model_path.to_path_buf(),
                        backend: backend.clone(),
                        ctx,
                        state: wstate,
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
        let mut state = self.lock();
        let loaded = state
            .loaded
            .as_mut()
            .ok_or_else(|| "WhisperEngine: no model loaded".to_string())?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(language));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_temperature(0.0);
        params.set_single_segment(false);
        // The state is reused: never carry text over from the last dictation.
        params.set_no_context(true);

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

        let started = std::time::Instant::now();
        if let Err(e) = loaded.state.full(params, samples) {
            // Start the next dictation from a fresh state.
            if let Ok(fresh) = new_state(&loaded.ctx) {
                loaded.state = fresh;
            }
            return Err(format!("whisper full() failed: {e:?}"));
        }
        crate::startup_log::log(&format!(
            "[whisper] {:.1} s audio on {}, language {}: {} ms",
            samples.len() as f32 / 16_000.0,
            loaded.backend.label(),
            language,
            started.elapsed().as_millis()
        ));

        let text = collect_segments(&loaded.state)?;
        let language = whisper_rs::get_lang_str_full(loaded.state.full_lang_id_from_state()).map(capitalize);

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

/// A piece of a file transcript; times in ms from the start of the file.
/// `speaker` is set when the Files tab separated speakers (0 = first voice).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Segment {
    #[serde(rename = "startMs")]
    pub start_ms: u64,
    #[serde(rename = "endMs")]
    pub end_ms: u64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<u8>,
}

/// A file being transcribed, with a Whisper state of its own.
pub struct FileRun {
    state: WhisperState,
    /// The Whisper language; "auto" until a stretch of at least
    /// `LANGUAGE_FROM_SECS` detected it, then fixed, so a long file does not
    /// switch language midway (and a cough does not pick it).
    pub language: String,
}

/// Shortest stretch whose detected language is kept for the rest of a file.
const LANGUAGE_FROM_SECS: usize = 5;

impl WhisperEngine {
    /// Start transcribing a file with the loaded model.
    pub fn start_file(&self, language: &str) -> Result<FileRun, String> {
        let engine = self.lock();
        let loaded = engine.loaded.as_ref().ok_or_else(|| "WhisperEngine: no model loaded".to_string())?;
        Ok(FileRun { state: new_state(&loaded.ctx)?, language: language.to_string() })
    }

    /// Transcribe one block of a file that starts `offset_ms` into it.
    /// `prompt` carries the dictionary and the text before the block. The
    /// engine stays locked for this block only (one GPU user at a time), so
    /// a dictation in between waits for one block at most.
    pub fn file_block(&self, run: &mut FileRun, samples: &[f32], offset_ms: u64, prompt: &str) -> Result<Vec<Segment>, String> {
        let _gpu = self.lock();
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some(&run.language));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_temperature(0.0);
        // The prompt holds the context: whisper.cpp would otherwise put the
        // previous block's text in front of the dictionary and drop the
        // dictionary first, so names were spelled right only in minute one.
        params.set_no_context(true);
        params.set_n_threads(cpu_thread_count());
        let prompt = prompt.trim();
        if !prompt.is_empty() {
            params.set_initial_prompt(prompt);
        }
        run.state.full(params, samples).map_err(|e| format!("whisper full() failed: {e:?}"))?;
        if run.language == "auto" && samples.len() >= LANGUAGE_FROM_SECS * 16_000 {
            if let Some(code) = whisper_rs::get_lang_str(run.state.full_lang_id_from_state()) {
                run.language = code.to_string();
            }
        }
        let mut out = Vec::new();
        for segment in run.state.as_iter() {
            let text = segment.to_str_lossy().map_err(|e| format!("segment text: {e:?}"))?.trim().to_string();
            if !text.is_empty() {
                // Whisper counts in centiseconds.
                let at = |cs: i64| offset_ms + cs.max(0) as u64 * 10;
                out.push(Segment { start_ms: at(segment.start_timestamp()), end_ms: at(segment.end_timestamp()), text, speaker: None });
            }
        }
        Ok(out)
    }
}

/// Whisper language code of an English name as `transcribe` returns it
/// ("German" -> "de").
pub fn language_code(name: &str) -> Option<String> {
    let name = name.trim().to_lowercase();
    if name.is_empty() || name.contains('\0') {
        return None;
    }
    whisper_rs::get_lang_id(&name).and_then(whisper_rs::get_lang_str).map(str::to_string)
}

/// English name of a Whisper language code ("de" -> "German"); `None` for
/// "auto", empty or unknown codes.
pub fn language_name(code: &str) -> Option<String> {
    let code = code.trim();
    if code.is_empty() || code == "auto" || code.contains('\0') {
        return None;
    }
    whisper_rs::get_lang_id(code)
        .and_then(whisper_rs::get_lang_str_full)
        .map(capitalize)
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

fn load_context(model_path: &Path, backend: &ActiveBackend, pref: Option<bool>) -> Result<WhisperContext, String> {
    let flash_attn = match backend {
        ActiveBackend::Gpu(dev) => flash_attn_enabled(dev.api, pref),
        ActiveBackend::Cpu => false,
    };
    load_context_with(model_path, backend, flash_attn)
}

fn load_context_with(model_path: &Path, backend: &ActiveBackend, flash_attn: bool) -> Result<WhisperContext, String> {
    let mut params = WhisperContextParameters::default();
    match backend {
        ActiveBackend::Gpu(dev) => {
            params.use_gpu = true;
            params.gpu_device = dev.gpu_index;
            params.flash_attn = flash_attn;
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

/// For the PC check: a model on `backend` with flash attention as given,
/// warmed up, next to the engine's own.
pub fn load_for_check(
    model_path: &Path,
    backend: &ActiveBackend,
    flash_attn: bool,
) -> Result<(WhisperContext, WhisperState), String> {
    let ctx = load_context_with(model_path, backend, flash_attn)?;
    let mut state = new_state(&ctx)?;
    warm_up(&mut state);
    Ok((ctx, state))
}

/// For the PC check: one transcription like a dictation, in milliseconds.
pub fn timed_run(state: &mut WhisperState, samples: &[f32], language: &str) -> Result<u128, String> {
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some(language));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_temperature(0.0);
    params.set_no_context(true);
    params.set_n_threads(cpu_thread_count());
    let started = std::time::Instant::now();
    state.full(params, samples).map_err(|e| format!("whisper full() failed: {e:?}"))?;
    Ok(started.elapsed().as_millis())
}

/// One short run right after loading, so the GPU sets up its pipelines for
/// this model now and not in the first dictation (Large v3 Turbo q8 on an
/// RX 6800: 535 ms for the first dictation, 272 ms after). A second of
/// silence with a short prompt runs the encoder and both decoder shapes a
/// dictation uses; its text is dropped.
pub fn warm_up(state: &mut WhisperState) {
    let started = std::time::Instant::now();
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_temperature(0.0);
    params.set_no_context(true);
    params.set_n_threads(cpu_thread_count());
    params.set_initial_prompt("GitHub, Tauri, whisper.cpp, Vulkan, RudariFlow, dictation");
    let silence = vec![0.0f32; 16_000];
    match state.full(params, &silence) {
        Ok(()) => crate::startup_log::log(&format!("[engine] warm-up run in {} ms", started.elapsed().as_millis())),
        Err(e) => crate::startup_log::log(&format!("[engine] warm-up run failed: {e:?}")),
    }
}

fn new_state(ctx: &WhisperContext) -> Result<WhisperState, String> {
    ctx.create_state().map_err(|e| format!("create_state: {e:?}"))
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
    fn language_names_and_codes_round_trip() {
        assert_eq!(language_name("de").as_deref(), Some("German"));
        assert_eq!(language_code("German").as_deref(), Some("de"));
        assert_eq!(language_code("english").as_deref(), Some("en"));
        assert_eq!(language_code(""), None);
        assert_eq!(language_code("Klingon"), None);
    }

    fn dev(gpu_index: i32, api: GpuApi) -> GpuDevice {
        GpuDevice { gpu_index, api, name: format!("{api:?}{gpu_index}"), integrated: false, memory_mib: 8192 }
    }

    fn igpu(gpu_index: i32) -> GpuDevice {
        GpuDevice { integrated: true, memory_mib: 16384, ..dev(gpu_index, GpuApi::Vulkan) }
    }

    #[test]
    fn dedicated_card_goes_before_integrated_gpu() {
        // Vulkan lists the laptop's iGPU first and reports shared memory for it.
        let laptop = vec![igpu(0), dev(1, GpuApi::Vulkan)];
        assert_eq!(
            backend_candidates("auto", &laptop),
            vec![ActiveBackend::Gpu(dev(1, GpuApi::Vulkan)), ActiveBackend::Cpu]
        );
        assert_eq!(backend_candidates("vulkan", &laptop), vec![ActiveBackend::Gpu(dev(1, GpuApi::Vulkan))]);
        // Only an iGPU: it is still used.
        assert_eq!(backend_candidates("vulkan", &[igpu(0)]), vec![ActiveBackend::Gpu(igpu(0))]);
        // Two dedicated cards: the one with more memory.
        let big = GpuDevice { memory_mib: 16384, ..dev(1, GpuApi::Vulkan) };
        assert_eq!(
            backend_candidates("vulkan", &[dev(0, GpuApi::Vulkan), big.clone()]),
            vec![ActiveBackend::Gpu(big)]
        );
    }

    #[test]
    fn cuda_needs_turing_or_newer() {
        assert!(!cuda_cc_supported(Some((6, 1))), "GTX 10 series");
        assert!(!cuda_cc_supported(Some((7, 0))), "Titan V");
        assert!(cuda_cc_supported(Some((7, 5))), "GTX 16 / RTX 20");
        assert!(cuda_cc_supported(Some((12, 0))), "RTX 50");
        assert!(cuda_cc_supported(None), "unknown stays allowed");
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
        assert!(flash_attn_default(GpuApi::Cuda, None, None));
        assert!(!flash_attn_default(GpuApi::Vulkan, None, None));
        assert!(flash_attn_default(GpuApi::Vulkan, Some("1"), None));
        assert!(!flash_attn_default(GpuApi::Cuda, Some("0"), None));
        // The PC check's setting beats the per-API default, the env var beats both.
        assert!(flash_attn_default(GpuApi::Vulkan, None, Some(true)));
        assert!(!flash_attn_default(GpuApi::Cuda, None, Some(false)));
        assert!(!flash_attn_default(GpuApi::Vulkan, Some("0"), Some(true)));
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
        assert_eq!(model_filename("large-v3-turbo-q8_0"), "ggml-large-v3-turbo-q8_0.bin");
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

    #[test]
    fn segments_serialize_camel_case_and_omit_a_missing_speaker() {
        use serde_json;

        // speaker: None is omitted from JSON
        let seg_no_speaker = Segment {
            start_ms: 1000,
            end_ms: 2000,
            text: "Hi".to_string(),
            speaker: None,
        };
        let json = serde_json::to_string(&seg_no_speaker).expect("serialize");
        assert_eq!(json, r#"{"startMs":1000,"endMs":2000,"text":"Hi"}"#);
        assert!(!json.contains("speaker"));

        // speaker: Some(1) is included in JSON
        let seg_with_speaker = Segment {
            start_ms: 1000,
            end_ms: 2000,
            text: "Hi".to_string(),
            speaker: Some(1),
        };
        let json = serde_json::to_string(&seg_with_speaker).expect("serialize");
        assert!(json.contains("\"speaker\":1"));

        // Deserializing without speaker field gives speaker: None
        let seg_from_json: Segment =
            serde_json::from_str(r#"{"startMs":1000,"endMs":2000,"text":"Hi"}"#).expect("deserialize");
        assert_eq!(seg_from_json.speaker, None);
        assert_eq!(seg_from_json.start_ms, 1000);
        assert_eq!(seg_from_json.end_ms, 2000);
        assert_eq!(seg_from_json.text, "Hi");
    }
}
