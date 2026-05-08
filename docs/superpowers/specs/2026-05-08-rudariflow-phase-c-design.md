# RudariFlow Phase C — Surgical Wins

**Date:** 2026-05-08
**Target release:** v0.3.0
**Status:** approved design, ready for implementation plan

## Context

RudariFlow is a Tauri (Rust + TS) push-to-talk dictation app for Windows. The current architecture records audio with `cpal`, writes a 16 kHz WAV to disk, and spawns `whisper-cli.exe` (CUDA or CPU, auto-detected) per dictation. This phase ships the cheap, high-ROI fixes that don't require touching that architecture. A separate phase B will replace the subprocess with in-process `whisper-rs` bindings.

Primary user runs `large-v3-turbo` on NVIDIA CUDA, dictates in EN + DE + technical jargon. Reported pain across all four axes: per-dictation latency, accuracy/hallucinations, install size/RAM, cold-start.

## Goals

- Land measurable accuracy wins for code/jargon-heavy dictation (custom vocabulary, deterministic decoding).
- Eliminate the most common hallucination class (silence-induced filler text).
- Stop clobbering the user's clipboard.
- Stop force-injecting punctuation that's wrong in chat/code/search contexts.
- Cut install size by removing 14 unused bundled binaries per backend.
- Fix the Groq language bug.

## Non-goals

- No latency overhaul (queued for phase B).
- No persistent whisper-server, no in-process bindings (phase B).
- No new bundled models or binaries.
- No new UI panels — only one new field in the existing settings page.
- No streaming/partial transcription, no recording history, no error-toast framework beyond a single "no speech" event.

## Changes

### 1. Custom vocabulary prompt

**Problem:** Whisper guesses badly on proper nouns, library names, acronyms, and German loanwords in EN-mixed speech. The `--prompt` initial-prompt parameter biases the decoder; up to 224 tokens. Currently unused.

**Change:**
- Add `custom_prompt: String` to `Settings` (`src-tauri/src/settings.rs`), default `""`, `#[serde(rename = "customPrompt", default)]`.
- In `transcribe_local::transcribe_local` (`src-tauri/src/transcribe_local.rs`), when the prompt is non-empty, append two args via `cmd.arg("--prompt").arg(&custom_prompt)`. Each `arg()` call is a separate argv element, so no shell-quoting concerns regardless of the prompt's contents.
- In `transcribe_groq::transcribe_groq` (`src-tauri/src/transcribe_groq.rs`), when non-empty, add `.text("prompt", custom_prompt)` to the multipart form.
- Threading: `recorder::run_transcription_pipeline` passes `settings.custom_prompt` through to both transcribe functions.
- Frontend (`src/main.ts`): add a `<textarea>` to the settings page, label "Custom vocabulary", placeholder "Names, acronyms and jargon you dictate often". No client-side validation beyond `maxlength="2000"` (whisper truncates to 224 tokens regardless).
- i18n (`src/i18n.ts`): add `customPrompt.label` and `customPrompt.hint` for EN and DE.

### 2. Energy-gate silence trim

**Problem:** Hotkey recordings often contain ~500 ms silence at start/end. Whisper hallucinates filler text ("Thanks for watching!", "Untertitel im Auftrag des ZDF...") on near-silent input. This is the #1 cause of bogus transcriptions on short clips.

**Change:**
- New function `audio::trim_silence(samples: &[f32], sample_rate: u32) -> Option<(usize, usize)>` returning `Some((start, end))` indices into the buffer, or `None` if the entire buffer is below threshold.
- Algorithm: 20 ms windows (= `sample_rate / 50` samples). Compute RMS per window. Threshold: `0.005` (≈ −46 dBFS). First/last window above threshold = speech bounds. Pad ±200 ms (clamped to buffer edges).
- Called from `AudioRecorder::stop_and_save` after channel mix-down, before resample.
- If `trim_silence` returns `None`: `stop_and_save` returns the sentinel `Err("no_speech".to_string())`. `recorder::run_transcription_pipeline` matches this specific string before the generic error path; on match it emits a new event `audio-empty` (no payload), removes the temp WAV, and returns `Ok(String::new())` so no paste happens and no error toast fires. Frontend's overlay listens for `audio-empty` and shows a brief "no speech detected" message before fading out. Other `stop_and_save` errors continue to propagate as before.
- Constants live as `const TRIM_RMS_THRESHOLD: f32 = 0.005;` and `const TRIM_PAD_MS: u32 = 200;` in `audio.rs`. Tunable later without API change.

### 3. Clipboard save/restore

**Problem:** Auto-paste sets clipboard → Ctrl+V → leaves our text in the clipboard, clobbering whatever the user had.

**Change:**
- In `paste::paste_text`:
  1. Read existing clipboard text via `arboard::Clipboard::get_text()`. Wrap in `Result`; on error (non-text content like images/files) treat the original as `None`.
  2. Set our text. Sleep 50 ms (existing).
  3. Simulate Ctrl+V (existing).
  4. Sleep 100 ms to let the target app actually consume the paste.
  5. Restore: if original was `Some(text)`, `set_text(text)`. Otherwise leave our text — best-effort.
- Extract step 5 into `restore_clipboard(prev: Option<String>)` for testability.
- Known limitation, documented in code comment: if the clipboard held an image, files, or HTML rich-text, we can only restore text or leave our text. Documented behaviour.

### 4. Drop forced terminal period

**Problem:** `cleanup::cleanup_text` always appends `.` if there's no terminal punctuation. Wrong in chat boxes, code editors, search bars, single-word commands.

**Change:**
- Remove the trailing-punctuation block (`cleanup.rs:30-34`).
- Keep: trim, whitespace-collapse, capitalise first letter of each sentence (after `.`/`!`/`?`).
- Update tests:
  - Delete `test_ensure_ending_punctuation`.
  - Rename `test_preserve_existing_ending_punctuation` → `test_preserves_existing_punctuation`, assert no period is added when input has none (`cleanup_text("hello world")` → `"Hello world"`).
  - Update `test_trim_whitespace`, `test_normalize_spaces`, `test_capitalize_first_letter` to expect no trailing period.
  - Update `test_already_clean` to use input that already has a period.

### 5. Bundle pruning

**Problem:** `tauri.conf.json` ships every file in `binaries/whisper-cuda/` and `binaries/whisper-cpu/` via wildcard. 14 unused exes per backend, plus `SDL2.dll` (only used by stream/talk-llama) and likely `nvblas64_12.dll`. Saves ~10–15 MB on each side and clarifies the trust boundary.

**Change:**
- Replace the `resources` glob in `src-tauri/tauri.conf.json` with explicit per-file entries.
- **CPU bundle:** `whisper-cli.exe`, `whisper.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-cpu.dll`.
- **CUDA bundle:** the CPU set plus `ggml-cuda.dll`, `cudart64_12.dll`, `cublas64_12.dll`, `cublasLt64_12.dll`, `nvrtc64_120_0.dll`, `nvrtc-builtins64_124.dll`.
- Verification: after install, run a transcription on each backend in dev. If `whisper-cli.exe` fails at process start with a missing-DLL error, add the DLL back and commit the minimal working set. Capture both happy-path runs in the manual test checklist.
- `scripts/setup-whisper.ps1` is unchanged — full payloads still download for development convenience. Pruning happens at bundle time only.

### 6. Groq language bug

**Problem:** `transcribe_groq.rs:19` hardcodes `.text("language", "en")`. Ignores `settings.language`. Breaks DE/FR/IT/ES users on the cloud path.

**Change:**
- `transcribe_groq` gains a `language: &str` parameter.
- If `language == "auto"`, omit the `language` form field (Groq detects automatically).
- Otherwise pass through.
- Caller in `recorder::run_transcription_pipeline` passes `&settings.language`.

### 7. Deterministic decoding flags

**Problem:** Default whisper-cli decoding can fall back to higher temperatures on low-confidence segments, re-decoding them at temperatures 0.2 / 0.4 / … This is both nondeterministic and costs roughly 2× wall-clock on segments that hit the fallback. For dictation we prefer deterministic single-pass.

**Change:**
- In `transcribe_local::transcribe_local`, append `--temperature 0.0 --best-of 1` to the command line.
- No setting; this is a tuning constant. If accuracy regresses on noisy input, revisit before release.
- Side benefit: ~10–30% faster decode on real-world dictations.

### 8. CPU thread tuning

**Problem:** whisper-cli defaults to 4 threads. On modern multi-core machines using the CPU fallback (no NVIDIA GPU), this leaves a lot of cores idle and makes transcription unnecessarily slow. The CUDA path doesn't benefit (compute happens on the GPU), so we only override for CPU.

**Change:**
- In `transcribe_local::transcribe_local`, when `backend == "cpu"`, compute `let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);` and append `-t <threads>` to the command line.
- Cap at 8: whisper.cpp typically saturates around that on x86 — more threads contend on memory bandwidth and hurt throughput.
- No new dependency: `std::thread::available_parallelism` is in std.
- Logical cores are good enough; hyperthreading hurts a little on whisper but not enough to justify a `num_cpus` dep for physical-core counting.

### 9. Idle-posture audit + baseline

**Problem:** Before Phase B reshapes runtime resource use, we want a documented baseline so we can prove improvement (or catch regressions). Code inspection suggests idle should already be cheap — cpal stream is dropped on stop, sample buffer cleared, no model loaded — but it's never been measured.

**Change:**
- Not a code change. A measurement task during the v0.3.0 release.
- Author runs the installed app on the primary CUDA machine and records, in `docs/superpowers/specs/2026-05-08-rudariflow-phase-c-design.md` under a "Baseline measurements" appendix:
  - Idle CPU % (10 s sample, Task Manager) for `RudariFlow.exe` and any spawned children.
  - Idle private working set (RAM) for the same processes.
  - Recording CPU % during a 5 s dictation.
  - Peak RAM during transcription with `large-v3-turbo` on CUDA.
  - Same set on a CPU-only machine if available.
- If anything looks unexpectedly high (e.g. >2% idle CPU, >300 MB idle RAM beyond the two webviews), that becomes a bug ticket — not blocking the release, but documented.
- These numbers become the "before" column when Phase B ships.

## Architecture & data flow

No change. Sequence remains:

```
hotkey → recorder.start_recording → cpal stream
       → recorder.stop_and_transcribe
         → audio.stop_and_save (NEW: trim_silence → mono → resample → WAV)
         → transcribe_local OR transcribe_groq (NEW: custom_prompt, language fix, deterministic flags)
         → cleanup_text (NEW: no forced period)
         → paste_text (NEW: save/restore clipboard)
       → emit recording-state Ready
```

New event: `audio-empty` (emitted from `recorder` when `stop_and_save` returns `Err("no_speech")`), consumed by overlay to show a brief "no speech detected" message.

## Settings migration

- `custom_prompt` defaults to `""` via `#[serde(default)]`. No migration needed for existing `config.json`.
- No fields removed or renamed.

## Risk & rollback

Each change is independent. Failure modes per item:

- **#1 (custom prompt):** if whisper-cli rejects the prompt format, the spawn fails loudly. Default-empty means existing users see no behaviour change unless they fill the field.
- **#2 (silence trim):** false negatives (real speech below threshold) would be the problem. Threshold is conservative (−46 dBFS); revisit if users report missed speech.
- **#3 (clipboard restore):** the 100 ms post-paste delay is the risk window. If a user copies during it, their copy could lose. Documented; matches behaviour of comparable tools.
- **#4 (no forced period):** purely subtractive. Tests cover.
- **#5 (bundle pruning):** missing-DLL failure at first transcription. Verified on both backends before release.
- **#6 (Groq language):** if `auto` and Groq misdetects, user can pick an explicit language as before.
- **#7 (deterministic flags):** if word error rate regresses on noisy clips, drop `--best-of 1` first, then `--temperature 0.0`. Easy revert.
- **#8 (CPU threads):** if a user reports thermal throttling or stalls on shared machines, lower the cap. Trivial revert.
- **#9 (baseline):** measurement only — no runtime risk.

Rollback granularity: each change is one file or two. Any item can be reverted independently without touching the others.

## Testing

### Unit tests (Rust)
- `audio::trim_silence`:
  - synthetic buffer with 1 s silence + 1 s tone + 1 s silence → returns bounds matching the tone region (with padding).
  - all-silence buffer → returns `None`.
  - all-speech buffer → returns `Some((0, len))`.
- `cleanup_text`: updated to assert no period is appended.
- `paste::restore_clipboard` (`#[cfg(windows)]`): set sentinel A, call `paste_text("B")`, assert clipboard ends at A.
- `transcribe_groq`: existing empty-key test still passes; add a test asserting that `language="auto"` does not include the field (refactor: extract form-builder so it's testable without a network call).

### Manual test checklist (in PR description)
- [ ] EN dictation, no custom prompt → text pasted, no period if speech ended without one.
- [ ] EN dictation with custom prompt "Tauri whisper.cpp ggml" → those tokens appear correctly when spoken.
- [ ] DE dictation with custom prompt "Diktiergerät Spracheingabe" → tokens appear correctly.
- [ ] Tap-and-release hotkey with no speech → "no speech detected" toast, no transcription attempt.
- [ ] Pre-load clipboard with "ORIGINAL", dictate into Notepad → "ORIGINAL" still in clipboard afterward.
- [ ] Pre-load clipboard with an image, dictate → text pasted, clipboard now holds our text (documented limitation).
- [ ] Switch engine to Groq, language to "de", dictate German → correct transcription (verifies #6).
- [ ] Build installer, install fresh, transcribe on CUDA → works (verifies #5 CUDA allowlist).
- [ ] Install on CPU-only machine, transcribe → works (verifies #5 CPU allowlist).
- [ ] On CPU-only machine, observe `whisper-cli` arg list in logs includes `-t <N>` where N matches `available_parallelism().min(8)` (verifies #8).
- [ ] Baseline measurements captured in spec appendix on at least the CUDA machine (verifies #9).

## Out of scope (deferred to phase B)

- In-process `whisper-rs` bindings (eliminates subprocess + per-dictation model reload).
- Persistent loaded model across dictations.
- Streaming/partial decode.
- Faster-Whisper / CTranslate2 evaluation.
- VAD model (silero) integration — energy gate is sufficient for phase C.
- Error-toast framework / recording history / clipboard image preservation.
