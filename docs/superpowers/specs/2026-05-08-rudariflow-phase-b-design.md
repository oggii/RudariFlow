# RudariFlow Phase B — In-Process Whisper

**Date:** 2026-05-08
**Target release:** v0.4.0
**Status:** approved design, ready for implementation plan

## Context

Phase C (v0.3.0) shipped cheap surgical wins on top of the existing architecture: per-dictation `whisper-cli.exe` subprocess invocation. The dominant remaining cost is per-dictation overhead — process spawn plus full model reload from disk on every hotkey press. On the user's CUDA box (`large-v3-turbo`), this is roughly 1–3 s of pure overhead before any inference happens.

Phase B replaces the subprocess with in-process [`whisper-rs`](https://github.com/tazz4843/whisper-rs) bindings. The model loads once (lazily, on first dictation) and stays resident until app exit or a settings change. Subsequent dictations skip the load entirely.

While we're opening the architecture, the same model-resident state enables streaming the transcript into the overlay segment-by-segment as it's produced. The recording phase itself remains free of inference (no live partials *during* recording) — partials appear during the post-stop inference pass, which on a fast GPU completes in ~1–3 s for typical dictation length, so the perceived UX is "text appears as you finish talking."

## Goals

- Eliminate per-dictation model reload latency. After the first dictation, transcription start is dominated by inference time alone.
- Stream segment text into the overlay during the inference pass, so the user sees progress instead of an opaque "transcribing…" block.
- Maintain today's "single installer, runtime backend auto-detect" UX.
- Reduce install footprint by deleting the dual `whisper-cuda/` + `whisper-cpu/` bundled trees (~80 MB savings on top of Phase C's pruning).
- Preserve all Phase C wins: custom prompt, silence trim, clipboard restore, deterministic decoding, language fix, CPU thread tuning.

## Non-goals

- **No live partials during recording.** Inference does not run while audio is being captured. Approach A (continuous sliding-window streaming) was considered and rejected: it burns GPU continuously during recording, exposes whisper's known chunk-boundary quality drift, and yields marginal UX benefit for short-dictation use.
- **No VAD auto-stop.** Recording still ends only on hotkey release / toggle. The Task-3 energy gate stays exactly as it is (silence trim + audio-empty event).
- **No type-into-target during recording.** Final text is pasted as a single block on stop, same as today.
- **No two-installer build matrix.** Single `RudariFlow_x.y.z_x64-setup.exe` continues to handle CUDA and non-CUDA hardware via runtime fallback.
- **No idle eviction of the loaded model.** Resident from first dictation until app exit or settings change.
- **No new settings panels or schema fields.** Existing `whisperModel`, `gpuBackend`, `language`, `customPrompt`, `engine` cover everything.
- **No CUDA-only build.** AMD / Intel / no-GPU users continue to be supported via CPU fallback.

## Architecture

### Module changes

| File | Status | Purpose |
|---|---|---|
| `src-tauri/src/whisper_engine.rs` | **new** | Owns the resident model. Public `WhisperEngine::transcribe(samples, language, custom_prompt, app) -> Result<String, String>` and `WhisperEngine::ensure_loaded(...)`. Internally `Mutex<Option<LoadedModel>>` where `LoadedModel { ctx: WhisperContext, model_path: PathBuf, use_gpu: bool }`. |
| `src-tauri/src/recorder.rs` | modified | `run_transcription_pipeline` calls `WhisperEngine::transcribe(&samples, ...)` directly with the in-memory `Vec<f32>`. Local path no longer writes a temp WAV. Hotkey press also fires `tauri::async_runtime::spawn(engine.ensure_loaded(...))` for background warmup. Existing `audio-empty` flow preserved. |
| `src-tauri/src/transcribe_local.rs` | **deleted** | Subprocess invocation, `probe_backend`, `resolve_backend`, `whisper-cli` references. ~280 LOC removed. `model_filename` and `model_download_url` move to `whisper_engine.rs`. |
| `src-tauri/src/lib.rs` | modified | At app startup, on Windows, call `SetDllDirectoryW(<resource_dir>/binaries/cuda-runtime)` so the CUDA runtime DLLs are loadable when whisper.cpp's CUDA backend initializes. Construct and store `WhisperEngine` in Tauri managed state. |
| `src-tauri/src/transcribe_groq.rs` | unchanged | Cloud path is unaffected. |
| `src-tauri/Cargo.toml` | modified | Add `whisper-rs = { version = "<pinned>", features = ["cuda"] }`. Pin exact version. |
| `src-tauri/tauri.conf.json` | modified | Drop `binaries/whisper-cuda/*` and `binaries/whisper-cpu/*`. Add explicit allowlist for `binaries/cuda-runtime/*` containing the runtime DLLs (see Bundle section). |
| `src/overlay.html` | modified | Listen for `partial-transcript` events, render text in a new `.transcript` element, reset on next `recording-state: started`. |

### Model lifecycle

- **Load trigger:** hotkey press fires both audio capture *and* `tokio::spawn(engine.ensure_loaded(...))`. By the time the user releases the hotkey (typical 1–10 s), the model is warm. First dictation feels native; subsequent dictations are instant.
- **Reload trigger:** settings change to `whisperModel` or `gpuBackend` invalidates the cached `LoadedModel`. Next call reloads. `WhisperEngine::on_settings_changed(new_settings)` clears the mutex if the relevant fields differ.
- **Eviction:** none. Resident until app exits or settings change.
- **Concurrency:** single-flight via the engine's `Mutex`. A second hotkey while transcribing waits — same as today.

### GPU backend resolution

`probe_backend` (which ran `whisper-cli --help`) goes away. New flow on first `ensure_loaded()`:

1. If `gpu_backend == "cpu"` → load with `WhisperContextParameters::use_gpu(false)`. Done.
2. If `gpu_backend == "cuda"` → load with `use_gpu(true)`. On failure, surface the error to the user (they explicitly asked for CUDA).
3. If `gpu_backend == "auto"` → load with `use_gpu(true)`. On failure, log + retry with `use_gpu(false)`. Cache the chosen mode in the engine's session state (parallel to today's `AUTO_CACHED`).

`flash_attn` defaults on whenever `use_gpu == true` (`WhisperContextParameters::flash_attn(true)`). No setting exposed.

### Streaming flow (Approach B)

In `WhisperEngine::transcribe`:

1. Build `FullParams::new(SamplingStrategy::Greedy { best_of: 1 })`.
2. Set: `language(language)`, `print_*(false)`, `temperature(0.0)`, `single_segment(false)`, `n_threads(threads)` where `threads = cpu_thread_count()` clamped to 1–8 on CPU, otherwise default. If `custom_prompt` non-empty after trim, `initial_prompt(prompt)`.
3. `params.set_new_segment_callback(move |state, n_new| { ... })`. Inside the callback: read all segments via `state.full_n_segments()` and `state.full_get_segment_text(i)`, concatenate, emit a Tauri event `partial-transcript` with payload `{ text: String, is_final: false }` to the overlay window via `app.emit_to("overlay", "partial-transcript", payload)`.
4. Run `state.full(params, samples)`. On error, return `Err(...)`.
5. After return: collect final text from segments, run through existing `cleanup::cleanup_text`, emit `partial-transcript { text, is_final: true }`, return final text.

The caller (`recorder.rs`) does the existing cleanup, paste, focus-restore, then triggers the overlay-hide after the Task-11 grace window.

### Overlay UI changes

The recording pill currently shows a waveform during recording. After Phase B:

- Recording state: waveform unchanged.
- After hotkey release, before first segment: brief "transcribing…" placeholder text.
- During inference: replace placeholder with cumulative segment text. Update on each `partial-transcript` event. Plain text, no animation.
- On `is_final: true`: stop updating. Pill fades / hides via the existing Task-11 path.
- On next recording start: clear the transcript element.

No new i18n keys (the placeholder is reusable as `transcribing_message`; add to EN + DE).

## Bundle changes

What gets removed from the bundle:

- `binaries/whisper-cuda/whisper-cli.exe`
- `binaries/whisper-cuda/whisper.dll`
- `binaries/whisper-cuda/ggml*.dll` (whisper-rs links these statically)
- `binaries/whisper-cpu/*` — entire directory (CPU path is now in-process, same binary as CUDA)

What stays:

- `binaries/cuda-runtime/cudart64_12.dll`
- `binaries/cuda-runtime/cublas64_12.dll`
- `binaries/cuda-runtime/cublasLt64_12.dll`
- `binaries/cuda-runtime/nvrtc64_120_0.dll`
- `binaries/cuda-runtime/nvrtc-builtins64_124.dll`

These remain because `whisper-rs` with the `cuda` feature dynamically loads them at runtime when GPU init runs. They're reused exactly from the current `whisper-cuda/` allowlist.

**Loader strategy:** at app startup in `lib.rs::run()`, on Windows, call `SetDllDirectoryW(<resource_dir>\binaries\cuda-runtime)` once before any whisper call. This adds the CUDA runtime directory to the DLL search path without polluting the install root.

**Runtime fallback for non-NVIDIA machines:** the bundled `cudart64_12.dll` itself does not require an NVIDIA driver to load — the driver is queried lazily when CUDA initializes a device. So the binary boots cleanly on AMD/Intel machines, `use_gpu(true)` model load fails when no device is found, and the fallback in step 3 of "GPU backend resolution" picks `use_gpu(false)`. **This load behavior is the load-bearing assumption the Task-1 spike must validate.** If it doesn't hold, we fall back to the two-installer build matrix as a contingency.

## Cutover plan

Single feature branch, no parallel implementation behind a flag. The Task-1 spike validates feasibility before we commit to the architecture.

1. **Spike (gate).** New worktree. Add `whisper-rs` dep with `cuda` feature. Write a one-shot binary `src-tauri/examples/spike.rs` that loads `ggml-tiny.bin`, transcribes a fixed 3-second WAV with `use_gpu=true`, then with `use_gpu=false`. Confirm: (a) `cargo build` succeeds with bundled CUDA Toolkit, (b) runs on the CUDA box and produces output for both code paths, (c) on a non-NVIDIA machine (or by simulating one — e.g. blocking access to nvcuda.dll), `use_gpu=true` fails cleanly and `use_gpu=false` succeeds. **If anything blocks, stop and revisit. The contingency is the two-installer build matrix.**
2. **`whisper_engine.rs` skeleton.** WhisperEngine struct, lazy load, mutex, GPU fallback. `model_filename` and `model_download_url` move here from `transcribe_local.rs`. Pure functions extracted for unit tests: param builder, thread clamp, GPU resolution decision.
3. **Wire recorder.** Replace `transcribe_local::transcribe_local` call with `WhisperEngine::transcribe`. Audio path becomes `&[f32]`, no temp WAV. Existing `audio-empty` flow preserved.
4. **Segment callback → partial-transcript event.** Tauri event emit from inside the callback. Overlay event listener and UI element.
5. **Background warmup.** `tauri::async_runtime::spawn(engine.ensure_loaded())` triggered on hotkey press.
6. **Bundle changes + `SetDllDirectoryW`.** Update `tauri.conf.json` resources, add Windows-only startup hook in `lib.rs`. Move CUDA runtime DLLs from `whisper-cuda/` to `cuda-runtime/`.
7. **Delete subprocess code.** Remove `transcribe_local.rs`. Clean up any UI strings referencing whisper-cli.
8. **Fix the Task-11 race** flagged in Phase C review: the overlay-hide spawn doesn't check recorder state before hiding. Pass recorder state into the spawned closure and skip hide when active.
9. **Bump to 0.4.0, baseline measurements, build installer.** Capture cold-start, first-dictation, and steady-state latency on CUDA + CPU. Append to this spec's appendix.

## Tests

- **Unit-testable (default `cargo test`):**
  - Param builder: language, prompt, temperature, threads (CPU only), best-of, single-segment.
  - Thread clamp: same logic and bounds as Phase C `cpu_thread_count`.
  - GPU resolution decision (table-driven): `(requested, gpu_load_succeeds) -> chosen_use_gpu`.
  - Settings-change detection: `on_settings_changed` invalidates iff `whisperModel` or `gpuBackend` differs.
- **Integration (gated `#[ignore]` or `#[cfg(feature = "integration-test")]`):** load `ggml-tiny.bin` from a known dev location, transcribe a fixed 3-second WAV, assert non-empty result. Run manually before tagging. CI doesn't pull the model.
- **Frontend:** overlay handles `partial-transcript` events, builds text incrementally across multiple events, resets on new recording. Existing test infrastructure absorbs this.

## Settings & migration

No schema change. All Phase B configurable knobs already exist in the `Settings` struct: `whisperModel`, `gpuBackend`, `language`, `customPrompt`, `engine`. Pre-0.4.0 configs load unchanged.

The `gpuBackend` semantics narrow slightly: it now controls the `use_gpu` boolean fed to `WhisperContextParameters` rather than picking between two compiled binaries. User-facing meaning is identical (`auto` / `cuda` / `cpu`).

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **CUDA DLL load fails on AMD/Intel machines** even with `use_gpu=false`, blocking single-installer feasibility | Medium — depends on whether `cudart64_12.dll` self-loads cleanly when no NVIDIA driver is present | Task-1 spike validates explicitly. Contingency: two-installer build matrix (`-cuda` and `-cpu` variants), ~1 day rework. |
| **`whisper-rs` API churn breaks build later** | Low — pinned exact version | Pin version; treat upgrades as scheduled work. |
| **flash-attn regressions on Pascal/older CUDA** | Low — gracefully degrades per docs | Default on; if reports come in, gate by compute capability. |
| **Background warmup races with very fast hotkey toggle** | Low — first dictation only | Mutex serializes; user waits same time as today on cold start. |
| **`large-v3-turbo` resident RAM (~1.6 GB)** surprises low-end users | Medium | Document in README. Settings already lets users pick smaller models. |
| **Settings reload during in-flight transcription** | Low | Next call after current returns picks up the change; no mid-call teardown. |
| **CUDA Toolkit becomes a dev prerequisite** for `cargo build` with `cuda` feature | Certain — required for whisper-rs `cuda` feature compilation | Document in README Prerequisites. CI build environment ships CUDA Toolkit. |

## Baseline measurements (to fill after implementation)

Capture on CUDA box (RTX 30/40-series), `large-v3-turbo`, fixed 10-second test clip:

- **Cold start (first dictation after app launch):** _TBD before/after_
- **Warm dictation (second and later):** _TBD before/after_
- **Idle CPU% / RAM:** _TBD before/after_
- **Recording CPU% / RAM:** _TBD before/after_
- **Peak RAM during transcription:** _TBD before/after_

Capture on CPU-only box (no NVIDIA), `small`, same fixed clip:

- **Cold start:** _TBD before/after_
- **Warm dictation:** _TBD before/after_
- **Steady-state RAM:** _TBD before/after_

## Spike result (Task 1)

Validated on Windows 10 + CUDA Toolkit 12.6.85 + LLVM 19.1.7 (libclang for bindgen) + VS 2022 Build Tools (MSVC 14.44, CUDA-supported) + Ninja generator, against `tiny.en` model on a 3-second mono 16 kHz fixture (`tests/fixtures/spike-3s.wav`). Build env requires `CUDAARCHS=75;80;86;89;90` (Blackwell sm_120 reaches the GPU via PTX JIT — newer arches not yet known to CUDA 12.6).

- Build: succeeded with `whisper-rs 0.16` `cuda` feature; single binary loads `cudart64_12.dll` lazily.
- `use_gpu=true` on RTX 5080 (Blackwell sm_120 via PTX JIT): succeeded, CUDA0 backend, `CUDA0 total size = 77.11 MB`, transcription returned non-empty text.
- `use_gpu=false` on RTX 5080: succeeded in same process after the GPU run, `whisper_backend_init_gpu: no GPU found`, `CPU total size = 77.11 MB`, transcription returned the same text.
- `use_gpu=true` with `CUDA_VISIBLE_DEVICES=-1`: **bonus** — whisper.cpp emits `ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected` and **automatically falls back to the CPU backend** (`CPU total size = 77.11 MB`). Transcription succeeds. This means our `auto` selector does not need to probe for CUDA before constructing the context — `use_gpu=true` is safe to attempt unconditionally.
- `use_gpu=false` with `CUDA_VISIBLE_DEVICES=-1`: succeeded, identical to the GPU-visible CPU path.

Conclusion: single-installer auto-detect is feasible. Proceed with Task 2.
