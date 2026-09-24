# Changelog

All notable changes to RudariFlow are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Words on screen** (Dictionary tab, on by default), like Aqua Voice's
  Deep Context. When you press the hotkey, RudariFlow reads the visible
  text of the window you dictate into through Windows UI Automation (about
  20 ms for a web page, 200 ms for VS Code, while you speak) and picks out
  names, brands and technical terms: "Yılmaz", "Paperless-ngx", "GitLab",
  "Salon-Agenda". Up to 20 name-like terms go into Whisper's prompt ahead
  of the dictionary. Of up to 40 terms, those that resemble something
  Whisper heard go into the AI cleanup and Edit mode request, with the
  instruction to use their spelling but never add them. Measured:
  "Umit Yilmaz" becomes "Ümit Yılmaz", "Paperless NGX" becomes
  "Paperless-ngx", an unrelated sentence stays unchanged. Only the word
  list is used, nothing is stored; the log records counts only. Ordinary
  words, words at the start of a line, links, emails, code fragments,
  measurements ("13h", "0.32s") and dictionary entries are left out.

### Improved
Measured on an AMD Radeon RX 6800 with large-v3-turbo and Gemma 4 E4B.
- **First dictation after start as fast as the rest.** The AI server warms
  its prompt cache with the dictation prompt of your settings (dictionary,
  instructions, Write in), and again when they change, instead of a
  generic prompt: AI time of the first dictation 958 ms -> 477 ms.
- **Auto-detect costs no extra time.** The language detection's encoder
  pass is reused instead of running the encoder twice (whisper.cpp patch
  in patches/, applied by scripts/setup-whisper-patch.ps1): Whisper with
  Auto-detect 631 ms -> 330 ms, like a set language (331 ms), same text
  in 30 of 30 recordings; German is still detected as German.
- **Whisper loads at start**, before the AI server: the first dictation no
  longer waits for it (1.2 s from a warm disk, 5.7 s cold), and the AI
  server's memory fit sees Whisper's share of the video memory.
- **Whisper keeps its state** between dictations: 50 ms less each time,
  same text in 20 of 20 recordings.
- **Fewer screen terms for the AI** (see Words on screen): AI time
  559 ms -> 389 ms in the median.
- After 10 minutes without a request, a hotkey press refreshes the AI's
  prompt cache while you speak; after a night of idling the first
  dictation had run into its time limit and was pasted without AI.
- On battery, Whisper and the AI model are unloaded after 10 minutes
  without dictation (about 5 GB of video memory and 3 GB of RAM), so a
  laptop's graphics card can sleep. The next press loads them while you
  speak.

### Fixed
- NVIDIA cards older than GTX 16 / RTX 20 (compute capability below 7.5)
  use Vulkan. The bundled CUDA kernels do not run on them, and the first
  transcription crashed the app.
- PCs with an integrated and a dedicated GPU: Whisper and the AI use the
  dedicated card (then the one with more memory), not whichever Vulkan
  lists first.
- Requests to the local AI server ignore a Windows system proxy.

### Diagnostics
- startup.log gets one "[timing]" line per dictation (start, audio,
  Whisper, text, AI, paste, clipboard restore, history) and a "[whisper]"
  line; the previous llm-server.log stays as llm-server.prev.log.
- New benchmarks in src-tauri/examples: warm_bench (first dictation after
  start), state_bench (Whisper state), terms_bench (screen terms),
  lang_bench (Auto-detect) and ctx_bench (a shorter encoder window: faster,
  but it changed or repeated words in 9 to 19 of 49 recordings, so it is
  not used).

## [0.7.0] - 2026-09-23 - Edit mode

### Added
- **Edit mode** (AI cleanup tab, on by default). Select text in any app,
  hold the hotkey and say what to change ("make it shorter", "more formal",
  "translate this into Turkish", "change five to six", "make this a list"),
  say the new wording itself, or say "delete that". The local model rewrites
  the selection and RudariFlow pastes over it; Ctrl+Z in the app undoes it.
  The pill shows "✎ 12 words" while you speak. With nothing selected the
  hotkey dictates as before. The selection is read through Windows UI
  Automation, so nothing is copied and no keys are pressed before you
  speak; apps that do not share their text, terminals, address and search
  bars, password fields, apps set to No AI and selections over 6,000
  characters get a normal dictation. History keeps the original text and
  what you said. Measured on an RX 6800: 0.2 to 0.7 s for a sentence,
  1.4 s to shorten and 3.7 s to rewrite a 900-character email.

### Changed
- The AI server keeps 8,192 tokens of context (was 4,096), enough for a
  6,000-character selection and its rewrite.

## [0.6.2] - 2026-09-23

### Improved
- **Write in** now says where it does not translate: a line under the
  setting names the apps whose rule says No AI ("Not translated in: code
  (No AI).") and warns when AI cleanup is off. Before, a No AI rule for the
  app you dictated into silently kept the spoken language.

## [0.6.1] - 2026-09-23 - Write in, dictionary import and export

### Added
- **Write in** (AI cleanup tab): pick one language and the AI writes every
  dictation in it, translating when you spoke another one. Meant for people
  who switch languages while speaking: set Engine > Language to Auto-detect
  so Whisper hears each language correctly, and the AI turns it into, say,
  English. The output check now makes sure the answer is in the chosen
  language. Default is "Same language as spoken", which keeps the old behaviour.
- **Dictionary import and export.** Export saves the list as a text file,
  one entry per line; Import merges a file into the list and skips words
  that are already there (commas, a UTF-8 BOM and blank lines are fine). Use
  it to keep the same dictionary on several PCs.

## [0.6.0] - 2026-09-23 - Local AI cleanup, dictionary and history

### Added
- **AI cleanup, fully local.** New tab. After Whisper, a language model on
  the PC removes fillers and false starts, applies spoken self-corrections,
  fixes grammar and punctuation, formats lists and (Polished style) smooths
  phrasing; Light keeps the wording. Per-app rules add instructions or turn
  the AI off, matched on the exe name or a whole word in the window title.
  Runs Gemma 4 E4B (default), 12B or E2B in a bundled llama.cpp server
  (b11100, Vulkan) on 127.0.0.1, on the GPU Whisper uses; the model
  downloads once. A test box shows the result and time. Replacement
  triggers are hidden from the model behind placeholders. The language
  Whisper heard is named in the request and answers in another language are
  discarded, so a rule such as "German: Sie-Form" cannot translate an
  English dictation. Any failure,
  missing model or time limit pastes the plain Whisper text. Measured on
  an RX 6800: 0.2 to 0.8 s per dictation. Off by default.
- **Dictionary tab** (replaces the Custom Vocabulary text box in Engine).
  An input with Add and a list with Remove, like Aqua Voice's dictionary;
  pasting a list with commas or line breaks adds every entry, duplicates
  are skipped. Entries are still stored in `customPrompt` (no migration).
  New: the transcript gets their exact spelling, also when Whisper hears
  them differently: case, spaces, hyphens, apostrophes and ß/ss are
  ignored when comparing, and entries of 8+ letters allow one letter off
  (12+: two), so "Grüß'n shop" becomes "Grüssen-Shop" without AI. Short
  entries need an exact match ("polar" never becomes "Polars"), and word
  forms that only add an ending ("Heinrichs") stay. AI cleanup receives
  the list in its cached system prompt.
- **Swiss spelling** switch in the Dictionary tab: ss instead of ß in
  every dictation, with or without AI.
- History keeps the app a dictation went into and, when the AI changed
  it, the original text ("Original" button).
- `scripts/setup-llama.ps1` and `examples/ai_bench.rs` (model benchmark).
- **Replacements.** A new tab maps spoken phrases to longer text ("my email" ->
  your address, links, signatures). Matched as whole words in any
  capitalisation, in one pass, longest phrase first; a dictation that is only
  the phrase inserts just the replacement, without Whisper's punctuation.
- **"Send it" voice command.** With Recording > Voice command set to Enter or
  Ctrl+Enter, a dictation ending in "Send it." / "Abschicken." (also "Send.",
  "Senden.", "Absenden.", "Schick es ab.") as its own sentence is pasted
  without the phrase and then submitted. The phrase only counts as a separate
  sentence, so "I'll send it." is pasted as dictated. Off by default.
- **History tab.** The last 200 dictations are stored in
  `history/history.json`, the last 50 with a 16 kHz WAV. Copy, play, delete,
  clear, and re-run a recording with the current engine and model (nothing is
  pasted). Setting: text and recordings (default), text only, or off.
  Dictations are saved even when the paste fails.
- **Paste last transcript hotkey** (default Alt+Shift+V, keyboard chords only,
  can be turned off). Works with history off, from memory.
- **Mute other apps while recording.** Mutes every audio session on every
  playback device except RudariFlow's own (the start/stop sounds keep
  playing) and sessions that were already muted, and unmutes exactly those
  when recording stops or is cancelled. Off by default.
- The language picker lists all ~100 Whisper languages, named in the UI
  language with the native name.
- `RUDARIFLOW_DATA_DIR` points a build at a separate settings/history folder.

### Changed
- Dictations are kept out of the Windows clipboard history (Win+V) and the
  cloud clipboard; so is the restored previous clipboard content.
- Settings rows: long hints wrap instead of squeezing the dropdown next to
  them, and dropdowns are as wide as their longest option.
- The sidebar shows the real app version (it was stuck at v0.4.0).
- The settings window has a fixed size (900 x 600) and cannot be maximized.

### Fixed
- Model downloads go to `<file>.part` and are renamed when complete, so an
  interrupted download no longer looks like a finished model; progress
  events are throttled to about 10 per second.
- **Microphone dropdown was blank** with the default setting, because the
  list had no entry for "default"; the next settings save then stored an empty
  device name, and every recording first failed to open "" and retried for
  0.4 s before falling back. The list now starts with "System default (device
  name)", a saved device that is unplugged stays listed as "not connected",
  and an empty saved value loads as "default".
- Pasting waits (up to 1.5 s) until Ctrl, Shift, Alt and Win are released, so
  a hotkey that is still held cannot turn Ctrl+V into Ctrl+Shift+V.
- The two clipboard unit tests no longer race each other.

## [0.5.1] - 2026-09-15 - Mouse side buttons as hotkey

### Added
- **Mouse side buttons as hotkey.** Press Mouse 4 (Back) or Mouse 5 (Forward),
  optionally with Ctrl/Shift/Alt/Win, while capturing the hotkey in settings.
  Implemented with a low-level mouse hook because `RegisterHotKey` only
  accepts keyboard keys. Toggle and push-to-talk both work; the bound button
  is consumed so it does not also navigate back/forward in the focused app.

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
