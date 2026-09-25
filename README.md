<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/RudariFlow%20White%20No%20BG.png">
    <img src="assets/RudariFlow%20No%20BG.png" alt="RudariFlow" width="360">
  </picture>
</p>

<p align="center"><em>English · <a href="README.de.md">Deutsch</a></em></p>

# RudariFlow

Local speech-to-text dictation app for Windows, powered by [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Global hotkey, push-to-talk or toggle mode, automatic paste of the transcribed text.

> **v0.12.0, Windows.** New in the Files tab: speakers (who said what, with names you set once), export as PDF, Word, subtitles (.srt, .vtt) or text, and a window that can be resized and remembers its size. Since 0.11: AI cleanup on CUDA on NVIDIA (long dictations about 30 % faster on an RTX 5080), file timestamps that stay right after pauses, names from the dictionary spelled right in long files, no more cut-off dictations from a bouncing mouse button, a space between two dictations in a row, and dictations keep their AI cleanup while a file is summarised. Since 0.10: transcribe audio and video files with an AI summary (Files tab), rewrite your last dictation by voice, a dictionary that learns from your corrections, a language per app, snippets with date and time, long dictations transcribed while you speak, a PC check that picks the fastest setup, and mouse side buttons for every hotkey. Since 0.9: AI cleanup about 30 % faster, Large v3 Turbo q8. Since 0.8: words on screen help spell names and terms. Since 0.6: Edit mode, "Write in", local AI cleanup with per-app rules, a dictionary, history, replacements and a "send it" command (see the [changelog](CHANGELOG.md)). One installer for every GPU: NVIDIA GeForce GTX 16 / RTX runs on CUDA (driver 580 or newer), AMD Radeon, Intel Arc and older NVIDIA cards run on Vulkan, and everything else falls back to the CPU. The backend is picked automatically at runtime.

See [CHANGELOG.md](CHANGELOG.md) for the full history.

Made by [oggi](https://0ggi.ch).

## Features

- Local transcription via in-process whisper-rs — no cloud required, no subprocess per dictation
- **Persistent model:** loaded when the app starts and reused across dictations (on battery it is unloaded after 10 minutes without dictation)
- **Hotkey-press warmup:** if the model is not loaded, pressing the hotkey loads it in parallel so it's hot by the time you finish speaking
- **Streaming partial transcripts:** text appears in the overlay as Whisper emits each segment
- **Auto backend detection:** NVIDIA CUDA when available, otherwise Vulkan (AMD / Intel / NVIDIA), otherwise CPU. Settings show the detected GPUs and let you force CUDA, Vulkan or CPU. Flash attention is on for CUDA and off for Vulkan (2× slower on an RX 6800); force it with `RUDARIFLOW_FLASH_ATTN=1` or `=0`
- **PC check** (Engine tab): measures Whisper on every GPU with flash attention on and off, keeps the fastest setup and gives a report to copy, for hardware RudariFlow was never tested on
- **Dictionary:** its own tab for names, brands and jargon. Add words one at a time or paste a list (commas or one per line). Whisper gets them as its prompt, the transcript uses their exact spelling even when Whisper hears them slightly differently ("github" becomes "GitHub", "Grüß'n shop" becomes "Grüssen-Shop"), and AI cleanup gets the list too. A Swiss spelling switch writes ss instead of ß. Import and Export move the list to another PC as a plain text file. **Learns from your corrections:** when you fix a name by hand right after dictating, the word is suggested in the Dictionary tab to add or dismiss (only the corrected word is kept, never your text)
- **No-speech detection:** silent recordings show an overlay notice instead of pasting nothing
- **Clipboard-safe paste:** your previous clipboard contents are saved and restored around auto-paste, and dictations stay out of the Windows clipboard history (Win+V) and cloud clipboard
- **Replacements:** say a short phrase, get longer text, e.g. "my email" becomes your address. Matched as whole words, any capitalisation; a dictation that is only the phrase inserts just the replacement. Snippets can hold `{date}`, `{time}`, `{weekday}`, `{year}` and `{iso_date}`
- **"Send it" voice command:** end a dictation with "Send it." (German: "Abschicken.") as its own sentence and RudariFlow presses Enter or Ctrl+Enter after pasting. Off by default
- **History:** the last 200 dictations stay on your computer, the last 50 with their recording. Copy, play, delete, or re-run a recording with the current model. Can be set to text only or turned off
- **Paste last transcript:** a second hotkey (default Alt+Shift+V) pastes your last dictation again
- **Rewrite last dictation:** a third hotkey selects your last dictation in the field, and what you say next changes it like Edit mode ("shorter", "more formal")
- **Mute other apps while recording:** music and videos go quiet while you dictate and come back afterwards (off by default)
- **Words on screen:** names and terms visible in the window you dictate into (a colleague's name in an email, a brand on a web page, identifiers in your editor) help Whisper and the AI spell them. Read locally when you press the hotkey, never stored
- **Edit mode:** select text in any app, hold the hotkey and say what to change ("shorter", "more formal", "in Turkish", "delete that") or say the new wording; the local model rewrites the selection in place, Ctrl+Z undoes it. Terminals, address bars and password fields are left alone
- **AI cleanup, fully local:** a language model on your PC removes filler words, applies spoken corrections ("Tuesday, no, Wednesday"), fixes grammar and punctuation, formats lists and, in the Polished style, smooths your sentences. It keeps the language you spoke and never answers what you dictate; set "Write in" to a language and it writes every dictation in that language instead, translating when you switch languages while speaking. Per-app rules ("lowercase in WhatsApp", "formal in Outlook", "no AI in VS Code") match the program or a word in the window title, so they also work for websites, and can set the language Whisper listens for in that app. Runs Gemma 4 (E4B by default, 12B or E2B selectable) in a bundled llama.cpp server; the model downloads once (3 to 7 GB), then nothing leaves your PC. If the model is not ready or too slow, the plain Whisper text is pasted. Off by default
- Multiple Whisper models selectable: tiny → large-v3-turbo, auto-downloaded on selection. Large v3 Turbo q8 gave the same text as Turbo on 49 test recordings, 18 % faster and with half the memory
- Languages: auto-detect or any of the ~100 languages Whisper supports
- **Long dictations in pieces:** every 29 s a piece is cut in a pause and transcribed while you keep speaking, so after the release only the rest is left
- **Transcribe files** (Files tab): drop an audio or video file on the window (MP3, M4A, WAV, FLAC, WhatsApp voice messages, MP4, MOV, MKV, WebM) and the text appears minute by minute, with timestamps and copy; export as PDF, Word (.docx) or text, with or without timestamps and the summary on top when one is shown, or as subtitles (.srt, .vtt), always timed; separate the speakers (Auto or 2 to 8, names you set once; a 45 MB speaker model downloads on first use and runs on the CPU, about 3.5 % of the audio length on a Ryzen 9 7900X, 8 threads); the local AI model can summarise it (key points, next steps), and the summary can be hidden to give the transcript more room. About 40× real time on an RX 6800. You can keep dictating while a file runs
- **Resizable window:** can be resized and maximised, never smaller than 900×600, and remembers its size and position
- **Push-to-talk** and **toggle** modes
- Configurable global hotkeys (capture any chord from the settings UI), including mouse side buttons (Mouse 4 / Mouse 5, alone or with Ctrl/Shift/Alt/Win) for all three hotkeys, so one button can serve two (Mouse 5 dictates, Shift+Mouse 5 rewrites). A bound side button is consumed, so it no longer triggers "Back" / "Forward" in other apps. Ctrl+A, C, V, X, Z, Y and S are refused, since they would stop working in every app
- Floating recording pill with live waveform and cancel button
- Auto-paste via simulated typing (works with any application)
- System tray icon — closing the window minimises to tray instead of quitting
- Optional: start with Windows login
- UI available in English and German (auto-detected from OS locale)

## System Requirements

- **OS:** Windows 10/11 x64
- **GPU (recommended), current driver only, no extra runtime to install:**
  - NVIDIA GeForce GTX 16 / RTX 20 series or newer: CUDA (driver 580 or newer; with an older driver, and on older NVIDIA cards, Vulkan)
  - AMD Radeon RX 6000 or newer (AMD Software: Adrenalin Edition): Vulkan
  - Intel Arc and other Vulkan 1.2 GPUs: Vulkan
  - With an integrated and a dedicated GPU, the dedicated one is used.
- **CPU fallback:** Works without a usable GPU, but significantly slower (~10-30×). For CPU-only users we recommend the `small` or `medium` model.
- **RAM:** the selected whisper model is loaded at start and stays resident. `large-v3-turbo` ≈ 1.6 GB, `small` ≈ 500 MB, `tiny` ≈ 80 MB. On battery, the models are unloaded after 10 minutes without dictation and load again at the next hotkey press.
- **AI cleanup (optional):** runs on the same card as Whisper, with the normal driver: through CUDA on NVIDIA GeForce GTX 16 / RTX 20 and newer (driver 580 or newer), through Vulkan on AMD, Intel and older NVIDIA cards. The default model takes about 3.6 GB of video memory on top of Whisper plus about 3.3 GB of RAM (its per-layer embeddings stay in RAM), so 8 GB cards and up are fine; smaller cards move part of the model to the CPU. Measured: about 0.3 s per dictation on an AMD Radeon RX 6800 (Vulkan), about 0.09 s on an NVIDIA GeForce RTX 5080 (CUDA; long dictations about 30 % faster than through Vulkan). Intel Arc uses the Vulkan path but has not been tested yet. Without a usable GPU expect 5 to 10 s per dictation.

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
- [CUDA Toolkit 13.x](https://developer.nvidia.com/cuda-downloads) (13.4, the version of the bundled llama.cpp CUDA backend; the compiler and cuBLAS components are enough, no NVIDIA GPU needed to build)

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

# 3b. Fetch the llama.cpp server used for AI cleanup: the Vulkan build and its
#     CUDA backend (pinned builds, SHA-256 checked)
powershell -ExecutionPolicy Bypass -File scripts/setup-llama.ps1

# 3c. Unpack whisper-rs-sys and apply the whisper.cpp patches in patches\
powershell -ExecutionPolicy Bypass -File scripts/setup-whisper-patch.ps1

# 3d. Fetch the sherpa-onnx runtime for speaker separation (pinned, SHA-256 checked)
powershell -ExecutionPolicy Bypass -File scripts/setup-speakers.ps1

# 4. Keep the build path short: whisper.cpp's nested Vulkan shader build
#    exceeds the 260-character path limit under src-tauri\target (and still
#    under C:\t\rf unless Windows long paths are enabled)
$env:CARGO_TARGET_DIR = "C:\r"
$env:CUDAARCHS = "75;80;86;89;120"   # RTX 20, 30, A-series, 40, 50

# 5. Run in dev mode
npm run tauri dev
```

Without a CUDA Toolkit you can still build and run a Vulkan-only binary:
`npm run tauri dev -- --no-default-features --features vulkan`.

`cargo run`, examples and dev builds need `src-tauri\binaries\sherpa-onnx\lib` on PATH for
speaker separation (the installer puts the DLLs next to the exe).

### Production build

```powershell
npm run tauri build
```

For a release, build in a fresh `CARGO_TARGET_DIR` of at most 4 characters (e.g. `C:\q`) with `$env:CUDAARCHS = "75;80;86;89;120"`: whisper-rs-sys does not rebuild whisper.cpp when `CUDAARCHS` or a `GGML_*` setting changes, so a reused folder keeps its old GPU and CPU targets. `src-tauri/.cargo/config.toml` sets `GGML_NATIVE=OFF`, so whisper.cpp runs on every CPU with AVX2 rather than only on CPUs like the build PC's.

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
- **AI cleanup:** [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` (release b11100: the Vulkan build plus the CUDA 13.4 backend `ggml-cuda.dll`, which uses the CUDA runtime shipped for Whisper) as a child process on 127.0.0.1 with a random port and API key, in a kill-on-close Job Object; Gemma 4 GGUF models (Apache-2.0) from Hugging Face. It runs as its own process because whisper-rs links its own copy of ggml into `rudariflow.exe`
- **Files:** Windows Media Foundation decodes audio and video files; Ogg Opus (WhatsApp voice messages), which Windows cannot open, goes through [libopus](https://opus-codec.org) via the `opus` and `ogg` crates
- **Speakers:** [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) v1.12.9 (pyannote segmentation 3.0, 3D-Speaker ERes2Net), shared DLLs delay-loaded by `rudariflow.exe`
- **Export:** Word via docx-rs, PDF through WebView2's PrintToPdf
- **Auto-paste:** [enigo](https://github.com/enigo-rs/enigo) (keyboard simulation)
- **Hotkey:** [tauri-plugin-global-shortcut](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/global-shortcut)
- **Autostart:** [tauri-plugin-autostart](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/autostart)

## Licence / Credits

RudariFlow is released under the **[MIT License](LICENSE)** — free to use, modify, redistribute, and incorporate into closed-source projects, with attribution.

Initial Tauri scaffolding based on [albertshiney/typr](https://github.com/albertshiney/typr).
Uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) for transcription.

© 2026 [oggi](https://0ggi.ch).
