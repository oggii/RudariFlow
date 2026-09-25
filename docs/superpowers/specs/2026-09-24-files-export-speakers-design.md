# RudariFlow Files tab: export, speakers, a resizable window

**Date:** 2026-09-24
**Target release:** 0.12.0
**Branch:** `feature/files-export-speakers`, based on `main` after 0.11.0
**Status:** design approved in discussion, spec awaiting review

## Context

The Files tab (0.10.0) turns an audio or video file into text, minute by minute, with optional timestamps, copy, "Save as text…" and an AI summary. Three things are missing for meetings and interviews:

- The text can only be saved as `.txt`. People want a PDF to send, a Word file to edit into minutes, and subtitles for videos.
- Nothing says who spoke. In an interview or meeting the transcript is one voice.
- The main window is fixed at 900×600 (since 0.1.0). A long transcript is read through a small box.

Decisions from the design discussion:

- **Round 1 is export and speakers**, plus the window. A player with click-to-jump, editing, search, AI chapters, a file queue and file history are round 2.
- **Speakers:** a selector next to Language: Off (default), Auto, 2 to 8. Remembered.
- **Labels:** a paragraph per speaker turn, `[0:14] Speaker 2: …`, with names renamed once via chips above the text.
- **Export:** one "Export ▾" menu that follows the screen (the Timestamps switch, the names shown, the summary if there is one).
- **Window:** resizable and maximisable, never smaller than 900×600, size remembered.
- **Technology:** sherpa-onnx for speaker separation, WebView2's print-to-PDF for PDF, docx-rs for Word, `tauri-plugin-window-state` for the window.

## Goals

- Pick the number of speakers (or Auto) before transcribing; get a transcript whose paragraphs say who speaks, with names you can set once.
- Export the transcript as PDF, Word (.docx), subtitles (.srt, .vtt) or text, with the timestamps, names and summary you see.
- Read long transcripts in a window as large as the screen.
- Everything stays on the PC; the only download is the speaker model, once.

## Non-goals

- Player, click-to-jump, editing, find and replace, uncertain-word marks (round 2).
- AI chapters, action items, questions to the file, summary options (round 2).
- File queue, file history, Explorer context menu, transcribing a range, recording meetings (round 2).
- Recognising the same person across files (voice profiles).
- Labelling overlapping speech: when two people talk at once, the segment goes to one of them.
- Speaker separation on the GPU.

## Architecture

### Module changes

| Module | Change |
|---|---|
| `src-tauri/src/speakers.rs` (new) | Speaker model files, download, `separate(audio, count) -> Vec<Turn>` via sherpa-onnx, `assign(segments, turns)` |
| `src-tauri/src/file_transcribe.rs` | Runs speaker separation next to Whisper; `Segment` gains `speaker`; `format` takes names and starts a paragraph at a speaker change |
| `src-tauri/src/export.rs` (new) | Text, SRT, VTT and DOCX writers, the HTML for the PDF, subtitle cue splitting |
| `src-tauri/src/pdf.rs` (new) | Hidden webview window, WebView2 `PrintToPdf` |
| `src-tauri/src/main.rs` | `transcribe_file` returns segments and speaker count; new commands `format_file_text`, `export_file`, `speaker_model_status`, `speaker_model_download` |
| `src-tauri/src/settings.rs` | `file_speakers` |
| `src/files.ts` | Speakers selector, name chips, Export menu, collapsible summary |
| `index.html`, `src/style.css`, `src/i18n.ts` | Controls, layout for a resizable window, strings (EN, DE) |
| `src-tauri/tauri.conf.json`, `Cargo.toml`, capabilities | Window size limits, window-state plugin, new crates |

### Speakers: model

sherpa-onnx's offline speaker diarization: pyannote's segmentation model 3.0 (about 6 MB, finds where speech and speaker changes are) and a speaker embedding model (about 25 to 40 MB, turns a stretch of speech into a voice fingerprint), then clustering. With a number, clustering makes exactly that many speakers; with Auto it uses a distance threshold.

**Model choice (probe, 2026-09-24, sherpa-onnx v1.12.9 CLI, Ryzen 9 7900X).** Four embedding models on three files with known answers: sherpa's 4-speaker demo (real voices), the meeting test file (two TTS voices, turns 40 to 60 s apart) and a fast dialog (the same two voices, 8 turns 0.4 s apart):

| Embedding model | 4 speakers | meeting A/B/A | fast dialog | 7 min, 8 threads |
|---|---|---|---|---|
| 3D-Speaker ERes2Net base (37.7 MB) | 4, same order as TitaNet | right | 3 turns of 8 | 35 s |
| NeMo TitaNet-small (38.3 MB) | 4, same order as ERes2Net | right | one speaker | 24 s |
| WeSpeaker ResNet34-LM (25.3 MB) | 4, other order | right | one speaker | 32 s |
| 3D-Speaker CAM++ (28.2 MB) | 3 | wrong | 5 turns, wrong | 23 s |

**3D-Speaker ERes2Net** is used. No model separates two similar synthetic female voices that alternate within half a second; real voices differ more. **Auto** uses a clustering threshold of **0.9**, the only one that counted 4, 2 and 2 on the three files. `min_duration_on` 0.3 s and `min_duration_off` 0.5 s (sherpa-onnx's defaults, used in the probe). The int8 segmentation model is not faster.

**Speed:** separation takes about 8 % of the audio length with 8 threads (1 thread: 24 %; 12 threads are not faster than 8): about 50 s for a 10-minute meeting, 5 minutes for an hour. That is far longer than Whisper on a GPU, so separation gets its own progress ("Separating speakers… 40 %"). Threads: half the logical CPUs, at most 8. sherpa-onnx's GPU build needs NVIDIA's cuDNN and there is no DirectML build, so it stays on the CPU.

**Integration.** The `sherpa-rs` wrapper hard-codes one thread, so RudariFlow uses its raw bindings `sherpa-rs-sys` 0.6.8 (sherpa-onnx v1.12.9) with its own small wrapper. The static Windows build of sherpa-onnx uses the static C runtime, which clashes with the rest of the app, so the shared build (`win-x64-shared-no-tts`, SHA-256 pinned) is used: `sherpa-onnx-c-api.dll` and `onnxruntime.dll` ship next to `rudariflow.exe`, never relying on a system `onnxruntime.dll` (Windows 11 has one in System32 for Windows ML). `rudariflow.exe` delay-loads `sherpa-onnx-c-api.dll`, like `nvcuda.dll`: a missing DLL only turns speaker separation off, it never stops the app.

Files: `<app dir>\speakers\segmentation.onnx` (pyannote segmentation 3.0, 5.99 MB, from Hugging Face `csukuangfj/sherpa-onnx-pyannote-segmentation-3-0`, SHA-256 `220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079`) and `<app dir>\speakers\embedding.onnx` (`3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx` from the sherpa-onnx `speaker-recongition-models` release, SHA-256 `1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b`), downloaded with the existing resumable downloader and checked. The download starts when Auto or a number is picked for the first time, with progress next to the selector; a file started before it finishes waits for it ("Downloading the speaker model…").

### Speakers: pipeline

In `transcribe_file`, after decoding (16 kHz mono in memory):

1. `file_speakers` is Off: as today.
2. Otherwise a thread runs `speakers::separate` on the whole audio (CPU) while the Whisper blocks run (GPU). The text keeps streaming into the box minute by minute, without labels.
3. After the last Whisper block the worker waits for the thread; the status says "Separating speakers… n %" (from sherpa-onnx's progress callback) while it waits. Cancel stops the file after the current step; the separation's result is then dropped.
4. `speakers::assign` gives every Whisper segment the speaker with the most overlap in time. A segment that overlaps no turn gets the nearest turn's speaker; a tie goes to the speaker who spoke first.
5. Speakers are numbered by their first segment: the first voice is Speaker 1.
6. If separation fails (model missing, error), the transcript comes without labels and the status says so. The transcript is never dropped for it.

### Speakers: paragraphs, names, summary

- `format(segments, names, times)`: a new paragraph starts at a speaker change, besides the existing rules (a pause of 2 s, a long paragraph at a sentence end). A paragraph starts with the name: `[0:14] Saad: …`, or `Saad: …` without times.
- Names are held by the Files tab for the transcript on screen ("Speaker 1", "Speaker 2", … until renamed). A chip per speaker above the text; clicking it edits the name in place; Enter or leaving the field applies it, an empty name goes back to "Speaker N". Renaming reformats the text through `format_file_text`.
- The summary request gets the text with names (without times), so it can say who decided or promised what.

### Export

The Export menu replaces "Save as text…": PDF…, Word (.docx)…, Subtitles (.srt)…, Subtitles (.vtt)…, Text (.txt)…. The save dialog proposes the audio file's name with the new extension. `export_file(kind, path, segments, names, times, summary, header)` writes the file; an error shows in the status line.

What goes in follows the screen: the Timestamps switch (PDF, Word, Text; subtitles are always timed), the names as shown, the summary above the transcript when one is shown and not an error.

Header (PDF, Word): file name as title; a line with audio length, language, number of speakers (when separated) and the date of the transcription.

**PDF.** `export.rs` builds an HTML page (inline CSS, no network); `pdf.rs` loads it into a hidden webview window and calls WebView2's `ICoreWebView2_7::PrintToPdf` with the chosen path, then closes the window. Paper: A4, Letter when the Windows region is the US or Canada; margins 20 mm; system fonts (Segoe UI with fallbacks), so every script Windows can show prints; page numbers "n / total" in the footer through CSS `@page` margin boxes; timestamps grey, names bold; `orphans` and `widows` 2.

**Word.** docx-rs: title, the header line, "Summary" and "Transcript" as Heading 1, one paragraph per transcript paragraph, the name bold and the time grey at its start.

**Subtitles.** One cue per piece of a Whisper segment: a segment longer than two lines of 42 characters is split at a sentence end, else a comma, else a space, and the segment's time is shared out by characters. Cues last at least 1 s (shortened only where the next cue starts). SRT: numbered cues, `HH:MM:SS,mmm`, the name as "Saad: " before the text. VTT: `WEBVTT` header, `HH:MM:SS.mmm`, the name as a voice tag `<v Saad>`.

**Text.** What the transcript box shows, with the summary above it when present, as "Save as text…" does today.

### Window

- `tauri.conf.json`, main window: `resizable: true`, `maximizable: true`, `minWidth: 900`, `minHeight: 600`.
- `tauri-plugin-window-state` for the main window only (size, position, maximised). On start, a saved position that is on no current monitor is replaced by the centre of the primary monitor (check the plugin, else do it in `setup`).
- CSS: the sidebar keeps its width; settings sections keep their current width, centred; the Files tab is a column that fills the height: file controls and the action row at the top, the transcript box takes the rest, the summary box can be collapsed.
- The recording pill (overlay window) is unchanged.

## Settings & migration

- `file_speakers: String`, `"off"` | `"auto"` | `"2"` … `"8"`, serde default `"off"`. Old configs load unchanged.
- The window-state plugin keeps its own file in the app data folder.

## UI (Files tab)

- Language and Speakers selectors side by side.
- After a run with speakers: a "Speakers:" row of chips above the text.
- Action row: Timestamps switch, Copy, Export ▾, Summarise with AI.
- Strings in English and German.

## Privacy

- The speaker model downloads once from the sherpa-onnx GitHub releases; audio and text never leave the PC.
- Names typed for speakers live only with the transcript on screen and in the files you export.

## Tests

- **Unit:** `assign` (overlap, gaps, ties, numbering by first appearance); `format` with names (paragraph at a speaker change, with and without times); subtitle cue splitting and time sharing; SRT and VTT time formats and voice tags; DOCX writer (the file unzips and `word/document.xml` has the text and names); the PDF HTML (header, names, times on and off, escaping).
- **Live, through the test hooks:** the two-voice test file must come out Speaker 1 / Speaker 2 / Speaker 1 with 2 and with Auto; the 23-minute file measured for separation time on the Ryzen 7900X; each export saved and read back (PDF text extracted, including umlauts and a Chinese sample; DOCX XML; SRT/VTT parsed).
- **Window:** every tab at 900×600, a middle size and maximised on a 1440p screen; restart restores size and position; a saved position on a missing monitor opens centred.

## Risks

- **Size and DLLs:** `sherpa-onnx-c-api.dll` and `onnxruntime.dll` add about 20 MB to the installer. Load-order conflicts with a system `onnxruntime.dll` are avoided by shipping the DLLs next to the exe (the application folder is searched first).
- **Speed:** separation takes about 8 % of the audio length on a 12-core desktop, more on a laptop; the progress shows it.
- **Accuracy:** similar voices, short interjections and overlapping speech get wrong labels. A given number helps; the chips make renaming cheap, but a wrong label can only be fixed by editing (round 2).
- **PrintToPdf:** needs WebView2 runtime 1.0.1185 or newer (Windows 10/11 have current ones); `@page` margin boxes need a recent Chromium (WebView2 153 here). Without them the PDF has no page numbers, nothing else changes.
