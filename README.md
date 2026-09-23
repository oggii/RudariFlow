<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/RudariFlow%20White%20No%20BG.png">
    <img src="assets/RudariFlow%20No%20BG.png" alt="RudariFlow" width="360">
  </picture>
</p>

<p align="center"><em>English · <a href="README.de.md">Deutsch</a></em></p>

# RudariFlow

Local speech-to-text dictation app for Windows, powered by [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Global hotkey, push-to-talk or toggle mode, automatic paste of the transcribed text.

> **v0.6.0, Windows.** New: local AI cleanup with per-app rules, a dictionary, history, replacements and a "send it" command (see the [changelog](CHANGELOG.md)). One installer for every GPU: NVIDIA GeForce RTX runs on CUDA, AMD Radeon and Intel Arc run on Vulkan, and everything else falls back to the CPU. The backend is picked automatically at runtime.

See [CHANGELOG.md](CHANGELOG.md) for the full history.

Made by [oggi](https://0ggi.ch).

## Features

- Local transcription via in-process whisper-rs — no cloud required, no subprocess per dictation
- **Persistent model:** loaded once on first use and reused across dictations
- **Hotkey-press warmup:** pressing PTT preloads the model in parallel so it's hot by the time you finish speaking
- **Streaming partial transcripts:** text appears in the overlay as Whisper emits each segment
- **Auto backend detection:** NVIDIA CUDA when available, otherwise Vulkan (AMD / Intel / NVIDIA), otherwise CPU. Settings show the detected GPUs and let you force CUDA, Vulkan or CPU. Flash attention is on for CUDA and off for Vulkan (2× slower on an RX 6800); force it with `RUDARIFLOW_FLASH_ATTN=1` or `=0`
- **Dictionary:** its own tab for names, brands and jargon. Add words one at a time or paste a list (commas or one per line). Whisper gets them as its prompt, the transcript uses their exact spelling even when Whisper hears them slightly differently ("github" becomes "GitHub", "Grüß'n shop" becomes "Grüssen-Shop"), and AI cleanup gets the list too. A Swiss spelling switch writes ss instead of ß
- **No-speech detection:** silent recordings show an overlay notice instead of pasting nothing
- **Clipboard-safe paste:** your previous clipboard contents are saved and restored around auto-paste, and dictations stay out of the Windows clipboard history (Win+V) and cloud clipboard
- **Replacements:** say a short phrase, get longer text, e.g. "my email" becomes your address. Matched as whole words, any capitalisation; a dictation that is only the phrase inserts just the replacement
- **"Send it" voice command:** end a dictation with "Send it." (German: "Abschicken.") as its own sentence and RudariFlow presses Enter or Ctrl+Enter after pasting. Off by default
- **History:** the last 200 dictations stay on your computer, the last 50 with their recording. Copy, play, delete, or re-run a recording with the current model. Can be set to text only or turned off
- **Paste last transcript:** a second hotkey (default Alt+Shift+V) pastes your last dictation again
- **Mute other apps while recording:** music and videos go quiet while you dictate and come back afterwards (off by default)
- **AI cleanup, fully local:** a language model on your PC removes filler words, applies spoken corrections ("Tuesday, no, Wednesday"), fixes grammar and punctuation, formats lists and, in the Polished style, smooths your sentences. It never translates and never answers what you dictate. Per-app rules ("lowercase in WhatsApp", "formal in Outlook", "no AI in VS Code") match the program or a word in the window title, so they also work for websites. Runs Gemma 4 (E4B by default, 12B or E2B selectable) in a bundled llama.cpp server; the model downloads once (3 to 7 GB), then nothing leaves your PC. If the model is not ready or too slow, the plain Whisper text is pasted. Off by default
- Multiple Whisper models selectable: tiny → large-v3-turbo, auto-downloaded on selection
- Languages: auto-detect or any of the ~100 languages Whisper supports
- **Push-to-talk** and **toggle** modes
- Configurable global hotkey (capture any chord from the settings UI), including mouse side buttons (Mouse 4 / Mouse 5, alone or with Ctrl/Shift/Alt/Win). A bound side button is consumed, so it no longer triggers "Back" / "Forward" in other apps
- Floating recording pill with live waveform and cancel button
- Auto-paste via simulated typing (works with any application)
- System tray icon — closing the window minimises to tray instead of quitting
- Optional: start with Windows login
- UI available in English and German (auto-detected from OS locale)

## System Requirements

- **OS:** Windows 10/11 x64
- **GPU (recommended), current driver only, no extra runtime to install:**
  - NVIDIA GeForce RTX 20 series or newer: CUDA (driver 525 or newer)
  - AMD Radeon RX 6000 or newer (AMD Software: Adrenalin Edition): Vulkan
  - Intel Arc and other Vulkan 1.2 GPUs: Vulkan
- **CPU fallback:** Works without a usable GPU, but significantly slower (~10-30×). For CPU-only users we recommend the `small` or `medium` model.
- **RAM:** the selected whisper model stays resident from first dictation onward. `large-v3-turbo` ≈ 1.6 GB, `small` ≈ 500 MB, `tiny` ≈ 80 MB.
- **AI cleanup (optional):** runs on Vulkan on AMD, NVIDIA and Intel GPUs with the normal driver, on the same card as Whisper. The default model needs about 5 GB of video memory on top of Whisper, so 8 GB cards and up are fine; smaller cards move part of the model to the CPU. Measured on an AMD Radeon RX 6800: about 0.3 s per dictation. NVIDIA and Intel Arc use the same Vulkan path but have not been tested yet. Without a usable GPU expect 5 to 10 s per dictation.

## Installation (for end users)

Download the latest `RudariFlow_x.y.z_x64-setup.exe` from the [Releases](https://github.com/oggii/RudariFlow/releases) page and run it.

The installer is unsigned, so Windows SmartScreen will show an "Unknown publisher" warning — click **More info → Run anyway** to proceed. Code signing may be added in a later release.

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (MSVC toolchain on Windows)
- [Node.js](https://nodejs.org/) ≥ 20
- Visual Studio Build Tools with the C++ workload (for `cargo build`)
- [CMake](https://cmake.org/) and [LLVM](https://llvm.org/) (libclang, for `whisper-rs-sys` bindgen)
- [Vulkan SDK](https://vulkan.lunarg.com/) (provides `glslc` to compile whisper.cpp's Vulkan shaders; `VULKAN_SDK` must be set)
- [CUDA Toolkit 12.x](https://developer.nvidia.com/cuda-downloads) (12.8 recommended; the compiler and cuBLAS components are enough, no NVIDIA GPU needed to build)

### Setup

```powershell
# 1. Clone the repo
git clone https://github.com/oggii/RudariFlow.git
cd RudariFlow

# 2. Frontend dependencies
npm install

# 3. Collect the GPU runtime DLLs shipped next to the exe
#    (CUDA runtime from CUDA_PATH, Vulkan loader from System32)
powershell -ExecutionPolicy Bypass -File scripts/setup-whisper.ps1

# 3b. Fetch the llama.cpp server used for AI cleanup (pinned build, SHA-256 checked)
powershell -ExecutionPolicy Bypass -File scripts/setup-llama.ps1

# 4. Keep the build path short: whisper.cpp's nested Vulkan shader build
#    exceeds the 260-character path limit under src-tauri\target
$env:CARGO_TARGET_DIR = "C:\t\rf"
$env:CUDAARCHS = "75;80;86;89;120"   # RTX 20, 30, A-series, 40, 50

# 5. Run in dev mode
npm run tauri dev
```

Without a CUDA Toolkit you can still build and run a Vulkan-only binary:
`npm run tauri dev -- --no-default-features --features vulkan`.

### Production build

```powershell
npm run tauri build
```

Produces (under `CARGO_TARGET_DIR`):
- `release/rudariflow.exe` (portable, needs the DLLs from step 3 next to it)
- `release/bundle/nsis/RudariFlow_x.y.z_x64-setup.exe` (NSIS installer)
- `release/bundle/msi/RudariFlow_x.y.z_x64_en-US.msi` (MSI installer)

A plain `cargo build` does not copy the installer resources next to the exe. For AI cleanup in such a build, point it at the server: `$env:RUDARIFLOW_LLAMA_DIR = "$PWD\src-tauri\binaries\llama"`.

`src-tauri/examples/ai_bench.rs` compares language models on your GPU with the app's prompt and output guard:

```powershell
cd src-tauri
cargo run --release --example ai_bench -- ..\src-tauri\binaries\llama report.md path\to\model.gguf
```

### Test data separate from your installed app

Settings, models and history live in `%APPDATA%\com.rudariflow.app`. To run a dev build next to an installed RudariFlow without touching its data, point it at another folder:

```powershell
$env:RUDARIFLOW_DATA_DIR = "C:\t\rf-test-data"
```

### Benchmark

```powershell
cd src-tauri
cargo run --release --example bench -- "$env:APPDATA\com.rudariflow.app\ggml-large-v3-turbo.bin" path\to\16khz-mono.wav
```

Times model load and transcription on the first GPU with and without flash attention, and on CPU.

## Architecture

- **Tauri 2** (Rust backend + Webview frontend)
- **Frontend:** Vanilla TypeScript + Vite
- **Audio capture:** [cpal](https://github.com/RustAudio/cpal) (cross-platform low-level audio I/O)
- **Transcription:** in-process [`whisper-rs`](https://github.com/tazz4843/whisper-rs) (whisper.cpp Rust bindings) built with both the `cuda` and `vulkan` features; the backend is chosen at runtime from ggml's device list, with fallback to CPU
- **AI cleanup:** [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` (release b11100, Vulkan build) as a child process on 127.0.0.1 with a random port and API key, in a kill-on-close Job Object; Gemma 4 GGUF models (Apache-2.0) from Hugging Face. It runs as its own process because whisper-rs links its own copy of ggml into `rudariflow.exe`
- **Auto-paste:** [enigo](https://github.com/enigo-rs/enigo) (keyboard simulation)
- **Hotkey:** [tauri-plugin-global-shortcut](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/global-shortcut)
- **Autostart:** [tauri-plugin-autostart](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/autostart)

## Licence / Credits

RudariFlow is released under the **[MIT License](LICENSE)** — free to use, modify, redistribute, and incorporate into closed-source projects, with attribution.

Initial Tauri scaffolding based on [albertshiney/typr](https://github.com/albertshiney/typr).
Uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) for transcription.

© 2026 [oggi](https://0ggi.ch).
