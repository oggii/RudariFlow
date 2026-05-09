# RudariFlow Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-dictation `whisper-cli.exe` subprocess with in-process [`whisper-rs`](https://github.com/tazz4843/whisper-rs) bindings so the model loads once (lazily, on first dictation) and stays resident; stream segment text into the overlay during the post-stop inference pass.

**Architecture:** New `WhisperEngine` module owns a `Mutex<Option<LoadedModel>>`. Recorder captures audio as `Vec<f32>` at 16 kHz mono and calls `engine.transcribe(samples, …)` directly — no temp WAV on the local path. A `set_new_segment_callback` emits `partial-transcript` Tauri events to the overlay during inference. CUDA is a compile-time feature on `whisper-rs`; runtime GPU/CPU selection is via `WhisperContextParameters::use_gpu(bool)`. CUDA runtime DLLs ship in `binaries/cuda-runtime/`; `SetDllDirectoryW` is called at app startup so they're loadable. The subprocess path (`transcribe_local.rs`, `binaries/whisper-cuda/`, `binaries/whisper-cpu/`) is deleted in the same branch — no parallel implementation.

**Tech Stack:** Rust (Tauri 2 backend), `whisper-rs = "0.16"` with `cuda` feature, vanilla TypeScript (overlay frontend), Tauri events for streaming, `cpal` (audio capture, unchanged), `enigo` (paste, unchanged), `arboard` (clipboard, unchanged).

**Spec:** [`docs/superpowers/specs/2026-05-08-rudariflow-phase-b-design.md`](../specs/2026-05-08-rudariflow-phase-b-design.md)

---

## Setup (before Task 1)

Create an isolated worktree for this branch using the `superpowers:using-git-worktrees` skill. All Phase B work happens on a single feature branch (`feature/phase-b-whisper-rs`); no parallel implementation flag, no per-task branches. Frequent commits within the branch.

Confirm prerequisites are present **on the build machine**:

- CUDA Toolkit 12.x installed and `nvcc --version` succeeds (required by `whisper-rs` `cuda` feature at compile time)
- `cargo --version` ≥ 1.75
- The user's existing setup (`npm install`, `scripts/setup-whisper.ps1` having previously run)

If CUDA Toolkit is missing on the build machine, stop and surface this — Phase B compilation cannot proceed without it.

---

## Task 1: Spike — validate `whisper-rs` single-installer feasibility

**Purpose:** Before locking in the architecture, prove that a `cuda`-feature `whisper-rs` binary (a) compiles on this machine, (b) runs with `use_gpu=true` on the user's NVIDIA GPU, and (c) runs with `use_gpu=false` and survives missing-NVIDIA conditions. This is the gate from the spec — if it fails, fall back to the two-installer build matrix.

**Files:**
- Create: `src-tauri/examples/spike.rs`
- Modify: `src-tauri/Cargo.toml` (add `whisper-rs` dependency, add `[[example]]` entry)
- Use: any existing `ggml-tiny.bin` model in `%APPDATA%\com.rudariflow.app\` (or download via the app's existing download flow first)
- Use: `src-tauri/tests/fixtures/spike-3s.wav` — provide a 3-second mono 16-bit 16 kHz WAV of clear English speech (you can record one with Audacity or use any CC-licensed sample)

- [ ] **Step 1: Add the dependency**

Edit `src-tauri/Cargo.toml`. Append to the `[dependencies]` block:

```toml
whisper-rs = { version = "0.16", features = ["cuda"] }
```

And append at the end of the file:

```toml
[[example]]
name = "spike"
path = "examples/spike.rs"
```

- [ ] **Step 2: Confirm it compiles**

Run: `cd src-tauri && cargo build --example spike --release`
Expected: clean build, possibly with warnings about unused imports (we haven't written the example yet, but `cargo build --example spike` won't run until `examples/spike.rs` exists; so create the file first with `fn main() {}` then re-run).

If `cargo build` fails with CUDA errors (`nvcc not found`, `missing cublas`, etc.), stop. The CUDA Toolkit isn't visible to the build. Investigate `CUDA_PATH` and `PATH` before continuing.

- [ ] **Step 3: Provide the test fixture**

Place a 3-second mono 16-bit 16 kHz WAV at `src-tauri/tests/fixtures/spike-3s.wav`. Content: any clear English speech sentence. Add this file to git.

- [ ] **Step 4: Write the spike**

Create `src-tauri/examples/spike.rs`:

```rust
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

    let n = state.full_n_segments().map_err(|e| format!("n_segments: {e:?}"))?;
    let mut out = String::new();
    for i in 0..n {
        let s = state
            .full_get_segment_text(i)
            .map_err(|e| format!("segment {i}: {e:?}"))?;
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
```

The example takes `hound` from the existing dependency tree — no new deps needed.

- [ ] **Step 5: Run the spike on the CUDA box**

```powershell
cd src-tauri
cargo run --example spike --release -- "$env:APPDATA\com.rudariflow.app\ggml-tiny.bin" tests/fixtures/spike-3s.wav
```

Expected output (text content varies by fixture):
```
=== Phase B spike ===
model: ".../ggml-tiny.bin"
wav:   "tests/fixtures/spike-3s.wav" (48000 samples)

[1] use_gpu=true
  OK: "the quick brown fox..."

[2] use_gpu=false
  OK: "the quick brown fox..."
```

If `[1]` fails on the CUDA box: investigate before proceeding. If `[2]` also fails on the CUDA box (CPU fallback broken): stop and re-design.

- [ ] **Step 6: Simulate a non-NVIDIA machine**

On the same CUDA box, set `CUDA_VISIBLE_DEVICES=""` and re-run:

```powershell
$env:CUDA_VISIBLE_DEVICES = ""
cargo run --example spike --release -- "$env:APPDATA\com.rudariflow.app\ggml-tiny.bin" tests/fixtures/spike-3s.wav
Remove-Item Env:\CUDA_VISIBLE_DEVICES
```

Expected: `[1] use_gpu=true` either fails cleanly with an error string OR silently falls back (depends on whisper.cpp behavior). `[2] use_gpu=false` MUST succeed.

If `[2]` fails when the GPU is invisible: the contingency triggers. Stop and switch to two-installer build matrix (out of scope of this plan; surface to user).

- [ ] **Step 7: Append spike result to the spec**

Edit `docs/superpowers/specs/2026-05-08-rudariflow-phase-b-design.md`. Append to the "Baseline measurements" section:

```markdown
## Spike result (Task 1)

- Build: succeeded with `whisper-rs 0.16` `cuda` feature on Windows + CUDA 12.x.
- `use_gpu=true` on RTX [N]: succeeded, output: "<text>".
- `use_gpu=false` on RTX [N]: succeeded, output: "<text>".
- `use_gpu=true` with `CUDA_VISIBLE_DEVICES=""`: <result>.
- `use_gpu=false` with `CUDA_VISIBLE_DEVICES=""`: succeeded.

Conclusion: single-installer auto-detect is feasible; proceed with Task 2.
```

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/examples/spike.rs src-tauri/tests/fixtures/spike-3s.wav docs/superpowers/specs/2026-05-08-rudariflow-phase-b-design.md
git commit -m "feat(spike): validate whisper-rs single-installer feasibility"
```

---

## Task 2: `whisper_engine.rs` skeleton with pure-function unit tests

**Purpose:** Stand up the new module with the parts that don't need a real model loaded. TDD-friendly: param construction, thread clamping, GPU resolution decision are all pure.

**Files:**
- Create: `src-tauri/src/whisper_engine.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod whisper_engine;`)
- Test: same file (`#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing tests for pure helpers**

Create `src-tauri/src/whisper_engine.rs`:

```rust
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
```

- [ ] **Step 2: Wire the module into `lib.rs`**

Edit `src-tauri/src/lib.rs`. Add after `pub mod transcribe_local;`:

```rust
pub mod whisper_engine;
```

(Note: `transcribe_local` is still imported here — it's deleted in Task 10.)

- [ ] **Step 3: Run the tests**

Run: `cd src-tauri && cargo test --lib whisper_engine -- --nocapture`
Expected: 11 passed.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/whisper_engine.rs src-tauri/src/lib.rs
git commit -m "feat(whisper-engine): add pure-function helpers and module skeleton"
```

---

## Task 3: `WhisperEngine` struct with `ensure_loaded` and `transcribe`

**Purpose:** The substantive engine code. Lazy-load model with GPU fallback, run inference, return the final text. No streaming callback yet (Task 7 adds that). Single-flight via the engine's mutex.

**Files:**
- Modify: `src-tauri/src/whisper_engine.rs`
- Test: integration test gated `#[ignore]` in same file

- [ ] **Step 1: Add the engine struct and load logic**

Append to `src-tauri/src/whisper_engine.rs` (above the `#[cfg(test)]` block):

```rust
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
            let want_gpu = try_gpu_first; // tentative — we may have fallen back previously
            // If the cached entry already matches what we'd request, keep it.
            if existing.key.model_path == model_path
                && (existing.key.use_gpu == want_gpu || !allow_fallback)
            {
                return Ok(existing.key.use_gpu);
            }
            // Otherwise, drop and reload.
            state.loaded = None;
        }

        // Attempt requested mode.
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
    let n = state
        .full_n_segments()
        .map_err(|e| format!("full_n_segments: {e:?}"))?;
    let mut out = String::new();
    for i in 0..n {
        let s = state
            .full_get_segment_text(i)
            .map_err(|e| format!("segment {i}: {e:?}"))?;
        out.push_str(&s);
    }
    Ok(out.trim().to_string())
}
```

- [ ] **Step 2: Add a gated integration test**

Append inside the existing `#[cfg(test)] mod tests { ... }` block, after the existing tests:

```rust
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
```

- [ ] **Step 3: Run the unit tests (the integration test is `#[ignore]`'d)**

Run: `cd src-tauri && cargo test --lib whisper_engine`
Expected: 11 passed; 1 ignored.

- [ ] **Step 4: Run the integration test manually**

Run:
```powershell
cd src-tauri
cargo test --lib whisper_engine::tests::integration_tiny_transcribe --release -- --ignored --nocapture
```
Expected: prints `ensure_loaded chose use_gpu=true` (assuming CUDA box) and `transcribed: "<text>"`. Test passes.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/whisper_engine.rs
git commit -m "feat(whisper-engine): add WhisperEngine with lazy load and transcribe"
```

---

## Task 4: Audio refactor — split `stop_and_save` into samples + WAV writer

**Purpose:** The local path needs `Vec<f32>` at 16 kHz mono; the Groq path still needs a WAV file. Split the existing method so both callers use the same trim-resample logic without writing a temp WAV when not needed.

**Files:**
- Modify: `src-tauri/src/audio.rs`
- Test: same file

- [ ] **Step 1: Write the failing test for `samples_to_wav`**

Add to the existing `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/audio.rs`:

```rust
    #[test]
    fn samples_to_wav_roundtrips() {
        let dir = std::env::temp_dir().join("rudariflow_samples_to_wav_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.wav");

        let samples: Vec<f32> = (0..16_000).map(|i| (i as f32 / 16_000.0) * 0.5).collect();
        samples_to_wav(&samples, &path).expect("write wav");

        let mut reader = hound::WavReader::open(&path).expect("open written wav");
        let spec = reader.spec();
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, 16_000);
        assert_eq!(spec.bits_per_sample, 16);
        let count = reader.samples::<i16>().count();
        assert_eq!(count, samples.len());

        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib audio::tests::samples_to_wav_roundtrips`
Expected: FAIL — `samples_to_wav` not defined.

- [ ] **Step 3: Add `samples_to_wav` and split `stop_and_save`**

Edit `src-tauri/src/audio.rs`. Replace the existing `stop_and_save` method body (lines 137–196) with the following two-method version, and add `samples_to_wav` as a free function below the `impl` block:

```rust
    /// Stop the stream, dedup channels to mono, trim leading/trailing silence,
    /// and resample to 16 kHz. Returns the prepared sample buffer or
    /// `Err("no_speech")` if the entire recording was silence.
    pub fn stop_and_take_samples(&mut self) -> Result<Vec<f32>, String> {
        self.stream = None;
        println!("[RudariFlow] Audio recording stopped");

        let samples = self.samples.lock().unwrap();
        if samples.is_empty() {
            return Err("No audio captured".to_string());
        }
        println!("[RudariFlow] Captured {} raw samples", samples.len());

        let mono: Vec<f32> = if self.source_channels > 1 {
            samples
                .chunks(self.source_channels as usize)
                .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
                .collect()
        } else {
            samples.clone()
        };
        drop(samples);
        self.samples.lock().unwrap().clear();

        let trimmed: Vec<f32> = match trim_silence(&mono, self.source_sample_rate) {
            Some((start, end)) => mono[start..end].to_vec(),
            None => {
                println!("[RudariFlow] trim_silence: no speech detected");
                return Err("no_speech".to_string());
            }
        };
        println!(
            "[RudariFlow] Trimmed {} -> {} samples ({:.1}% kept)",
            mono.len(),
            trimmed.len(),
            100.0 * trimmed.len() as f32 / mono.len() as f32
        );

        let resampled = resample(&trimmed, self.source_sample_rate, 16_000);
        println!("[RudariFlow] Resampled to {} samples at 16kHz", resampled.len());
        Ok(resampled)
    }

    /// Stop the stream and write a 16 kHz mono 16-bit WAV. Used by the Groq
    /// path which uploads a WAV file. Wraps `stop_and_take_samples`.
    pub fn stop_and_save(&mut self, output_path: &PathBuf) -> Result<PathBuf, String> {
        let samples = self.stop_and_take_samples()?;
        samples_to_wav(&samples, output_path)?;
        Ok(output_path.clone())
    }
}

/// Write a `Vec<f32>` of 16 kHz mono samples as a 16-bit PCM WAV.
pub fn samples_to_wav(samples: &[f32], output_path: &PathBuf) -> Result<PathBuf, String> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = WavWriter::create(output_path, spec).map_err(|e| e.to_string())?;
    for &sample in samples {
        let amplitude = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer.write_sample(amplitude).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    println!("[RudariFlow] WAV saved to {:?}", output_path);
    Ok(output_path.clone())
}
```

Note the closing `}` belongs to the `impl AudioRecorder` — `samples_to_wav` is a free function outside the impl.

- [ ] **Step 4: Run all audio tests**

Run: `cd src-tauri && cargo test --lib audio`
Expected: previous tests still pass + new `samples_to_wav_roundtrips` passes.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/audio.rs
git commit -m "refactor(audio): split stop_and_save into samples + WAV writer"
```

---

## Task 5: Bundle CUDA runtime DLLs and call `SetDllDirectoryW` at startup

**Purpose:** Without this, when `whisper-rs`' CUDA backend tries to load `cudart64_12.dll` etc. at first GPU init, Windows can't find them. We move the existing CUDA runtime DLLs into a known subdir and add the search path at process start. Land this *before* wiring the recorder to the engine so end-to-end smoke tests work.

**Files:**
- Move: `binaries/whisper-cuda/cudart64_12.dll` → `binaries/cuda-runtime/cudart64_12.dll`
- Move: `binaries/whisper-cuda/cublas64_12.dll` → `binaries/cuda-runtime/cublas64_12.dll`
- Move: `binaries/whisper-cuda/cublasLt64_12.dll` → `binaries/cuda-runtime/cublasLt64_12.dll`
- Move: `binaries/whisper-cuda/nvrtc64_120_0.dll` → `binaries/cuda-runtime/nvrtc64_120_0.dll`
- Move: `binaries/whisper-cuda/nvrtc-builtins64_124.dll` → `binaries/cuda-runtime/nvrtc-builtins64_124.dll`
- Modify: `src-tauri/tauri.conf.json` (add 5 new resource entries; do NOT yet remove the old whisper-cuda/whisper-cpu allowlist — that happens in Task 10 when we delete the subprocess code path)
- Modify: `src-tauri/src/main.rs` (add startup hook)

- [ ] **Step 1: Move the DLLs**

```powershell
New-Item -ItemType Directory -Path src-tauri\binaries\cuda-runtime -Force | Out-Null
Move-Item -Force src-tauri\binaries\whisper-cuda\cudart64_12.dll       src-tauri\binaries\cuda-runtime\
Move-Item -Force src-tauri\binaries\whisper-cuda\cublas64_12.dll       src-tauri\binaries\cuda-runtime\
Move-Item -Force src-tauri\binaries\whisper-cuda\cublasLt64_12.dll     src-tauri\binaries\cuda-runtime\
Move-Item -Force src-tauri\binaries\whisper-cuda\nvrtc64_120_0.dll     src-tauri\binaries\cuda-runtime\
Move-Item -Force src-tauri\binaries\whisper-cuda\nvrtc-builtins64_124.dll src-tauri\binaries\cuda-runtime\
```

- [ ] **Step 2: Update the resource allowlist**

Edit `src-tauri/tauri.conf.json`. In the `bundle.resources` array, **replace** the five `binaries/whisper-cuda/cudart...|cublas...|nvrtc...` entries with the equivalent `binaries/cuda-runtime/...` entries. Final resources block:

```json
    "resources": [
      "binaries/whisper-cpu/whisper-cli.exe",
      "binaries/whisper-cpu/whisper.dll",
      "binaries/whisper-cpu/ggml.dll",
      "binaries/whisper-cpu/ggml-base.dll",
      "binaries/whisper-cpu/ggml-cpu.dll",
      "binaries/whisper-cuda/whisper-cli.exe",
      "binaries/whisper-cuda/whisper.dll",
      "binaries/whisper-cuda/ggml.dll",
      "binaries/whisper-cuda/ggml-base.dll",
      "binaries/whisper-cuda/ggml-cpu.dll",
      "binaries/whisper-cuda/ggml-cuda.dll",
      "binaries/cuda-runtime/cudart64_12.dll",
      "binaries/cuda-runtime/cublas64_12.dll",
      "binaries/cuda-runtime/cublasLt64_12.dll",
      "binaries/cuda-runtime/nvrtc64_120_0.dll",
      "binaries/cuda-runtime/nvrtc-builtins64_124.dll"
    ],
```

The `whisper-cpu/*` and remaining `whisper-cuda/*` entries are deleted in Task 10 along with the subprocess code.

- [ ] **Step 3: Add the Windows-only DLL search path hook**

Edit `src-tauri/src/main.rs`. At the top of `setup(|app| { ... })`, immediately after `startup_log::log("setup() entered");`, add:

```rust
            // Add the bundled CUDA runtime DLLs to the Windows DLL search path
            // so whisper-rs (cuda feature) can load cudart, cublas, etc.
            #[cfg(windows)]
            {
                if let Ok(rd) = app.path().resource_dir() {
                    let cuda_dir = rd.join("binaries").join("cuda-runtime");
                    if cuda_dir.exists() {
                        use std::os::windows::ffi::OsStrExt;
                        use std::ffi::OsStr;
                        let wide: Vec<u16> = OsStr::new(&cuda_dir)
                            .encode_wide()
                            .chain(std::iter::once(0))
                            .collect();
                        // SAFETY: we pass a valid null-terminated UTF-16 path.
                        // SetDllDirectoryW returns nonzero on success; on failure
                        // we log and continue (CPU path may still work).
                        let ok = unsafe {
                            windows_sys::Win32::System::LibraryLoader::SetDllDirectoryW(wide.as_ptr())
                        };
                        if ok == 0 {
                            startup_log::log("SetDllDirectoryW failed");
                        } else {
                            startup_log::log(&format!(
                                "SetDllDirectoryW set to {:?}",
                                cuda_dir
                            ));
                        }
                    } else {
                        startup_log::log(&format!(
                            "cuda-runtime dir not found at {:?}",
                            cuda_dir
                        ));
                    }
                }
            }
```

- [ ] **Step 4: Add the `windows-sys` dependency**

Edit `src-tauri/Cargo.toml`. In `[dependencies]`, append:

```toml
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "0.59", features = ["Win32_System_LibraryLoader"] }
```

- [ ] **Step 5: Build and run dev**

Run: `cd src-tauri && cargo build`
Expected: clean build.

Run: `npm run tauri dev` (from project root).
Expected: app starts; `startup.log` (in `%APPDATA%\com.rudariflow.app\`) contains either `SetDllDirectoryW set to ...` or `cuda-runtime dir not found...` (in dev mode the resource path may differ — that's OK, the production build is what matters).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/binaries/cuda-runtime/ src-tauri/tauri.conf.json src-tauri/src/main.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(bundle): move CUDA runtime DLLs and SetDllDirectoryW at startup"
```

(`binaries/whisper-cuda/cudart...` etc. are now physically moved; the old paths no longer exist and the working tree should reflect that.)

---

## Task 6: Wire `WhisperEngine` into the recorder for the local path

**Purpose:** The recorder now calls `engine.transcribe(samples, ...)` directly for `engine == "local"`. The Groq path is unchanged. Manual smoke test should produce a working end-to-end dictation after this task lands. The temp WAV is no longer written on the local path.

**Files:**
- Modify: `src-tauri/src/main.rs` (register `Arc<WhisperEngine>` in managed state, pass to recorder calls)
- Modify: `src-tauri/src/recorder.rs` (replace `transcribe_local::transcribe_local` call site, add engine param)

- [ ] **Step 1: Register the engine in Tauri managed state**

Edit `src-tauri/src/main.rs`.

At the top of imports, add:

```rust
use std::sync::Arc;
use rudariflow_lib::whisper_engine::WhisperEngine;
```

Modify the `AppState` struct:

```rust
struct AppState {
    recorder: Recorder,
    settings: Mutex<Settings>,
    app_dir: PathBuf,
    whisper_engine: Arc<WhisperEngine>,
}
```

In `main()`, modify the `.manage(...)` call:

```rust
        .manage(AppState {
            recorder: Recorder::new(),
            settings: Mutex::new(settings),
            app_dir,
            whisper_engine: Arc::new(WhisperEngine::new()),
        })
```

- [ ] **Step 2: Plumb the engine to `stop_and_transcribe`**

Edit `src-tauri/src/recorder.rs`.

Add at the top:

```rust
use crate::whisper_engine::WhisperEngine;
use std::sync::Arc;
```

Change `stop_and_transcribe` and `run_transcription_pipeline` signatures to take `engine: &Arc<WhisperEngine>`:

```rust
    pub async fn stop_and_transcribe(
        &self,
        app: &AppHandle,
        settings: &Settings,
        app_dir: &PathBuf,
        engine: &Arc<WhisperEngine>,
    ) -> Result<String, String> {
```

```rust
    async fn run_transcription_pipeline(
        &self,
        app: &AppHandle,
        settings: &Settings,
        app_dir: &PathBuf,
        engine: &Arc<WhisperEngine>,
    ) -> Result<String, String> {
```

Forward the engine argument from `stop_and_transcribe` into `run_transcription_pipeline`:

```rust
        let result = self
            .run_transcription_pipeline(app, settings, app_dir, engine)
            .await;
```

- [ ] **Step 3: Replace the local transcription call site**

In `run_transcription_pipeline`, the existing block reads:

```rust
        let temp_path = app_dir.join("temp_recording.wav");

        let save_result = {
            let mut recorder = self.audio_recorder.lock().unwrap();
            recorder.stop_and_save(&temp_path)
        };

        if let Err(e) = &save_result {
            if e == "no_speech" {
                /* ... overlay show + audio-empty event + spawn hide ... */
                return Ok(String::new());
            }
        }
        save_result?;

        let raw_text = match settings.engine.as_str() {
            "local" => {
                let model_path = app_dir.join(transcribe_local::model_filename(&settings.whisper_model));
                transcribe_local::transcribe_local(
                    app,
                    &model_path,
                    &temp_path,
                    &settings.gpu_backend,
                    &settings.language,
                    &settings.custom_prompt,
                ).await?
            }
            "cloud" => {
                transcribe_groq::transcribe_groq(
                    &settings.groq_api_key,
                    &temp_path,
                    &settings.language,
                    &settings.custom_prompt,
                ).await?
            }
            _ => return Err(format!("Unknown engine: {}", settings.engine)),
        };

        let _ = std::fs::remove_file(&temp_path);
```

Replace it with engine-specific sample handling — local takes raw `Vec<f32>`, cloud still writes a temp WAV:

```rust
        let raw_text = match settings.engine.as_str() {
            "local" => {
                // Local path: take samples, hand directly to in-process whisper.
                let samples_result = {
                    let mut recorder = self.audio_recorder.lock().unwrap();
                    recorder.stop_and_take_samples()
                };
                if let Err(e) = &samples_result {
                    if e == "no_speech" {
                        emit_audio_empty(app);
                        return Ok(String::new());
                    }
                }
                let samples = samples_result?;

                let model_path = app_dir
                    .join(crate::whisper_engine::model_filename(&settings.whisper_model));
                if !model_path.exists() {
                    return Err("Whisper model not found. Please download a model first.".to_string());
                }
                engine.ensure_loaded(&model_path, &settings.gpu_backend)?;
                engine.transcribe(&samples, &settings.language, &settings.custom_prompt)?
            }
            "cloud" => {
                // Cloud path: still uses a WAV file because Groq accepts uploads.
                let temp_path = app_dir.join("temp_recording.wav");
                let save_result = {
                    let mut recorder = self.audio_recorder.lock().unwrap();
                    recorder.stop_and_save(&temp_path)
                };
                if let Err(e) = &save_result {
                    if e == "no_speech" {
                        emit_audio_empty(app);
                        return Ok(String::new());
                    }
                }
                save_result?;
                let text = transcribe_groq::transcribe_groq(
                    &settings.groq_api_key,
                    &temp_path,
                    &settings.language,
                    &settings.custom_prompt,
                )
                .await?;
                let _ = std::fs::remove_file(&temp_path);
                text
            }
            _ => return Err(format!("Unknown engine: {}", settings.engine)),
        };
```

Then at the top of the file (above `pub struct Recorder`), extract the `audio-empty` flow into a helper so both engine branches share it:

```rust
fn emit_audio_empty(app: &AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.set_always_on_top(false);
        let _ = overlay.set_always_on_top(true);
        let _ = overlay.show();
    }
    let _ = app.emit("audio-empty", ());
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1700)).await;
        if let Some(overlay) = app_clone.get_webview_window("overlay") {
            let _ = overlay.hide();
        }
    });
}
```

Remove the now-dead `if let Err(e) = &save_result { if e == "no_speech" { ... } }` block that previously sat between `save_result` and `let raw_text = match ...`. The new structure handles `no_speech` per branch and the helper centralizes the overlay/event logic.

- [ ] **Step 4: Update the call sites in `main.rs`**

Edit `src-tauri/src/main.rs`. Update both call sites of `stop_and_transcribe` (one in `do_toggle_recording`, one in the hotkey released branch):

In `do_toggle_recording`:

```rust
        RecordingState::Recording => {
            let settings = state.settings.lock().unwrap().clone();
            let result = state
                .recorder
                .stop_and_transcribe(app, &settings, &state.app_dir, &state.whisper_engine)
                .await?;
            Ok(result)
        }
```

In `register_hotkey` (the `ShortcutState::Released` branch):

```rust
                                match state
                                    .recorder
                                    .stop_and_transcribe(
                                        &handle,
                                        &settings,
                                        &state.app_dir,
                                        &state.whisper_engine,
                                    )
                                    .await
```

- [ ] **Step 5: Build**

Run: `cd src-tauri && cargo build`
Expected: clean build. The subprocess code in `transcribe_local.rs` is still present and still compiled in (Task 10 deletes it) — it's just no longer called from `recorder.rs`.

- [ ] **Step 6: Run all tests**

Run: `cd src-tauri && cargo test --lib`
Expected: all tests pass (subprocess tests in `transcribe_local::tests` still pass since the module is still there; new engine tests pass; recorder tests pass).

- [ ] **Step 7: Manual smoke test**

Run: `npm run tauri dev` from project root. Press the hotkey, dictate a short sentence, release.

Expected: text gets pasted exactly as before (no streaming yet — that's Task 7).

If transcription fails with a CUDA-related error, check `startup.log` for the `SetDllDirectoryW` line from Task 5.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/main.rs src-tauri/src/recorder.rs
git commit -m "feat(recorder): wire WhisperEngine for local-path transcription"
```

---

## Task 7: Stream segment text to the overlay via `partial-transcript` events

**Purpose:** Hook `set_new_segment_callback` so each segment whisper emits during inference fires a Tauri event. The overlay renders the cumulative text in a new element. On final, fire one more event with `is_final: true`.

**Files:**
- Modify: `src-tauri/src/whisper_engine.rs` (add a streaming variant of `transcribe`)
- Modify: `src-tauri/src/recorder.rs` (call the streaming variant)
- Modify: `src/overlay.html` (add a `.transcript` element and event listener)
- Modify: `src/i18n.ts` (add `transcribing_message` keys)

- [ ] **Step 1: Extend `transcribe` to take an `AppHandle` and emit events**

Edit `src-tauri/src/whisper_engine.rs`. Replace the existing `pub fn transcribe` with a version that takes a Tauri `AppHandle` and emits per-segment events:

```rust
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, serde::Serialize)]
pub struct PartialTranscript {
    pub text: String,
    pub is_final: bool,
}

impl WhisperEngine {
    pub fn transcribe(
        &self,
        app: &AppHandle,
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

        // Per-segment callback: emit cumulative text to the overlay.
        let app_for_cb = app.clone();
        params.set_new_segment_callback_safe(move |seg: whisper_rs::SegmentCallbackData| {
            let payload = PartialTranscript {
                text: seg.text.trim().to_string(),
                is_final: false,
            };
            // Emit only to the overlay window — main window doesn't need this.
            if let Some(overlay) = app_for_cb.get_webview_window("overlay") {
                let _ = overlay.emit("partial-transcript", payload);
            }
        });

        wstate
            .full(params, samples)
            .map_err(|e| format!("whisper full() failed: {e:?}"))?;

        let text = collect_segments(&wstate)?;

        // Final event so the overlay knows to stop accumulating.
        if let Some(overlay) = app.get_webview_window("overlay") {
            let _ = overlay.emit(
                "partial-transcript",
                PartialTranscript {
                    text: text.clone(),
                    is_final: true,
                },
            );
        }

        Ok(text)
    }
}
```

Note: `set_new_segment_callback_safe` is whisper-rs's safe wrapper. The `SegmentCallbackData` struct has `.text: String` (the new segment's text only — not cumulative). The overlay accumulates on its side, see Step 4.

If `whisper-rs 0.16` exposes the callback API under a slightly different name (`set_segment_callback_safe`, `set_new_segment_callback`, etc.) — pick the one that takes an owned closure receiving `SegmentCallbackData` and adjust accordingly. Run `cargo doc --open --package whisper-rs` to confirm.

- [ ] **Step 2: Update the integration test for the new signature**

In `src-tauri/src/whisper_engine.rs`, update the integration test to skip when no `AppHandle` is available — or refactor to construct one. Simplest: gate the test with a comment that it now needs to be exercised end-to-end via the running app.

Replace the existing `integration_tiny_transcribe` test body with:

```rust
    #[test]
    #[ignore = "integration test now requires a Tauri AppHandle; exercise via npm run tauri dev"]
    fn integration_tiny_transcribe() {
        // Streaming transcribe takes &AppHandle which is impractical to
        // construct in a unit test. End-to-end coverage moved to manual
        // smoke testing of the running app.
    }
```

The pure-function tests still cover the deterministic logic; whisper-rs and Tauri event delivery are exercised manually.

- [ ] **Step 3: Update the recorder call site**

Edit `src-tauri/src/recorder.rs`. Update the local-engine branch:

```rust
                engine.ensure_loaded(&model_path, &settings.gpu_backend)?;
                engine.transcribe(app, &samples, &settings.language, &settings.custom_prompt)?
```

(One new arg: `app`.)

- [ ] **Step 4: Add transcript element and listener to the overlay**

Edit `src/overlay.html`.

In the `<style>` block, after the `.cancel:hover` rule and before `.notice`, add:

```css
      .transcript {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 18px;
        font-size: 12px;
        font-weight: 500;
        line-height: 1.3;
        color: rgba(255, 255, 255, 0.95);
        background: rgba(20, 20, 22, 0.92);
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        opacity: 0;
        pointer-events: none;
        text-overflow: ellipsis;
        overflow: hidden;
        white-space: nowrap;
        transition: opacity 120ms ease;
      }
      body[data-state="transcribing"] .transcript { opacity: 1; }
```

In the `<body>`, after the `<div class="notice" id="notice"></div>` line, add:

```html
    <div class="transcript" id="transcript"></div>
```

In the `<script>` block, after the existing `window.__overlayUpdate = ...` definition, add:

```javascript
      const transcriptEl = document.getElementById("transcript");
      let cumulative = "";
      listen("partial-transcript", (event) => {
        const p = event.payload || {};
        if (p.is_final) {
          // Final canonical text replaces whatever we accumulated.
          cumulative = String(p.text || "");
        } else {
          // New segment delta — append.
          const seg = String(p.text || "").trim();
          if (seg) cumulative = (cumulative + " " + seg).trim();
        }
        transcriptEl.textContent = cumulative;
      }).then(() => diag("partial-transcript listener registered"));
```

And inside `window.__overlayUpdate`, when `state === "recording"`, reset the cumulative text:

```javascript
        if (state === "recording") {
          levelEventCount = 0;
          cumulative = "";
          transcriptEl.textContent = "";
        }
```

The transcript only renders when `body[data-state="transcribing"]`, so during the recording phase it stays hidden. When state flips to `transcribing`, the element fades in and starts populating from `partial-transcript` events.

- [ ] **Step 5: Add the i18n key**

Edit `src/i18n.ts`. Add to both the EN and DE dictionaries:

```typescript
  // EN
  transcribing_message: "Transcribing…",
  // DE
  transcribing_message: "Wird transkribiert…",
```

(This key is reserved for a future placeholder; it's not actively used by the overlay yet because the segment callback typically fires first. Including it keeps the i18n file forward-compatible.)

- [ ] **Step 6: Build**

Run: `cd src-tauri && cargo build` — expect clean build.
Run: `npm run build` (from project root) — expect clean Vite build.

- [ ] **Step 7: Manual smoke test**

Run: `npm run tauri dev`. Dictate a 5–10 second sentence.

Expected: during the post-stop transcribing phase, partial text appears in the overlay pill, building up word-by-word until the full sentence is shown; then the cumulative final text is replaced with the cleaned text and the pill hides.

Edge case: if dictation is so fast that whisper emits one segment, you'll see the full text appear in one update — that's normal.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/whisper_engine.rs src-tauri/src/recorder.rs src/overlay.html src/i18n.ts
git commit -m "feat(streaming): emit partial-transcript per whisper segment"
```

---

## Task 8: Background warmup on hotkey press

**Purpose:** When the user presses the hotkey, audio capture starts AND the model load starts in parallel. By the time the user releases the hotkey (typically several seconds later), the model is warm and transcription begins immediately.

**Files:**
- Modify: `src-tauri/src/main.rs` (spawn `engine.ensure_loaded` on hotkey press)

- [ ] **Step 1: Spawn warmup on press**

Edit `src-tauri/src/main.rs`. In `register_hotkey`'s `ShortcutState::Pressed` branch, the existing logic spawns an async block. Inside that block, before the `match mode.as_str()` (so warmup starts regardless of `toggle` vs `push-to-talk`), add:

```rust
                    tauri::async_runtime::spawn(async move {
                        let state = handle.state::<AppState>();
                        // Background warmup: kick off model load in parallel
                        // with audio capture. Single-flight via the engine's
                        // mutex; ignores errors here — they surface at
                        // transcription time.
                        let s = state.settings.lock().unwrap().clone();
                        if s.engine == "local" {
                            let model_path = state
                                .app_dir
                                .join(rudariflow_lib::whisper_engine::model_filename(
                                    &s.whisper_model,
                                ));
                            if model_path.exists() {
                                let engine = state.whisper_engine.clone();
                                let backend = s.gpu_backend.clone();
                                tauri::async_runtime::spawn_blocking(move || {
                                    if let Err(e) = engine.ensure_loaded(&model_path, &backend) {
                                        eprintln!("[RudariFlow] warmup failed: {}", e);
                                    }
                                });
                            }
                        }

                        match mode.as_str() {
                            // ... existing toggle / push-to-talk logic unchanged ...
                        }
                    });
```

(The exact merge: keep the existing `match mode.as_str()` block intact; insert the warmup spawn above it inside the same `tauri::async_runtime::spawn(async move { ... })` closure.)

`spawn_blocking` is appropriate because `ensure_loaded` does synchronous file I/O and CUDA init.

- [ ] **Step 2: Build and run dev**

Run: `cd src-tauri && cargo build` — clean.
Run: `npm run tauri dev`.

Restart the app, press the hotkey for the *first* dictation, dictate a short sentence, release.

Expected: console / `startup.log` shows model load happening during recording (look for whisper-rs init messages). After release, transcription is faster than before because the model is already loaded.

Compare: kill the app, restart, immediately press-and-release the hotkey too fast to talk (just a tap). Expected: warmup has started; the subsequent transcription call still works correctly. The mutex ensures `transcribe` waits for the in-progress load to finish.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(warmup): preload whisper model on hotkey press"
```

---

## Task 9: Invalidate engine on settings change

**Purpose:** When the user picks a different model size or changes GPU backend in settings, the resident model must be dropped so the next dictation reloads.

**Files:**
- Modify: `src-tauri/src/main.rs` (extend `save_settings`)

- [ ] **Step 1: Update `save_settings` to detect engine-affecting changes**

Edit `src-tauri/src/main.rs`. Replace the existing `save_settings` with:

```rust
#[tauri::command]
fn save_settings(state: State<AppState>, settings: Settings) -> Result<(), String> {
    settings.save(&state.app_dir)?;
    let engine_invalidate = {
        let prev = state.settings.lock().unwrap();
        prev.gpu_backend != settings.gpu_backend
            || prev.whisper_model != settings.whisper_model
    };
    *state.settings.lock().unwrap() = settings;
    if engine_invalidate {
        state.whisper_engine.invalidate();
    }
    Ok(())
}
```

The old `transcribe_local::clear_backend_cache()` call disappears (the cache it cleared is in the soon-to-be-deleted `transcribe_local.rs`). It's replaced by `whisper_engine.invalidate()`.

- [ ] **Step 2: Manual test**

Run: `npm run tauri dev`. Dictate once (loads `large-v3-turbo` say). Open settings, change to `small`, save, dictate again.

Expected: second dictation triggers a model reload (look for whisper-rs init messages in the console).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(settings): invalidate engine on model or backend change"
```

---

## Task 10: Delete the subprocess code

**Purpose:** The subprocess path is dead. Remove it entirely (~280 LOC) along with the now-unused bundled binaries and resource entries.

**Files:**
- Delete: `src-tauri/src/transcribe_local.rs`
- Delete: `src-tauri/binaries/whisper-cuda/` (entire directory, except items already moved to cuda-runtime)
- Delete: `src-tauri/binaries/whisper-cpu/` (entire directory)
- Modify: `src-tauri/src/lib.rs` (remove `pub mod transcribe_local;`)
- Modify: `src-tauri/src/main.rs` (remove `transcribe_local` import; replace remaining call sites with `whisper_engine`)
- Modify: `src-tauri/tauri.conf.json` (remove the 11 subprocess-related resource entries)
- Modify: `scripts/setup-whisper.ps1` (no longer fetches the bundled CLI builds — see Step 6)
- Modify: `README.md` (drop the "Fetch whisper.cpp backends" step)

- [ ] **Step 1: Replace remaining `transcribe_local` references**

In `src-tauri/src/main.rs`, two `transcribe_local::model_filename` references remain (`check_model_downloaded` and `download_model`). Update them to `rudariflow_lib::whisper_engine::model_filename` and `rudariflow_lib::whisper_engine::model_download_url`:

```rust
#[tauri::command]
fn check_model_downloaded(state: State<AppState>, model_size: String) -> bool {
    let model_file = rudariflow_lib::whisper_engine::model_filename(&model_size);
    state.app_dir.join(&model_file).exists()
}

#[tauri::command]
async fn download_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    model_size: String,
) -> Result<(), String> {
    let url = rudariflow_lib::whisper_engine::model_download_url(&model_size);
    let model_file = rudariflow_lib::whisper_engine::model_filename(&model_size);
    let dest = state.app_dir.join(&model_file);
    downloader::download_model(app, &url, &dest).await
}
```

Also remove the `use rudariflow_lib::transcribe_local;` line at the top.

- [ ] **Step 2: Delete the module**

```powershell
Remove-Item -Force src-tauri\src\transcribe_local.rs
```

Edit `src-tauri/src/lib.rs`. Remove the line:

```rust
pub mod transcribe_local;
```

- [ ] **Step 3: Delete the bundled binaries**

```powershell
Remove-Item -Recurse -Force src-tauri\binaries\whisper-cuda
Remove-Item -Recurse -Force src-tauri\binaries\whisper-cpu
```

After this, only `src-tauri/binaries/cuda-runtime/` should exist under `binaries/`.

- [ ] **Step 4: Trim `tauri.conf.json`**

Edit `src-tauri/tauri.conf.json`. Remove all `binaries/whisper-cpu/*` and `binaries/whisper-cuda/*` resource entries. Final block:

```json
    "resources": [
      "binaries/cuda-runtime/cudart64_12.dll",
      "binaries/cuda-runtime/cublas64_12.dll",
      "binaries/cuda-runtime/cublasLt64_12.dll",
      "binaries/cuda-runtime/nvrtc64_120_0.dll",
      "binaries/cuda-runtime/nvrtc-builtins64_124.dll"
    ],
```

- [ ] **Step 5: Update `scripts/setup-whisper.ps1`**

The script currently downloads the prebuilt whisper.cpp CLI binaries. After Phase B those aren't needed; only the CUDA runtime DLLs are. Replace the script's body so it fetches just the runtime DLL set into `src-tauri/binaries/cuda-runtime/`. If the simplest path is to leave the script downloading the upstream CUDA bundle and just copy the five runtime DLLs out of it before deleting the rest, that's acceptable.

Open `scripts/setup-whisper.ps1`, read its current content, and rewrite so the post-condition is: `src-tauri/binaries/cuda-runtime/` contains exactly the five DLLs listed in `tauri.conf.json`. Keep the existing download URLs and verification steps; just change the destination layout.

If the script grows complex, it's fine to stop and ask — this is the one ambiguous step in the plan.

- [ ] **Step 6: Update the README**

Edit `README.md`. In the "Setup" section, the current step 3 reads:

```
# 3. Fetch whisper.cpp backends (cuBLAS + CPU, ~600 MB total)
powershell -ExecutionPolicy Bypass -File scripts/setup-whisper.ps1
```

Change it to:

```
# 3. Fetch CUDA runtime DLLs (~80 MB)
powershell -ExecutionPolicy Bypass -File scripts/setup-whisper.ps1
```

In the "Architecture" section, change:

```
- **Transcription:** whisper.cpp as an external sidecar process (`whisper-cli.exe`), bundled as a Tauri resource
```

to:

```
- **Transcription:** in-process [`whisper-rs`](https://github.com/tazz4843/whisper-rs) (whisper.cpp Rust bindings) with the `cuda` feature; runtime fallback to CPU
```

And add a new bullet to "Prerequisites":

```
- CUDA Toolkit 12.x (required to compile `whisper-rs` with the `cuda` feature)
```

Add a note in "System Requirements":

```
- **RAM:** the selected whisper model stays resident from first dictation onward. `large-v3-turbo` ≈ 1.6 GB, `small` ≈ 500 MB, `tiny` ≈ 80 MB.
```

- [ ] **Step 7: Build and test**

Run: `cd src-tauri && cargo build` — expect clean build.
Run: `cd src-tauri && cargo test --lib` — expect all tests pass.
Run: `npm run build` — expect clean.

- [ ] **Step 8: Manual smoke test**

Run: `npm run tauri dev`. Dictate a sentence. Verify it works.

- [ ] **Step 9: Commit**

```bash
git add -A
git status  # sanity check
git commit -m "chore: remove whisper-cli subprocess path"
```

(`-A` is justified here because we have many deletions across `binaries/`. Verify `git status` only shows expected adds/edits/deletes before committing.)

---

## Task 11: Fix the Task-11 race from Phase C review

**Purpose:** The Phase C reviewer flagged that the 1700 ms delayed overlay-hide in `emit_audio_empty` doesn't check recorder state — if the user starts a new recording within that window, the overlay disappears mid-recording. Fix by capturing recorder state into the spawned closure and skipping the hide when active.

**Files:**
- Modify: `src-tauri/src/recorder.rs`

- [ ] **Step 1: Pass recorder state into the spawned closure**

Edit `src-tauri/src/recorder.rs`. Update the `emit_audio_empty` helper from Task 6 to take the recorder state as an argument:

```rust
fn emit_audio_empty(app: &AppHandle, state: Arc<Mutex<RecordingState>>) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.set_always_on_top(false);
        let _ = overlay.set_always_on_top(true);
        let _ = overlay.show();
    }
    let _ = app.emit("audio-empty", ());
    let app_clone = app.clone();
    let state_clone = state.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1700)).await;
        // If a new recording started during the grace window, leave the
        // overlay alone — don't hide it mid-dictation.
        let current = state_clone.lock().unwrap().clone();
        if current == RecordingState::Ready {
            if let Some(overlay) = app_clone.get_webview_window("overlay") {
                let _ = overlay.hide();
            }
        }
    });
}
```

Update both call sites in `run_transcription_pipeline` to pass `self.state.clone()`:

```rust
                    if e == "no_speech" {
                        emit_audio_empty(app, self.state.clone());
                        return Ok(String::new());
                    }
```

(Both the local and cloud branches.)

- [ ] **Step 2: Manual race test**

Run: `npm run tauri dev`. Press hotkey, hold silent for 0.5 s, release (triggers `no_speech` → 1.5 s notice → 1.7 s overlay-hold). Within that 1.7 s window, press the hotkey again to start a new recording.

Expected: overlay stays visible through the second recording. Without this fix, it would hide ~200 ms after the second recording starts.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/recorder.rs
git commit -m "fix(overlay): preserve overlay during rapid PTT after no_speech notice"
```

---

## Task 12: Bump to v0.4.0, capture baselines, build installer

**Purpose:** Final wrap. Update version metadata, run all tests, build the production installer, capture before/after baselines.

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `package.json`
- Modify: `index.html` (version display, if any)
- Modify: `docs/superpowers/specs/2026-05-08-rudariflow-phase-b-design.md` (fill baseline appendix)

- [ ] **Step 1: Bump version**

Edit `src-tauri/Cargo.toml`: `version = "0.4.0"`
Edit `src-tauri/tauri.conf.json`: `"version": "0.4.0"`
Edit `package.json`: `"version": "0.4.0"`
Edit `index.html`: search for `0.3.0` and replace with `0.4.0` if present.

- [ ] **Step 2: Run all tests**

Run: `cd src-tauri && cargo test --lib`
Expected: all tests pass.

Run: `cd src-tauri && cargo test --lib whisper_engine::tests::integration_tiny_transcribe -- --ignored --nocapture`
Expected: passes (per Task 7's note, this test is now a stub `#[ignore]` — it should be marked as ignored and not actually run anything; verify it doesn't fail).

Run: `npm run build`
Expected: clean Vite build.

- [ ] **Step 3: Build the installer**

Run: `npm run tauri build`
Expected: produces `src-tauri/target/release/bundle/nsis/RudariFlow_0.4.0_x64-setup.exe` and `src-tauri/target/release/bundle/msi/RudariFlow_0.4.0_x64_en-US.msi`.

- [ ] **Step 4: Capture baselines**

Install the new build. Restart the app. With Task Manager and a stopwatch:

- **Idle CPU% / RAM:** open the app, leave it idle for 30 s, record values.
- **Cold-start first dictation:** restart the app, immediately hold hotkey, dictate a 10-s test sentence on `large-v3-turbo`, time from release-to-paste.
- **Warm dictation:** dictate the same sentence again; time release-to-paste.
- **Recording CPU% / RAM:** during the 10-s recording, observe peaks.
- **Peak transcription RAM:** during inference phase, observe peak resident RAM of `RudariFlow.exe`.

Repeat the cold-start, warm-dictation, and steady-state RAM measurements with `small` model on a CPU-only configuration if available (or use Task Manager to set `RudariFlow.exe` affinity to a single CPU core to simulate slow CPU).

- [ ] **Step 5: Fill the spec appendix**

Edit `docs/superpowers/specs/2026-05-08-rudariflow-phase-b-design.md`. Replace the "Baseline measurements (to fill after implementation)" placeholders with actual numbers, comparing against the Phase C baseline if available.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json package.json index.html docs/superpowers/specs/2026-05-08-rudariflow-phase-b-design.md
git commit -m "chore: bump to 0.4.0 and capture Phase B baselines"
```

- [ ] **Step 7: Tag**

After manual end-to-end verification on the user's CUDA box (and optionally a non-NVIDIA box), tag:

```bash
git tag v0.4.0
```

(Don't push the tag automatically — leave that to the user.)

---

## Done criteria

- All 12 tasks committed on `feature/phase-b-whisper-rs`.
- `cargo test --lib` passes (Phase C tests + new whisper_engine tests + audio split test).
- Manual smoke: dictation works end-to-end on both `auto` (resolves to CUDA) and `cpu` modes.
- Manual smoke: settings change to a different model triggers a reload on next dictation.
- Manual smoke: rapid PTT after `no_speech` doesn't hide the overlay mid-recording (Task 11 race fixed).
- Bundle no longer contains `whisper-cli.exe`, `whisper.dll`, `ggml*.dll`; only the CUDA runtime DLLs remain.
- Spec's baseline appendix has real numbers, including before/after for first-dictation latency.
