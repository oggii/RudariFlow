<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/RudariFlow%20White%20No%20BG.png">
    <img src="assets/RudariFlow%20No%20BG.png" alt="RudariFlow" width="360">
  </picture>
</p>

<p align="center"><em>English · <a href="README.de.md">Deutsch</a></em></p>

# RudariFlow

Local speech-to-text dictation app for Windows, powered by [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Global hotkey, push-to-talk or toggle mode, automatic paste of the transcribed text.

> **v0.2.0 — Windows.** NVIDIA GPU recommended for speed; CPU fallback included for AMD / Intel / no-GPU systems. macOS and Linux planned for later releases.

Made by [oggi](https://0ggi.ch).

## Features

- Local transcription via whisper.cpp — no cloud required
- **Auto backend detection:** uses NVIDIA CUDA when available, falls back to CPU otherwise
- Multiple Whisper models selectable: tiny → large-v3-turbo, auto-downloaded on selection
- Languages: auto-detect or pick from 14 fixed languages (EN, DE, FR, IT, ES, …)
- **Push-to-talk** and **toggle** modes
- Configurable global hotkey (capture any chord from the settings UI)
- Floating recording pill with live waveform and cancel button
- Auto-paste via simulated typing (works with any application)
- System tray icon — closing the window minimises to tray instead of quitting
- Optional: start with Windows login
- UI available in English and German (auto-detected from OS locale)

## System Requirements

- **OS:** Windows 10/11 x64
- **GPU (recommended):** NVIDIA with a CUDA-capable driver for full speed
- **CPU fallback:** Works without a GPU or on AMD/Intel — significantly slower (~10-30×). For CPU-only users we recommend the `small` or `medium` model.
- **Note:** The first run of each model on a new GPU JIT-compiles CUDA kernels (~30-60s, one-time)
- **RAM:** the selected whisper model stays resident from first dictation onward. `large-v3-turbo` ≈ 1.6 GB, `small` ≈ 500 MB, `tiny` ≈ 80 MB.

## Installation (for end users)

Download the latest `RudariFlow_x.y.z_x64-setup.exe` from the [Releases](https://github.com/oggii/RudariFlow/releases) page and run it.

The installer is unsigned, so Windows SmartScreen will show an "Unknown publisher" warning — click **More info → Run anyway** to proceed. Code signing may be added in a later release.

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (MSVC toolchain on Windows)
- [Node.js](https://nodejs.org/) ≥ 20
- Visual Studio Build Tools with the C++ workload (for `cargo build`)
- CUDA Toolkit 12.x (required to compile `whisper-rs` with the `cuda` feature)

### Setup

```powershell
# 1. Clone the repo
git clone https://github.com/oggii/RudariFlow.git
cd RudariFlow

# 2. Frontend dependencies
npm install

# 3. Fetch CUDA runtime DLLs (~80 MB)
powershell -ExecutionPolicy Bypass -File scripts/setup-whisper.ps1

# 4. Run in dev mode
npm run tauri dev
```

### Production build

```powershell
npm run tauri build
```

Produces:
- `src-tauri/target/release/rudariflow.exe` (portable)
- `src-tauri/target/release/bundle/nsis/RudariFlow_x.y.z_x64-setup.exe` (NSIS installer)
- `src-tauri/target/release/bundle/msi/RudariFlow_x.y.z_x64_en-US.msi` (MSI installer)

## Architecture

- **Tauri 2** (Rust backend + Webview frontend)
- **Frontend:** Vanilla TypeScript + Vite
- **Audio capture:** [cpal](https://github.com/RustAudio/cpal) (cross-platform low-level audio I/O)
- **Transcription:** in-process [`whisper-rs`](https://github.com/tazz4843/whisper-rs) (whisper.cpp Rust bindings) with the `cuda` feature; runtime fallback to CPU
- **Auto-paste:** [enigo](https://github.com/enigo-rs/enigo) (keyboard simulation)
- **Hotkey:** [tauri-plugin-global-shortcut](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/global-shortcut)
- **Autostart:** [tauri-plugin-autostart](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/autostart)

## Licence / Credits

RudariFlow is released under the **[MIT License](LICENSE)** — free to use, modify, redistribute, and incorporate into closed-source projects, with attribution.

Initial Tauri scaffolding based on [albertshiney/typr](https://github.com/albertshiney/typr).
Uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) for transcription.

© 2026 [oggi](https://0ggi.ch).
