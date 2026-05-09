# Changelog

All notable changes to RudariFlow are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
