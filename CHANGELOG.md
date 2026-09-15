# Changelog

All notable changes to RudariFlow are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-09-15 - One build for NVIDIA, AMD and Intel GPUs

### Added
- **Vulkan backend next to CUDA.** whisper.cpp is compiled with both; AMD
  Radeon (RX 6000 and newer) and Intel Arc are now GPU-accelerated instead of
  running on the CPU.
- **Runtime backend selection.** The app enumerates ggml's GPU devices and picks
  CUDA on NVIDIA, otherwise Vulkan, otherwise CPU. If a backend fails to load,
  Auto moves on to the next one.
- GPU Backend setting: Auto / NVIDIA CUDA / Vulkan / CPU only, plus a line
  showing the detected GPUs and which APIs they support.
- `bench` example to compare GPU with and without flash attention, and CPU.

### Changed
- Flash attention per backend: on for CUDA, off for Vulkan. On an RX 6800 (no
  cooperative-matrix support) large-v3-turbo took 910 ms with it vs 434 ms
  without for 17.5 s of audio. Override with `RUDARIFLOW_FLASH_ATTN=1|0`.
- Whisper uses up to 8 CPU threads on the GPU path too (log-mel extraction and
  non-offloaded ops run on the CPU).
- CUDA kernels built for compute 7.5/8.0/8.6/8.9/12.0 (RTX 20 to RTX 50) with
  CUDA 12.8; RTX 50 no longer depends on PTX JIT.
- The CUDA runtime (cudart, cuBLAS, cuBLASLt 12.8) and the Vulkan loader are
  installed next to `rudariflow.exe`, where Windows resolves load-time imports.
  Replaces the `binaries/cuda-runtime` folder and `SetDllDirectoryW`, which could
  not satisfy load-time imports on machines without a CUDA Toolkit.
- Model load logs the chosen backend and device to `startup.log`.

### Fixed
- **Hotkey stopped responding after idle.** Opening a USB audio interface that
  Windows had suspended could block forever while the recorder state lock was
  held. The microphone now opens on its own thread with a 6 s timeout, one
  retry and a fallback to the default input; failures show "Microphone
  unavailable" in the overlay.
- **Changing the hotkey could leave no hotkey at all** when the new chord was
  rejected. The new chord is registered before the old one is released, the
  current chord is paused while capturing, and digits/punctuation use the
  physical key code.
- A panic during transcription can no longer leave the app stuck in
  Transcribing; poisoned locks are recovered.
- Hotkey presses, microphone and transcription errors are written to
  `startup.log`.

### Build
- Prerequisites: CMake, LLVM (libclang), Vulkan SDK and CUDA Toolkit 12.x.
  `scripts/setup-whisper.ps1` collects the runtime DLLs from CUDA_PATH and
  System32. Set a short `CARGO_TARGET_DIR` (e.g. `C:\t\rf`); the nested Vulkan
  shader build exceeds the Windows path limit under `src-tauri\target`.
- Vulkan-only builds: `--no-default-features --features vulkan`.

## [0.4.0] — 2026-05-09 — Phase B: in-process whisper-rs

Architectural shift from per-dictation `whisper-cli.exe` subprocess to in-process
[`whisper-rs`](https://github.com/tazz4843/whisper-rs) bindings.

### Added
- **In-process transcription** via `whisper-rs` 0.16 — no more subprocess spawn,
  no stdout parsing, no temp-WAV-only IPC.
- **Persistent model.** The selected model is loaded once on first dictation and
  reused; stays resident in RAM until you change model or backend.
- **Hotkey-press warmup.** Pressing PTT kicks off model load in parallel so the
  model is hot by the time you stop speaking.
- **Streaming partial transcripts.** Each Whisper segment is emitted as a
  `partial-transcript` event and shown in the overlay as it's produced.
- **Engine auto-invalidation** when `whisperModel` or `gpuBackend` changes in
  Settings — no app restart needed.
- CUDA runtime DLLs isolated under `cuda-runtime/` and discovered via
  `SetDllDirectoryW` at startup.

### Changed
- `whisper.cpp` bundled statically into `rudariflow.exe` with CUDA kernels for 5
  GPU architectures (compute 75/80/86/89/90).
- Build prerequisite: **CUDA Toolkit 12.x** is now required to compile (runtime
  DLLs are still bundled, end users do not need it).
- README setup step now fetches only the 5 CUDA runtime DLLs (~80 MB) instead
  of the full whisper.cpp Windows build (~600 MB).

### Fixed
- Rapid-PTT race after a "no speech" notice — overlay no longer flickers hidden
  when you re-press immediately after a silent recording.

### Removed
- `whisper-cli.exe`, `whisper.dll`, `ggml*.dll` and the `transcribe_local.rs`
  subprocess module.
- `setup-whisper.ps1` no longer downloads the whisper.cpp release archive.

### Known issues
- Installer is larger than v0.3.0: NSIS ~362 MB (+84 MB), MSI ~748 MB (+312 MB),
  driven by static CUDA kernel embedding for 5 architectures. Optimization
  deferred to a later release.

---

## [0.3.0] — Phase C: surgical accuracy + UX wins

### Added
- **Custom Vocabulary** textarea in Settings — inject domain terms, names,
  jargon, and acronyms as a Whisper prompt to bias recognition.
- **No-speech notice** in the overlay when a recording was all silence,
  instead of pasting nothing or showing an error.
- **Clipboard preservation around auto-paste** — your previous clipboard
  contents are saved before paste and restored after.
- Energy-gated **silence trimming** before transcription.
- `audio-empty` event emitted when the trimmed clip has no signal.

### Changed
- Deterministic Whisper sampling flags.
- CPU-thread tuning surfaced for the local backend.
- Groq backend correctly threads the configured language.

### Fixed
- Stopped force-appending a terminal period to every transcript — text comes
  out as Whisper produced it.

### Removed
- Pruned unused whisper.cpp binaries from the bundle.

---

## [0.2.0] — CPU fallback backend + GPU Backend setting

### Added
- **CPU fallback backend** for AMD / Intel / no-GPU systems (significantly
  slower; `small` or `medium` model recommended).
- **GPU Backend setting** in the UI: auto / CUDA / CPU.
- Auto-detection of NVIDIA CUDA at runtime with fallback to CPU when
  unavailable.

### Fixed
- Console window flicker on transcription.
- Autostart now starts minimized to the tray.

---

## [0.1.0] — Initial release

Initial public release of RudariFlow: Tauri 2 dictation app for Windows with
local whisper.cpp transcription, global hotkey, push-to-talk and toggle modes,
auto-paste via simulated typing, system tray, and EN/DE UI.

[0.4.0]: https://github.com/oggii/RudariFlow/releases/tag/v0.4.0
[0.3.0]: https://github.com/oggii/RudariFlow/releases/tag/v0.3.0
[0.2.0]: https://github.com/oggii/RudariFlow/releases/tag/v0.2.0
[0.1.0]: https://github.com/oggii/RudariFlow/releases/tag/v0.1.0
