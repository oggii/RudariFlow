<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/RudariFlow%20White%20No%20BG.png">
    <img src="assets/RudariFlow%20No%20BG.png" alt="RudariFlow" width="360">
  </picture>
</p>

<p align="center"><em>English · <a href="README.de.md">Deutsch</a></em></p>

# RudariFlow

Local speech-to-text dictation app for Windows, powered by [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Global hotkey, hold or toggle mode, automatic paste of the transcribed text.

> **v0.16.0, Windows.** New in 0.16.0: Free GPU for games (Whisper and the AI step aside while a fullscreen game runs and come back after it), unloading when idle on mains power, a list of unused models to delete, and Whisper Large v3 Turbo q5 (0.3 GB less graphics memory). New in 0.15.0: Meetings — record an online call (Teams, Zoom, Discord …), read the live transcript with you and the others apart, and get the speakers plus AI notes (summary, decisions, action items) when it ends, all on your PC. New in 0.14.1: in the soundboard a hotkey that turns the sound hotkeys off, loops, two columns, and no more echo or beep on your voice after a sound. New in 0.14.0: a soundboard like Soundpad that plays sounds on hotkeys into Discord or a game through a virtual microphone, together with your voice (Soundboard tab, can pop out into its own window), a Free GPU hotkey that unloads Whisper and the AI model (about 5.6 GB) so a game gets the graphics card, and a Clear button in the Files tab. Since 0.12: in the Files tab, speakers (who said what, with names you set once), export as PDF, Word, subtitles (.srt, .vtt) or text, and a window that can be resized and remembers its size. Since 0.11: AI cleanup on CUDA on NVIDIA (long dictations about 30 % faster on an RTX 5080), file timestamps that stay right after pauses, names from the dictionary spelled right in long files, no more cut-off dictations from a bouncing mouse button, a space between two dictations in a row, and dictations keep their AI cleanup while a file is summarised. Since 0.10: transcribe audio and video files with an AI summary (Files tab), rewrite your last dictation by voice, a dictionary that learns from your corrections, a language per app, snippets with date and time, long dictations transcribed while you speak, a PC check that picks the fastest setup, and mouse side buttons for every hotkey. Since 0.9: AI cleanup about 30 % faster, Large v3 Turbo q8. Since 0.8: words on screen help spell names and terms. Since 0.6: Edit mode, "Write in", local AI cleanup with per-app rules, a dictionary, history, replacements and a "send it" command (see the [changelog](CHANGELOG.md)). One installer for every GPU: NVIDIA GeForce GTX 16 / RTX runs on CUDA (driver 580 or newer), AMD Radeon, Intel Arc and older NVIDIA cards run on Vulkan, and everything else falls back to the CPU. The backend is picked automatically at runtime.

See [CHANGELOG.md](CHANGELOG.md) for the full history.

Made by [oggi](https://0ggi.ch).

## Features

- **Five places in one window:** the sidebar holds Home, Files, Meetings, Soundboard and Settings, with the status above them. The window opens where you left it; only a first run (no speech model yet and no dictation so far) opens on Home, where the setup steps are
- **Home, the dictation page:** your hotkeys (Dictate, Paste last, Rewrite last, Free GPU; click a key to change it; a key box says "Not set" where there is none), the switches you change often (AI cleanup, Spoken language, Write in), what is loaded (speech model, AI model, microphone; a click opens its setting), a field that adds a word to the dictionary, and your recent dictations with a search for text or app
- **Settings in five tabs:** Dictation, AI cleanup, Dictionary, Models & GPU and General. A tab starts with what most people change; the rest is behind Advanced (General has none). A hint is one line, and "More" opens the rest. The window remembers the tab and which Advanced folds are open. What is also on Home (the hotkeys, AI cleanup, Spoken language, Write in) shows the same value in both places. Nothing is saved before the settings are read at the start (the pages rest for that moment), and a save that fails says so in a notice that lies over the bottom of the page ("Could not save: …"; it pushes nothing down, covers neither the tabs nor a page's head, and can be dismissed), and puts the control back on the saved value
- **One status:** in the sidebar and beside Home's heading, one line says what RudariFlow is doing or what is missing: "Setup needed" with the reason (no microphone, no speech model, Groq key missing, model did not load), "Downloading n %", "Recording…", "Transcribing…", "Meeting recording", "Transcribing a file", "Loading models…", "Freed for a game", "GPU freed" or "Ready". It says "Ready" only when a dictation would work: a microphone is there, and the speech model is downloaded and loaded or Groq Cloud has its key. A ring beside it marks a meeting that records or a file that runs while another state shows
- **Setup steps:** while a microphone or a speech model is missing, Home shows three steps in place of its controls: the microphone with a live level, the speech model recommended for your graphics card with a download that shows percent and size (the status says "Downloading n %" meanwhile), and your dictation key. The level runs only while you use the window (within a minute of your last touch) and never in a window that was not shown, such as a start in the tray at login. AI cleanup is offered on an optional card ("Hide" puts it away; the model can be downloaded later in Settings › AI cleanup). A PC that has never dictated is welcomed; someone who has dictated before and lacks something today (a headset that is unplugged, a cleared cloud key) sees the plain "Setup needed" with the reason, and keeps the recent dictations under the steps, with their search and every action. A dictation without a speech model records nothing and says so in the pill: "No speech model yet. Open RudariFlow to download one."
- Local transcription via in-process whisper-rs — no cloud required, no subprocess per dictation
- **Persistent model:** loaded when the app starts and reused across dictations (on battery it is unloaded after 10 minutes without dictation, on mains power after the time you choose, if any; the Free GPU hotkey unloads it whenever you want, and Free GPU for games when a game is in fullscreen)
- **Hotkey-press warmup:** if the model is not loaded, pressing the hotkey loads it in parallel so it's hot by the time you finish speaking
- **Streaming partial transcripts:** text appears in the overlay as Whisper emits each segment
- **Auto backend detection:** NVIDIA CUDA when available, otherwise Vulkan (AMD / Intel / NVIDIA), otherwise CPU. Settings › Models & GPU › Advanced shows the detected GPUs and lets you force CUDA, Vulkan or CPU. Flash attention is on for CUDA and off for Vulkan (2× slower on an RX 6800); force it with `RUDARIFLOW_FLASH_ATTN=1` or `=0`
- **PC check** (Settings › Models & GPU › Advanced): measures Whisper on every GPU with flash attention on and off, keeps the fastest setup and gives a report to copy, for hardware RudariFlow was never tested on
- **Dictionary:** a Settings tab for names, brands and jargon, with a search. Add words one at a time or paste a list (commas or one per line). Whisper gets them as its prompt, the transcript uses their exact spelling even when Whisper hears them slightly differently ("github" becomes "GitHub", "Grüß'n shop" becomes "Grüssen-Shop"), and AI cleanup gets the list too. A Swiss spelling switch writes ss instead of ß. Import and Export (under Advanced) move the list to another PC as a plain text file. **Learns from your corrections:** when you fix a name by hand right after dictating, the word is suggested at the top of the Dictionary tab to add or dismiss (only the corrected word is kept, never your text)
- **No-speech detection:** silent recordings show an overlay notice instead of pasting nothing
- **Clipboard-safe paste:** your previous clipboard contents are saved and restored around auto-paste, and dictations stay out of the Windows clipboard history (Win+V) and cloud clipboard
- **Replacements** (Settings › Dictionary, with a search): say a short phrase, get longer text, e.g. "my email" becomes your address. Matched as whole words, any capitalisation; a dictation that is only the phrase inserts just the replacement. Snippets can hold `{date}`, `{time}`, `{weekday}`, `{year}` and `{iso_date}`
- **"Send it" voice command** (Settings › Dictation › Advanced): end a dictation with "Send it." (German: "Abschicken.") as its own sentence and RudariFlow presses Enter or Ctrl+Enter after pasting. Off by default
- **History** (Home, "Recent dictations"): the last 200 dictations stay on your computer, the last 50 with their recording. Search them by text or app, copy, play, delete, or re-run a recording with the current model. Home shows the latest eight; "Show all" opens the rest on the page, 50 at a time. The list stays on Home while the setup steps show. A row says the app, the time and the length ("01:55 · 6 s"). "Copy" always shows, at the right end of every row; the other actions (Delete, Original, Play, Re-run) show to its left while the pointer is on the row or the focus is in it. "Keep history" in Settings › General sets it to text only or turns it off, and "Delete history" there empties it; "History settings" under the list leads there
- **Paste last dictation:** a second hotkey (default Alt+Shift+V) pastes your last dictation again
- **Rewrite last dictation:** a third hotkey selects your last dictation in the field, and what you say next changes it like Edit mode ("shorter", "more formal")
- **Free GPU:** a fourth hotkey (off by default; set it on Home or in Settings › Dictation › Advanced) unloads Whisper and the AI model so a game gets the graphics card's memory, about 5.6 GB with Large v3 Turbo q8 and Gemma 4 E4B. Press it again to load them; a dictation, a file or a summary also loads what it needs, the first dictation a few seconds later than usual
- **Free GPU for games** (Settings › Models & GPU › Advanced, off by default): an app in fullscreen or borderless fullscreen in front for 5 seconds unloads both models on its own; a video player in fullscreen counts too, a browser's fullscreen video, a call (Teams, Zoom, Discord), a remote desktop and the desktop do not. Dictations still work while you play: they load only Whisper (about 1 GB), paste without AI cleanup and unload it again; Edit mode and Rewrite last are off until the game is over. The game counts as running while its window stays open and fullscreen, also while you use another window (Discord on another monitor); 30 seconds after it is closed, minimised or no longer fullscreen, the models load again. Pressing the Free GPU hotkey to load them during a game keeps them loaded until it is over
- **Unload when idle** (Settings › Models & GPU › Advanced): on mains power, unload the models after 15 minutes, 30 minutes or 1 hour without a dictation (Never by default; on battery always after 10 minutes); requests to the AI from another program (the Twitch caption service) count as use
- **Unused models** (Settings › Models & GPU › Advanced): lists downloaded Whisper and AI models no setting uses and unfinished downloads, with their size, and deletes the ones you pick (after a second click); never on its own
- **Mute other apps while recording:** music and videos go quiet while you dictate and come back afterwards (off by default; not while a meeting records, which would record the silence)
- **Words on screen:** names and terms visible in the window you dictate into (a colleague's name in an email, a brand on a web page, identifiers in your editor) help Whisper and the AI spell them. Read locally when you press the hotkey, never stored
- **Edit mode:** select text in any app, hold your dictation key and say what to change ("shorter", "more formal", "in Turkish", "delete that") or say the new wording; the local model rewrites the selection in place, Ctrl+Z undoes it. Terminals, address bars and password fields are left alone
- **AI cleanup, fully local:** an AI model on your PC removes filler words, applies spoken corrections ("Tuesday, no, Wednesday"), fixes grammar and punctuation, formats lists and, in the Polished style, smooths your sentences. It keeps the language you spoke and never answers what you dictate; set "Write in" to a language and it writes every dictation in that language instead, translating when you switch languages while speaking. Per-app rules ("lowercase in WhatsApp", "formal in Outlook", "no AI in VS Code") match the program or a word in the window title, so they also work for websites, and can set the language Whisper listens for in that app. Runs Gemma 4 (E4B by default, 12B or E2B selectable) in a bundled llama.cpp server; the model downloads once (3 to 7 GB), then nothing leaves your PC. If the model is not ready or too slow, the plain Whisper text is pasted. Off by default
- Multiple Whisper models selectable (Settings › Models & GPU): tiny → large-v3-turbo, auto-downloaded on selection. "More" on the row lists all eight with size and a line about each, so a model can be read about without choosing (and downloading) it; the one recommended for this PC's graphics card is marked there and in the dropdown. The download shows on the model's row with percent and size; one that does not finish says so there with the reason (or, where none is known, the advice to check the connection) and offers Retry, and a model becomes your saved choice only once it is on disk. Large v3 Turbo q8 gave the same text as Turbo on 49 test recordings, 18 % faster and with half the memory; Large v3 Turbo q5 (~574 MB) saves about 0.3 GB more graphics memory at the same speed
- Languages: auto-detect or any of the ~100 languages Whisper supports
- **Long dictations in pieces:** every 29 s a piece is cut in a pause and transcribed while you keep speaking, so after the release only the rest is left
- **Transcribe files** (Files): drop an audio or video file on the window (MP3, M4A, WAV, FLAC, WhatsApp voice messages, MP4, MOV, MKV, WebM) and the text appears minute by minute, with timestamps and copy; the options (language, speakers) stand over the drop zone; once a file is loaded both shrink to one line each (the options' hints are behind "More"), so the transcript starts higher up, and a summary over the transcript shows its first lines with "More" for the rest; export as PDF, Word (.docx) or text, with or without timestamps and the summary on top when one is shown, or as subtitles (.srt, .vtt), always timed; separate the speakers (Auto or 2 to 8, names you set once; a 45 MB speaker model downloads on first use and runs on the CPU, about 3.5 % of the audio length on a Ryzen 9 7900X, 8 threads); the local AI model can summarise it (key points, next steps), and the summary can be hidden to give the transcript more room; "Remove transcript" empties the page for the next file (it asks "Remove transcript?" first). About 40× real time on an RX 6800. You can keep dictating while a file runs
- **Meetings** (Meetings): record an online call on this PC (Teams, Zoom, Discord, Google Meet …) with a button, the tray menu or an optional hotkey (Settings › Dictation › Advanced); nothing records on its own. RudariFlow records two tracks, your microphone ("You") and what the PC plays ("Others": Windows' default output, so it follows a headset you plug in; a call app that plays on another output device is not heard), and transcribes them live with your Whisper model, language and dictionary, about half a minute behind on a GPU (longer on the CPU); a dictation still goes first, and after a Free GPU press the recording goes on and the text catches up once the models are loaded again. Stop loads the models again when they were freed before it, for the rest of the transcript and the notes. After Stop the others are told apart (Speaker 1, 2, … with the speaker model of Files; click a name to rename it), and the local AI model writes the notes: Summary, Decisions and Action items (a checklist); with AI cleanup off there are no notes until you click Write notes. ▶ on a paragraph plays the meeting from there (not while a meeting records: it would be recorded too); export as PDF, Word, text or subtitles with the notes on top; search the library by title and transcript. A meeting cut off by a crash or by quitting is kept, and Finish transcribes the rest and writes the notes; a meeting stops by itself after 4 hours. The audio is kept for 30 days, the text until you delete the meeting. Let the others know you are recording: in Switzerland and many other places recording a conversation without their consent is illegal
- **Soundboard** (Soundboard): sounds on hotkeys for Discord and games, like Soundpad. The sounds come first, as tiles; a bar above them holds the virtual microphone's switch, Stop all, Pop out and "Soundboard settings", which opens a panel with the volumes, "Play sounds over each other", the "Sound hotkeys" switch and its key, the Stop all key and the devices (beside the sounds in a wide window; closed at first in a narrow one and in the pop-out; the window remembers what you chose). Turn on the virtual microphone and RudariFlow sends your microphone plus the sounds to the free [VB-Audio Virtual Cable](https://vb-audio.com/Cable/), which your voice app uses as its microphone ("CABLE Output"); you hear the sounds on your headphones at your own volume, never your own voice. Add AAC, FLAC, M4A, MP3, OGG, OPUS, WAV or WMA files by picker or drag and drop (up to 30 minutes each; RudariFlow keeps copies in its data folder), sort them into categories, search them, and give each a hotkey: a key (numpad and F-keys also alone), a combination or a mouse side button. A new sound replaces the playing one or plays over it, the same hotkey stops it, and a Stop all hotkey stops everything; a sound's loop button makes it repeat without a gap until you stop it; sound hotkeys are taken from other apps only while the virtual microphone is on. A "Sound hotkeys" switch, or a hotkey of its own (the pill says "Sound hotkeys off" / "on"), turns the sounds' hotkeys off so you can't play one by accident: they keep their keys but do nothing, the keys work normally in other apps again, and Stop all and clicking a sound still work. The board can pop out into its own window that can stay on top
- **Resizable window:** can be resized and maximised, never smaller than 900×600, and remembers its size and position. Every page runs from one left edge to the window's right edge, at every size, and has columns inside that width: one in a small window; from a window about 1100 px wide Home has two (controls, dictations) and the Soundboard shows its settings beside the sounds; from about 1450 px a Settings tab, the list of meetings, an open meeting (its notes, or what is said in their place, at the left; the transcript at the right; a meeting that records has nothing for the left yet, so its transcript has the whole width) and Files with a file (its options, the file and its summary at the left; the transcript at the right) are two columns; from about 1800 px Home's controls stand in two columns as well, and the setup steps stand beside the recent dictations. In the smallest window the four keys on Home stand two by two, so the recent dictations start without scrolling. A text fills its box: a transcript, notes and a summary run to the right edge of their frame, however wide the frame is
- **One way to delete:** a Delete button asks on itself: "Delete", then "Delete?". Esc, a click elsewhere or scrolling the button out of view takes the question back, and a double click or a held Enter deletes nothing. "Remove transcript" in Files and "Delete history" work the same, and a delete that fails says so on its button
- **Calm look, little motion:** one dark design with larger type and more room. The typeface is Windows' own Segoe UI, so no font ships with the app and the window requests nothing from Google Fonts. Only a page change and an opening fold move (150 ms), and nothing is animated when Windows is set to reduce motion
- **Keyboard and screen readers:** every control is reached with Tab, shows the focus and has a name; the status, the start and the end of a download, the end of a file's transcription, a save that failed and what a search found are read out. A page's title is its first heading, and a switch is a switch to a screen reader
- **Windows contrast themes:** with a contrast theme on (Settings › Accessibility in Windows) every control has an edge, and what is on or selected (a switch, a tab, the current page, a chosen chip, a sound that loops or plays, an armed Delete, a progress bar) has the theme's highlight colours
- **Hold** and **toggle** modes: hold the dictation key and speak, or press it once to start and once to stop
- Configurable global hotkeys (click a key box on Home or in Settings › Dictation and press the keys), including mouse side buttons (Mouse 4 / Mouse 5, alone or with Ctrl/Shift/Alt/Win) for all five hotkeys and the soundboard's, so one button can serve two (Mouse 5 dictates, Shift+Mouse 5 rewrites). A bound side button is consumed, so it no longer triggers "Back" / "Forward" in other apps. Ctrl+A, C, V, X, Z, Y and S are refused, since they would stop working in every app
- Floating recording pill with live waveform and cancel button, set in the window's font and colours
- Auto-paste via simulated typing (works with any application)
- System tray icon — closing the window minimises to tray instead of quitting
- Optional: start with Windows login
- UI available in English and German (auto-detected from OS locale); the window, the pill and the tray menu follow the Display Language (Settings › General) without a restart

## System Requirements

- **OS:** Windows 10/11 x64
- **GPU (recommended), current driver only, no extra runtime to install:**
  - NVIDIA GeForce GTX 16 / RTX 20 series or newer: CUDA (driver 580 or newer; with an older driver, and on older NVIDIA cards, Vulkan)
  - AMD Radeon RX 6000 or newer (AMD Software: Adrenalin Edition): Vulkan
  - Intel Arc and other Vulkan 1.2 GPUs: Vulkan
  - With an integrated and a dedicated GPU, the dedicated one is used.
- **CPU fallback:** Works without a usable GPU, but significantly slower (~10-30×). For CPU-only users we recommend the `small` or `medium` model.
- **RAM:** the selected whisper model is loaded at start and stays resident. `large-v3-turbo` ≈ 1.6 GB, `small` ≈ 500 MB, `tiny` ≈ 80 MB. On battery, the models are unloaded after 10 minutes without dictation and load again at the next hotkey press. The Free GPU hotkey unloads them on demand, e.g. before a game.
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

For a release, build in a fresh `CARGO_TARGET_DIR` of at most 4 characters (e.g. `C:\q`) with `$env:CUDAARCHS = "75;80;86;89;120"`: whisper-rs-sys does not rebuild whisper.cpp when `CUDAARCHS` or a `GGML_*` setting changes, so a reused folder keeps its old GPU and CPU targets. `src-tauri/.cargo/config.toml` sets `GGML_NATIVE=OFF`, so whisper.cpp runs on every CPU with AVX2 rather than only on CPUs like the build PC's. Check the result: `dumpbin /disasm` of `rudariflow.exe` must show no `zmm` register (AVX-512 code, which crashed 0.11.0 on processors without it). `npm run tauri build` can rewrite the line endings of `src-tauri/Cargo.toml`; if that is its only change, `git checkout -- src-tauri/Cargo.toml` afterwards.

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

### UI check

`tools/ui-check` builds the frontend and opens every page of it in headless Chromium with a mocked backend; the app is not started and no Rust is needed. It covers 113 pages: the five places, every Settings tab with its fold closed and open, the first run, the soundboard's pop-out, the pill, 65 states that are hard to reach by hand (a key box that waits for its key, a download that failed, a meeting's warnings, a file that runs, a dictation that grows in the pill, the setup steps over a history, a save the backend refuses), and what only shows over time: the start with a slow backend frame by frame, a start in which one question is never answered, a click while the settings are still loading, a change of the Display Language, a Windows contrast theme. One page visits all the others' forms and asks that every one starts on the same left edge and ends on the same right edge, and sweeps the window widths at which a page gets more columns, with the scrollbar drawn, so that no layout flips there. A state page first proves that its state is on screen, so a page that never got there fails instead of passing on the page at rest. Every page is opened in English and German. A page at rest is opened with the data of a PC in daily use and of a new one, at 2560×1392, 1600×900 and 900×600, and some add sizes of their own. A state page is opened with the data of a PC in daily use only, at 900×600 and 1600×900 (five of them at one large size more, three with a new PC's data, the pop-out's at 460×680 and the pill's at 320×64); what a page does, as opposed to how it is laid out, is tried in one view. That makes 656 views.

A run fails when something leaves its box or the page scrolls sideways, text is cut off or overlaps, text has less contrast than 4.5:1, a control has no name, is out of Tab's reach, shows no focus or is smaller than 24 px, the sidebar does not fit 900×600, a hint takes more lines than its row allows (one where the row has the room, two in a narrow column), a string is missing in one language or holds an em dash, a German string is written with ß instead of ss (except where a text names the character), a setting no longer saves from its control, the frontend lost a backend command or a control's id, or a style sheet leaves the shared standard (colours, type sizes and the typeface from the tokens, no font file, a weight Segoe UI has, motion only for a page change and a fold).

```powershell
# once: the tool's own dependencies and its browser
cd tools\ui-check; npm install; npx playwright install chromium; cd ..\..

npm run ui-check                                                    # everything, with screenshots in tools\ui-check\shots
node tools/ui-check/run.mjs --no-shots                              # the checks only, about 21 minutes
node tools/ui-check/run.mjs --no-shots --pages "home,settings-*"    # only these pages
node tools/ui-check/run.mjs --no-build --pages home --size 900x600  # one window size, with the build of the last run
node tools/ui-check/run.mjs --no-shots --times                      # also the seconds each page took
```

Exit code 0 means nothing new, 1 a finding, 2 that the run could not start (an unknown argument, a `--pages` filter that names no page). Only a run without `--pages`, `--size`, `--lang` and `--scenario` is the full check. Run one at a time: the runs share one build folder. `--task N` belongs to work that is split into numbered tasks: a finding a later task will fix can stand in `tools/ui-check/allow.json` with `until: <task>`, and `--task N` no longer accepts the entries with `until` up to N. The list is empty now and only ever shrinks.

### Tests

```powershell
npm run test:unit   # 76 tests of the frontend's pure modules (tests\unit), run by Node's own test runner
npx tsc --noEmit    # type-checks src; the unit tests are type-stripped by Node, not type-checked
```

`npm run test:unit` needs Node 22.18 or newer, which runs TypeScript files directly.

Run the Rust tests with a filter only, from `src-tauri`: `cargo test --no-default-features --lib <filter>` for the library, `--bins <filter>` for `main.rs`. Never the whole suite: the tests in `paste.rs` overwrite the system clipboard. `--no-default-features` leaves the GPU backends out, so these builds need neither the Vulkan SDK nor the CUDA Toolkit.

### Test data separate from your installed app

Settings, models and history live in `%APPDATA%\com.rudariflow.app`. To run a dev build next to an installed RudariFlow without touching its data, point it at another folder:

```powershell
$env:RUDARIFLOW_DATA_DIR = "C:\t\rf-test-data"
```

Without it a dev build uses the installed app's data and writes into its `startup.log`, or, while the installed app runs, only brings that app's window to the front and exits. A build that starts takes the keyboard focus, so do not start one while you are typing somewhere else. Work on the frontend alone (TypeScript, CSS, the UI check, the unit tests) needs only Node and no running app.

### Benchmark

```powershell
cd src-tauri
cargo run --release --example bench -- "$env:APPDATA\com.rudariflow.app\ggml-large-v3-turbo.bin" path\to\16khz-mono.wav
```

Times model load and transcription on the first GPU with and without flash attention, and on CPU.

### Conventions

- Every string of the interface exists in English and German: the window's in `src/i18n.ts`, the pill's in `NOTICE_TEXT` in `src/overlay.html`, the tray menu's in `src-tauri/src/main.rs`. The UI check fails on a key that one language lacks.
- A commit message is a subject that starts with `feat:`, `fix:`, `docs:`, `test:` or `build:`, then an empty line, then the trailers. A commit made with Claude Code ends with its `Co-Authored-By:` line; `git commit -F -` with a heredoc keeps the empty line in place.

## Architecture

- **Tauri 2** (Rust backend + Webview frontend)
- **Frontend:** Vanilla TypeScript + Vite on one `index.html`; design tokens and shared components in `src/styles`; the typeface is Windows' own Segoe UI (Segoe UI Variable on Windows 11), so no font is bundled or fetched. The window's view state (the place it was left on, open folds) is kept in the webview's local storage, settings stay in `config.json`
- **Audio capture:** [cpal](https://github.com/RustAudio/cpal) (cross-platform low-level audio I/O)
- **Transcription:** in-process [`whisper-rs`](https://github.com/tazz4843/whisper-rs) (whisper.cpp Rust bindings) built with both the `cuda` and `vulkan` features; the backend is chosen at runtime from ggml's device list, with fallback to CPU
- **AI cleanup:** [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` (release b11100: the Vulkan build plus the CUDA 13.4 backend `ggml-cuda.dll`, which uses the CUDA runtime shipped for Whisper) as a child process on 127.0.0.1 with a random port and API key, in a kill-on-close Job Object; Gemma 4 GGUF models (Apache-2.0) from Hugging Face. It runs as its own process because whisper-rs links its own copy of ggml into `rudariflow.exe`
- **Files:** Windows Media Foundation decodes audio and video files; Ogg Opus (WhatsApp voice messages), which Windows cannot open, goes through [libopus](https://opus-codec.org) via the `opus` and `ogg` crates, and Ogg Vorbis through [lewton](https://github.com/RustAudio/lewton) (resampled with [rubato](https://github.com/HEnquist/rubato))
- **Speakers:** [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) v1.12.9 (pyannote segmentation 3.0, 3D-Speaker ERes2Net), shared DLLs delay-loaded by `rudariflow.exe`
- **Export:** Word via docx-rs, PDF through WebView2's PrintToPdf
- **Soundboard:** [cpal](https://github.com/RustAudio/cpal) on WASAPI in shared mode: the microphone in, the virtual cable and the headphones out, each in its own format; the microphone reaches the cable through a buffer that keeps its delay near 20 ms when the two clocks drift. Sounds are decoded once by Media Foundation, Ogg Opus by libopus and Ogg Vorbis by [lewton](https://github.com/RustAudio/lewton) (resampled with [rubato](https://github.com/HEnquist/rubato)), to 48 kHz WAV copies, which a reader thread per playing sound streams about a second ahead
- **Meetings:** two cpal capture streams in WASAPI shared mode, the microphone (Windows' default input when the chosen one is missing) and loopback of Windows' default output, converted to 16 kHz mono and appended to two WAV files every second (silence fills a track the loopback left quiet, so both stay in step); a lost device is reopened every 3 s while the other track keeps recording. A worker cuts each growing track into 15–30 s pieces that end in a pause and transcribes them with a Whisper state of its own; a gate lets a dictation go before meeting pieces, and meeting pieces before the blocks of Files. After Stop, sherpa-onnx separates the Others track and the AI model writes the notes under three fixed headings
- **Auto-paste:** [enigo](https://github.com/enigo-rs/enigo) (keyboard simulation)
- **Hotkey:** [tauri-plugin-global-shortcut](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/global-shortcut)
- **Autostart:** [tauri-plugin-autostart](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/autostart)

## Licence / Credits

RudariFlow is released under the **[MIT License](LICENSE)** — free to use, modify, redistribute, and incorporate into closed-source projects, with attribution.

Initial Tauri scaffolding based on [albertshiney/typr](https://github.com/albertshiney/typr).
Uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) for transcription.

© 2026 [oggi](https://0ggi.ch).
