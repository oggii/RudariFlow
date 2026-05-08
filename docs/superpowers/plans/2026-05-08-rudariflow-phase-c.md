# RudariFlow Phase C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the nine surgical wins from the Phase C spec — custom vocabulary prompt, energy-gate silence trim, clipboard save/restore, no forced terminal period, bundle pruning, Groq language fix, deterministic decoding, CPU thread tuning, and an idle-posture baseline.

**Architecture:** No architectural change. The existing flow (cpal → WAV → `whisper-cli.exe` subprocess → cleanup → paste) stays as-is. Each change is small and lands behind a unit test where possible. Phase B (in-process `whisper-rs`) is a separate plan.

**Tech Stack:** Tauri 2, Rust (cpal, arboard, enigo, hound, reqwest, serde), vanilla TypeScript + Vite, whisper.cpp via subprocess.

**Spec:** [docs/superpowers/specs/2026-05-08-rudariflow-phase-c-design.md](../specs/2026-05-08-rudariflow-phase-c-design.md)

---

## File map

| File | Change kind | Tasks |
|------|-------------|-------|
| `src-tauri/src/settings.rs` | Modify — add `custom_prompt` field + tests | 1 |
| `src-tauri/src/cleanup.rs` | Modify — drop forced period + tests | 2 |
| `src-tauri/src/audio.rs` | Modify — add `trim_silence`, integrate into `stop_and_save` | 3, 4 |
| `src-tauri/src/recorder.rs` | Modify — handle `no_speech` sentinel, thread prompt/language | 5 |
| `src-tauri/src/transcribe_local.rs` | Modify — extract `build_whisper_args`, add prompt/temp/best-of/threads | 6 |
| `src-tauri/src/transcribe_groq.rs` | Modify — accept language + prompt, fix hardcoded `"en"` | 7 |
| `src-tauri/src/paste.rs` | Modify — clipboard save/restore, extract `restore_clipboard` | 8 |
| `src/i18n.ts` | Modify — add EN + DE strings | 9 |
| `index.html` | Modify — add custom vocab textarea row | 10 |
| `src/main.ts` | Modify — wire up textarea | 10 |
| `src/style.css` | Modify — textarea styling | 10 |
| `src/overlay.html` | Modify — handle `audio-empty` event | 11 |
| `src-tauri/tauri.conf.json` | Modify — explicit `resources` allowlist | 12 |
| `docs/superpowers/specs/2026-05-08-rudariflow-phase-c-design.md` | Modify — add baseline appendix | 13 |

---

## Task ordering rationale

Foundation (1–2) → silence chain (3–5) → transcribe layer (6–7) → paste (8) → frontend (9–11) → bundle (12) → baseline (13). Each task is independently shippable; the order is chosen so later tasks build on earlier types/sentinels without forward references.

Run `cargo test --manifest-path src-tauri/Cargo.toml` after every Rust task.

---

### Task 1: Add `custom_prompt` to Settings

**Files:**
- Modify: `src-tauri/src/settings.rs`

- [ ] **Step 1: Write the failing test**

Add this test to the `tests` module in `src-tauri/src/settings.rs`:

```rust
#[test]
fn test_custom_prompt_default_empty() {
    let s = Settings::default();
    assert_eq!(s.custom_prompt, "");
}

#[test]
fn test_custom_prompt_roundtrip() {
    let dir = temp_dir().join("typr_test_prompt");
    let _ = fs::remove_dir_all(&dir);

    let mut settings = Settings::default();
    settings.custom_prompt = "Tauri whisper.cpp ggml".to_string();
    settings.save(&dir).unwrap();
    let loaded = Settings::load(&dir);
    assert_eq!(loaded.custom_prompt, "Tauri whisper.cpp ggml");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn test_custom_prompt_missing_field_loads_as_empty() {
    let dir = temp_dir().join("typr_test_prompt_missing");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    // Pre-0.3 config without customPrompt field
    let pre_v3 = r#"{
        "microphone": "default",
        "engine": "local",
        "whisperModel": "small",
        "groqApiKey": "",
        "recordingMode": "toggle",
        "hotkey": "CmdOrCtrl+Shift+Space",
        "gpuBackend": "auto",
        "language": "auto",
        "uiLanguage": "",
        "volume": 0.4,
        "autostart": false
    }"#;
    fs::write(dir.join("config.json"), pre_v3).unwrap();

    let loaded = Settings::load(&dir);
    assert_eq!(loaded.custom_prompt, "");

    let _ = fs::remove_dir_all(&dir);
}
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cargo test --manifest-path src-tauri/Cargo.toml settings::tests::test_custom_prompt -- --nocapture`
Expected: compile error (`custom_prompt` not a field of `Settings`).

- [ ] **Step 3: Add the field**

In `src-tauri/src/settings.rs`, add inside `pub struct Settings`, after `autostart`:

```rust
    #[serde(rename = "customPrompt", default)]
    pub custom_prompt: String,
```

And in `impl Default for Settings`, add after `autostart: false,`:

```rust
            custom_prompt: String::new(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml settings`
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/settings.rs
git commit -m "Add custom_prompt to Settings (Phase C #1)"
```

---

### Task 2: Drop forced terminal period in cleanup_text

**Files:**
- Modify: `src-tauri/src/cleanup.rs`

- [ ] **Step 1: Update existing tests to reflect the new behaviour**

In `src-tauri/src/cleanup.rs` `tests` module, replace the existing tests with:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_trim_whitespace() {
        assert_eq!(cleanup_text("  hello world  "), "Hello world");
    }

    #[test]
    fn test_normalize_spaces() {
        assert_eq!(cleanup_text("hello    world"), "Hello world");
    }

    #[test]
    fn test_capitalize_first_letter() {
        assert_eq!(cleanup_text("hello world"), "Hello world");
    }

    #[test]
    fn test_capitalize_after_period() {
        assert_eq!(cleanup_text("hello. world"), "Hello. World");
    }

    #[test]
    fn test_capitalize_after_question_mark() {
        assert_eq!(cleanup_text("hello? world"), "Hello? World");
    }

    #[test]
    fn test_capitalize_after_exclamation() {
        assert_eq!(cleanup_text("hello! world"), "Hello! World");
    }

    #[test]
    fn test_no_forced_terminal_punctuation() {
        // Phase C: never auto-append a period. Trust whisper's output.
        assert_eq!(cleanup_text("hello world"), "Hello world");
        assert_eq!(cleanup_text("search query"), "Search query");
        assert_eq!(cleanup_text("foo bar"), "Foo bar");
    }

    #[test]
    fn test_preserves_existing_punctuation() {
        assert_eq!(cleanup_text("hello world."), "Hello world.");
        assert_eq!(cleanup_text("hello world!"), "Hello world!");
        assert_eq!(cleanup_text("hello world?"), "Hello world?");
    }

    #[test]
    fn test_empty_string() {
        assert_eq!(cleanup_text(""), "");
        assert_eq!(cleanup_text("   "), "");
    }

    #[test]
    fn test_already_clean() {
        assert_eq!(cleanup_text("Hello world."), "Hello world.");
    }
}
```

- [ ] **Step 2: Run tests to verify the new expectations fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml cleanup`
Expected: ~7 tests fail because cleanup still appends `.`.

- [ ] **Step 3: Remove the forced-period block**

In `src-tauri/src/cleanup.rs`, replace the entire body of `cleanup_text` with:

```rust
pub fn cleanup_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let normalized: String = trimmed
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");

    let mut result = String::new();
    let mut capitalize_next = true;

    for ch in normalized.chars() {
        if capitalize_next && ch.is_alphabetic() {
            result.extend(ch.to_uppercase());
            capitalize_next = false;
        } else {
            result.push(ch);
            if ch == '.' || ch == '!' || ch == '?' {
                capitalize_next = true;
            }
        }
    }

    result
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml cleanup`
Expected: all 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/cleanup.rs
git commit -m "Stop force-appending terminal period in cleanup_text (Phase C #4)"
```

---

### Task 3: Add `trim_silence` pure function

**Files:**
- Modify: `src-tauri/src/audio.rs`

- [ ] **Step 1: Write the failing tests**

Add to the bottom of `src-tauri/src/audio.rs` (create the `tests` module if it doesn't exist):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn synth(silent_secs: f32, tone_secs: f32, trail_secs: f32, sr: u32) -> Vec<f32> {
        let n_silent = (silent_secs * sr as f32) as usize;
        let n_tone = (tone_secs * sr as f32) as usize;
        let n_trail = (trail_secs * sr as f32) as usize;
        let mut v = Vec::with_capacity(n_silent + n_tone + n_trail);
        v.extend(std::iter::repeat(0.0_f32).take(n_silent));
        // 0.5 amplitude sine-ish; constant amplitude is enough for RMS test
        v.extend(std::iter::repeat(0.5_f32).take(n_tone));
        v.extend(std::iter::repeat(0.0_f32).take(n_trail));
        v
    }

    #[test]
    fn trim_silence_finds_tone_in_silence() {
        let sr = 16_000;
        let buf = synth(1.0, 1.0, 1.0, sr);
        let bounds = trim_silence(&buf, sr).expect("should detect speech");
        // Speech starts at 1.0 s, ends at 2.0 s. Padded ±200 ms → [0.8, 2.2] s.
        let expected_start = (0.8 * sr as f32) as usize;
        let expected_end = (2.2 * sr as f32) as usize;
        // Allow ±1 window of slop (window = 20 ms = sr/50 samples).
        let win = (sr / 50) as usize;
        assert!(
            bounds.0 <= expected_start + win && bounds.0 + win >= expected_start,
            "start {} not near {}",
            bounds.0,
            expected_start
        );
        assert!(
            bounds.1 <= expected_end + win && bounds.1 + win >= expected_end,
            "end {} not near {}",
            bounds.1,
            expected_end
        );
    }

    #[test]
    fn trim_silence_returns_none_for_all_silence() {
        let sr = 16_000;
        let buf = vec![0.0_f32; sr as usize * 2];
        assert!(trim_silence(&buf, sr).is_none());
    }

    #[test]
    fn trim_silence_returns_full_range_for_all_speech() {
        let sr = 16_000;
        let buf = vec![0.5_f32; sr as usize * 2];
        let bounds = trim_silence(&buf, sr).expect("should detect speech");
        assert_eq!(bounds.0, 0);
        assert_eq!(bounds.1, buf.len());
    }

    #[test]
    fn trim_silence_handles_short_buffers() {
        // Buffer shorter than one window → conservatively returns full range
        // if it has any energy, None otherwise.
        let sr = 16_000;
        let short_loud = vec![0.5_f32; 100];
        assert!(trim_silence(&short_loud, sr).is_some());

        let short_quiet = vec![0.0_f32; 100];
        assert!(trim_silence(&short_quiet, sr).is_none());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml audio::tests`
Expected: compile error (`trim_silence` undefined).

- [ ] **Step 3: Implement `trim_silence`**

Add at the bottom of `src-tauri/src/audio.rs`, after the `resample` function:

```rust
const TRIM_RMS_THRESHOLD: f32 = 0.005;
const TRIM_PAD_MS: u32 = 200;

/// Find the speech bounds in `samples` using a 20 ms RMS window.
/// Returns `Some((start, end))` indices into `samples`, padded ±TRIM_PAD_MS.
/// Returns `None` if every window is below TRIM_RMS_THRESHOLD.
pub fn trim_silence(samples: &[f32], sample_rate: u32) -> Option<(usize, usize)> {
    if samples.is_empty() {
        return None;
    }
    let window = (sample_rate / 50) as usize; // 20 ms
    let pad = ((TRIM_PAD_MS as u64 * sample_rate as u64) / 1000) as usize;

    // Buffers shorter than one window: fall back to a single RMS check.
    if window == 0 || samples.len() < window {
        let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
        let rms = (sum_sq / samples.len() as f32).sqrt();
        return if rms >= TRIM_RMS_THRESHOLD {
            Some((0, samples.len()))
        } else {
            None
        };
    }

    let mut first_loud: Option<usize> = None;
    let mut last_loud: Option<usize> = None;
    let mut i = 0;
    while i + window <= samples.len() {
        let chunk = &samples[i..i + window];
        let sum_sq: f32 = chunk.iter().map(|s| s * s).sum();
        let rms = (sum_sq / window as f32).sqrt();
        if rms >= TRIM_RMS_THRESHOLD {
            if first_loud.is_none() {
                first_loud = Some(i);
            }
            last_loud = Some(i + window);
        }
        i += window;
    }

    let (start, end) = match (first_loud, last_loud) {
        (Some(s), Some(e)) => (s, e),
        _ => return None,
    };

    let padded_start = start.saturating_sub(pad);
    let padded_end = (end + pad).min(samples.len());
    Some((padded_start, padded_end))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml audio::tests`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/audio.rs
git commit -m "Add trim_silence energy-gate function (Phase C #2)"
```

---

### Task 4: Integrate `trim_silence` into `stop_and_save`

**Files:**
- Modify: `src-tauri/src/audio.rs` (the `stop_and_save` method)

- [ ] **Step 1: Modify `stop_and_save` to call `trim_silence` before resampling**

In `src-tauri/src/audio.rs`, replace the body of `stop_and_save` (currently lines ~137–181) with:

```rust
    pub fn stop_and_save(&mut self, output_path: &PathBuf) -> Result<PathBuf, String> {
        self.stream = None; // Drop stops the stream
        println!("[RudariFlow] Audio recording stopped");

        let samples = self.samples.lock().unwrap();
        if samples.is_empty() {
            return Err("No audio captured".to_string());
        }

        println!("[RudariFlow] Captured {} raw samples", samples.len());

        // Convert to mono if multi-channel
        let mono: Vec<f32> = if self.source_channels > 1 {
            samples
                .chunks(self.source_channels as usize)
                .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
                .collect()
        } else {
            samples.clone()
        };
        drop(samples);
        self.samples.lock().unwrap().clear();

        // Trim leading/trailing silence. If everything is silence, bail before
        // we waste a whisper invocation hallucinating filler text.
        let trimmed: Vec<f32> = match trim_silence(&mono, self.source_sample_rate) {
            Some((start, end)) => mono[start..end].to_vec(),
            None => {
                println!("[RudariFlow] trim_silence: no speech detected");
                return Err("no_speech".to_string());
            }
        };
        println!(
            "[RudariFlow] Trimmed {} -> {} samples ({:.1}% kept)",
            mono.len(),
            trimmed.len(),
            100.0 * trimmed.len() as f32 / mono.len() as f32
        );

        // Downsample to 16kHz for whisper.cpp
        let resampled = resample(&trimmed, self.source_sample_rate, 16000);
        println!("[RudariFlow] Resampled to {} samples at 16kHz", resampled.len());

        let spec = WavSpec {
            channels: 1,
            sample_rate: 16000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = WavWriter::create(output_path, spec).map_err(|e| e.to_string())?;
        for &sample in resampled.iter() {
            let amplitude = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            writer.write_sample(amplitude).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;

        println!("[RudariFlow] WAV saved to {:?}", output_path);
        Ok(output_path.clone())
    }
```

- [ ] **Step 2: Run all audio tests to verify nothing regressed**

Run: `cargo test --manifest-path src-tauri/Cargo.toml audio`
Expected: 4 tests pass (the `trim_silence` ones from Task 3).

- [ ] **Step 3: Build the whole crate**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds clean. Any compile error in `recorder.rs` (because we now return `"no_speech"`) means the next task is needed; that's fine — Task 5 is up next.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/audio.rs
git commit -m "Trim silence before WAV write; bail on all-silence (Phase C #2)"
```

---

### Task 5: Recorder — handle `no_speech` sentinel and thread prompt/language

**Files:**
- Modify: `src-tauri/src/recorder.rs`

This task does three things in one place because they all touch `run_transcription_pipeline`:
1. Catch `Err("no_speech")` from `stop_and_save`, emit `audio-empty`, return `Ok("")`.
2. Pass `&settings.custom_prompt` to both transcribe paths.
3. Pass `&settings.language` to the Groq path.

The transcribe functions are still single-arg in this task — Task 6 and 7 expand their signatures. We just prepare the call sites here so the wiring is in place when those tasks land. Use placeholder calls; the compiler will tell us if signatures drift.

- [ ] **Step 1: Update `run_transcription_pipeline`**

In `src-tauri/src/recorder.rs`, replace the body of `run_transcription_pipeline` with:

```rust
    async fn run_transcription_pipeline(
        &self,
        app: &AppHandle,
        settings: &Settings,
        app_dir: &PathBuf,
    ) -> Result<String, String> {
        let temp_path = app_dir.join("temp_recording.wav");

        let save_result = {
            let mut recorder = self.audio_recorder.lock().unwrap();
            recorder.stop_and_save(&temp_path)
        };

        if let Err(e) = &save_result {
            if e == "no_speech" {
                let _ = app.emit("audio-empty", ());
                // No file was written; nothing to clean up. Return empty so
                // the caller skips paste and the state machine resets cleanly.
                return Ok(String::new());
            }
        }
        save_result?;

        let raw_text = match settings.engine.as_str() {
            "local" => {
                let model_path = app_dir.join(transcribe_local::model_filename(&settings.whisper_model));
                transcribe_local::transcribe_local(
                    app,
                    &model_path,
                    &temp_path,
                    &settings.gpu_backend,
                    &settings.language,
                    &settings.custom_prompt,
                ).await?
            }
            "cloud" => {
                transcribe_groq::transcribe_groq(
                    &settings.groq_api_key,
                    &temp_path,
                    &settings.language,
                    &settings.custom_prompt,
                ).await?
            }
            _ => return Err(format!("Unknown engine: {}", settings.engine)),
        };

        let _ = std::fs::remove_file(&temp_path);

        let cleaned = cleanup_text(&raw_text);

        if !cleaned.is_empty() {
            paste_text(&cleaned)?;
        }

        Ok(cleaned)
    }
```

- [ ] **Step 2: Verify compile error points at the transcribe signatures**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: errors in `transcribe_local::transcribe_local` and `transcribe_groq::transcribe_groq` saying "this function takes N arguments but M were supplied". This is the expected handoff to Tasks 6 and 7.

- [ ] **Step 3: Don't commit yet**

This task leaves the workspace non-compiling on purpose so Task 6 and Task 7 land the matching signatures. Move straight to Task 6.

---

### Task 6: Transcribe local — extract `build_whisper_args`, add prompt + deterministic flags + CPU threads

**Files:**
- Modify: `src-tauri/src/transcribe_local.rs`

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module at the bottom of `src-tauri/src/transcribe_local.rs`:

```rust
    #[test]
    fn build_args_cuda_minimal() {
        let args = build_whisper_args(
            std::path::Path::new("model.bin"),
            std::path::Path::new("audio.wav"),
            "auto",
            "",
            "cuda",
        );
        let s: Vec<String> = args.iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert!(s.contains(&"-m".to_string()));
        assert!(s.contains(&"model.bin".to_string()));
        assert!(s.contains(&"-f".to_string()));
        assert!(s.contains(&"audio.wav".to_string()));
        assert!(s.contains(&"--no-timestamps".to_string()));
        assert!(s.contains(&"-np".to_string()));
        assert!(s.contains(&"-l".to_string()));
        assert!(s.contains(&"auto".to_string()));
        assert!(s.contains(&"--temperature".to_string()));
        assert!(s.contains(&"0.0".to_string()));
        assert!(s.contains(&"--best-of".to_string()));
        assert!(s.contains(&"1".to_string()));
        // CUDA: no -ng, no -t override
        assert!(!s.contains(&"-ng".to_string()));
        assert!(!s.contains(&"-t".to_string()));
        // Empty prompt: no --prompt
        assert!(!s.contains(&"--prompt".to_string()));
    }

    #[test]
    fn build_args_cpu_adds_ng_and_threads() {
        let args = build_whisper_args(
            std::path::Path::new("model.bin"),
            std::path::Path::new("audio.wav"),
            "en",
            "",
            "cpu",
        );
        let s: Vec<String> = args.iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert!(s.contains(&"-ng".to_string()));
        assert!(s.contains(&"-t".to_string()));
        // Threads value: present, parses, in [1, 8]
        let t_idx = s.iter().position(|x| x == "-t").unwrap();
        let n: u32 = s[t_idx + 1].parse().expect("threads is a number");
        assert!((1..=8).contains(&n), "thread count {} out of range", n);
    }

    #[test]
    fn build_args_includes_prompt_when_non_empty() {
        let args = build_whisper_args(
            std::path::Path::new("m.bin"),
            std::path::Path::new("a.wav"),
            "de",
            "Tauri whisper.cpp ggml",
            "cuda",
        );
        let s: Vec<String> = args.iter().map(|s| s.to_string_lossy().into_owned()).collect();
        let i = s.iter().position(|x| x == "--prompt").expect("--prompt present");
        assert_eq!(s[i + 1], "Tauri whisper.cpp ggml");
    }

    #[test]
    fn build_args_omits_prompt_when_empty() {
        let args = build_whisper_args(
            std::path::Path::new("m.bin"),
            std::path::Path::new("a.wav"),
            "auto",
            "   ", // whitespace-only counts as empty
            "cuda",
        );
        let s: Vec<String> = args.iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert!(!s.contains(&"--prompt".to_string()));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml transcribe_local::tests::build_args`
Expected: compile error (`build_whisper_args` undefined).

- [ ] **Step 3: Add `build_whisper_args` and update `transcribe_local`**

Add to `src-tauri/src/transcribe_local.rs`, above `pub async fn transcribe_local`:

```rust
use std::ffi::OsString;
use std::path::Path;

fn cpu_thread_count() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(4)
        .min(8)
        .max(1)
}

pub(crate) fn build_whisper_args(
    model_path: &Path,
    audio_path: &Path,
    language: &str,
    custom_prompt: &str,
    backend: &str,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::with_capacity(16);
    args.push("-m".into());
    args.push(model_path.as_os_str().to_owned());
    args.push("-f".into());
    args.push(audio_path.as_os_str().to_owned());
    args.push("--no-timestamps".into());
    args.push("-np".into());
    args.push("-l".into());
    args.push(language.into());
    args.push("--temperature".into());
    args.push("0.0".into());
    args.push("--best-of".into());
    args.push("1".into());

    if backend == "cpu" {
        args.push("-ng".into());
        args.push("-t".into());
        args.push(cpu_thread_count().to_string().into());
    }

    let trimmed_prompt = custom_prompt.trim();
    if !trimmed_prompt.is_empty() {
        args.push("--prompt".into());
        args.push(trimmed_prompt.into());
    }

    args
}
```

Now replace the body of `pub async fn transcribe_local` to use it. The new signature gains `custom_prompt: &str`:

```rust
pub async fn transcribe_local(
    app: &AppHandle,
    model_path: &PathBuf,
    audio_path: &PathBuf,
    gpu_backend: &str,
    language: &str,
    custom_prompt: &str,
) -> Result<String, String> {
    if !model_path.exists() {
        return Err("Whisper model not found. Please download a model first.".to_string());
    }

    let backend = resolve_backend(app, gpu_backend);
    let dir = whisper_dir(app, backend)?;
    let exe = whisper_exe(app, backend)?;

    println!(
        "[RudariFlow] Running whisper-cli (backend={}) with model {:?}",
        backend, model_path
    );

    let args = build_whisper_args(model_path, audio_path, language, custom_prompt, backend);

    let mut cmd = Command::new(&exe);
    cmd.current_dir(&dir).args(&args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run whisper-cli: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if backend == "cuda" && gpu_backend == "auto" {
            eprintln!(
                "[RudariFlow] cuda failed at runtime ({}). Retrying on cpu.",
                stderr.trim()
            );
            *AUTO_CACHED.lock().unwrap() = Some("cpu");
            return Box::pin(transcribe_local(
                app, model_path, audio_path, "cpu", language, custom_prompt,
            ))
            .await;
        }
        return Err(format!("whisper-cli failed: {}", stderr));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    println!("[RudariFlow] Whisper output: {}", text);
    Ok(text)
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml transcribe_local`
Expected: all `build_args_*` tests + the existing `test_model_filename` and `test_model_download_url` tests pass.

- [ ] **Step 5: Don't commit yet**

The crate still doesn't compile because `transcribe_groq` hasn't been updated to its new signature. Move straight to Task 7.

---

### Task 7: Transcribe groq — accept language + prompt, fix hardcoded `"en"`

**Files:**
- Modify: `src-tauri/src/transcribe_groq.rs`

The Groq form is opaque (multipart::Form doesn't expose its fields), so we test via a small pure helper that returns the text fields we'd add. The HTTP layer stays minimal.

- [ ] **Step 1: Write the failing tests**

Replace the `tests` module at the bottom of `src-tauri/src/transcribe_groq.rs` with:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_empty_api_key() {
        let path = PathBuf::from("/tmp/test.wav");
        let result = transcribe_groq("", &path, "en", "").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("API key not set"));
    }

    #[test]
    fn groq_text_fields_auto_omits_language() {
        let fields = groq_text_fields("auto", "");
        assert!(fields.iter().any(|(k, v)| k == "model" && v == "whisper-large-v3-turbo"));
        assert!(!fields.iter().any(|(k, _)| k == "language"));
        assert!(!fields.iter().any(|(k, _)| k == "prompt"));
    }

    #[test]
    fn groq_text_fields_explicit_language_passes_through() {
        let fields = groq_text_fields("de", "");
        assert!(fields.iter().any(|(k, v)| k == "language" && v == "de"));
    }

    #[test]
    fn groq_text_fields_includes_prompt_when_non_empty() {
        let fields = groq_text_fields("en", "Tauri whisper.cpp");
        assert!(fields.iter().any(|(k, v)| k == "prompt" && v == "Tauri whisper.cpp"));
    }

    #[test]
    fn groq_text_fields_omits_blank_prompt() {
        let fields = groq_text_fields("en", "   ");
        assert!(!fields.iter().any(|(k, _)| k == "prompt"));
    }

    #[test]
    fn groq_text_fields_always_sets_response_format() {
        let fields = groq_text_fields("auto", "");
        assert!(fields.iter().any(|(k, v)| k == "response_format" && v == "json"));
    }
}
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cargo test --manifest-path src-tauri/Cargo.toml transcribe_groq`
Expected: compile errors (`groq_text_fields` undefined; `transcribe_groq` arity mismatch).

- [ ] **Step 3: Implement the helper and update `transcribe_groq`**

Replace the entire contents of `src-tauri/src/transcribe_groq.rs` with:

```rust
use reqwest::multipart;
use std::path::PathBuf;

/// Build the non-file form fields for the Groq request as `(key, value)` pairs.
/// Pure function for testability; the multipart::Form is opaque.
pub(crate) fn groq_text_fields(language: &str, custom_prompt: &str) -> Vec<(&'static str, String)> {
    let mut fields: Vec<(&'static str, String)> = Vec::with_capacity(4);
    fields.push(("model", "whisper-large-v3-turbo".to_string()));
    fields.push(("response_format", "json".to_string()));
    if language != "auto" && !language.is_empty() {
        fields.push(("language", language.to_string()));
    }
    let trimmed_prompt = custom_prompt.trim();
    if !trimmed_prompt.is_empty() {
        fields.push(("prompt", trimmed_prompt.to_string()));
    }
    fields
}

pub async fn transcribe_groq(
    api_key: &str,
    audio_path: &PathBuf,
    language: &str,
    custom_prompt: &str,
) -> Result<String, String> {
    if api_key.is_empty() {
        return Err("Groq API key not set. Please enter your API key in settings.".to_string());
    }

    let audio_bytes = std::fs::read(audio_path)
        .map_err(|e| format!("Failed to read audio file: {}", e))?;

    let file_part = multipart::Part::bytes(audio_bytes)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;

    let mut form = multipart::Form::new().part("file", file_part);
    for (k, v) in groq_text_fields(language, custom_prompt) {
        form = form.text(k, v);
    }

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Groq API request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Groq API error ({}): {}", status, body));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Groq response: {}", e))?;

    json["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or("No 'text' field in Groq response".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_empty_api_key() {
        let path = PathBuf::from("/tmp/test.wav");
        let result = transcribe_groq("", &path, "en", "").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("API key not set"));
    }

    #[test]
    fn groq_text_fields_auto_omits_language() {
        let fields = groq_text_fields("auto", "");
        assert!(fields.iter().any(|(k, v)| k == &"model" && v == "whisper-large-v3-turbo"));
        assert!(!fields.iter().any(|(k, _)| k == &"language"));
        assert!(!fields.iter().any(|(k, _)| k == &"prompt"));
    }

    #[test]
    fn groq_text_fields_explicit_language_passes_through() {
        let fields = groq_text_fields("de", "");
        assert!(fields.iter().any(|(k, v)| k == &"language" && v == "de"));
    }

    #[test]
    fn groq_text_fields_includes_prompt_when_non_empty() {
        let fields = groq_text_fields("en", "Tauri whisper.cpp");
        assert!(fields.iter().any(|(k, v)| k == &"prompt" && v == "Tauri whisper.cpp"));
    }

    #[test]
    fn groq_text_fields_omits_blank_prompt() {
        let fields = groq_text_fields("en", "   ");
        assert!(!fields.iter().any(|(k, _)| k == &"prompt"));
    }

    #[test]
    fn groq_text_fields_always_sets_response_format() {
        let fields = groq_text_fields("auto", "");
        assert!(fields.iter().any(|(k, v)| k == &"response_format" && v == "json"));
    }
}
```

(Note: in the assertions inside the actual file, `k == &"model"` is the correct form since `k` is borrowed; the test code I wrote in Step 1 used `k == "model"` which also works due to Rust's `PartialEq` impl for `&&str`/`&str`. Use whichever the compiler accepts — both compile.)

- [ ] **Step 4: Run the whole test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: every test passes — settings, cleanup, audio, transcribe_local, transcribe_groq, recorder.

- [ ] **Step 5: Build the full crate**

Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: clean build, no warnings about unused imports.

- [ ] **Step 6: Commit Tasks 5–7 together**

Tasks 5, 6, and 7 form one logical unit (`recorder` was left non-compiling at the end of Task 5 on purpose). Commit them in one commit:

```bash
git add src-tauri/src/recorder.rs src-tauri/src/transcribe_local.rs src-tauri/src/transcribe_groq.rs
git commit -m "Thread custom_prompt + language; deterministic flags; CPU threads; Groq language fix; audio-empty event (Phase C #1, #6, #7, #8)"
```

---

### Task 8: Paste — clipboard save/restore

**Files:**
- Modify: `src-tauri/src/paste.rs`

- [ ] **Step 1: Write the failing test for `restore_clipboard`**

Append a tests module at the bottom of `src-tauri/src/paste.rs`:

```rust
#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn restore_clipboard_some_writes_back() {
        let mut cb = arboard::Clipboard::new().expect("clipboard available");
        let _ = cb.set_text("our_paste_text");
        // Sanity: confirm we set it
        assert_eq!(cb.get_text().unwrap_or_default(), "our_paste_text");

        restore_clipboard(Some("ORIGINAL".to_string()));

        let after = arboard::Clipboard::new().unwrap().get_text().unwrap_or_default();
        assert_eq!(after, "ORIGINAL");
    }

    #[test]
    fn restore_clipboard_none_is_noop() {
        let mut cb = arboard::Clipboard::new().expect("clipboard available");
        let _ = cb.set_text("kept");

        restore_clipboard(None);

        let after = arboard::Clipboard::new().unwrap().get_text().unwrap_or_default();
        assert_eq!(after, "kept");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml paste`
Expected: compile error (`restore_clipboard` undefined).

Note: these tests touch the real OS clipboard. They may fail flakily on a CI runner without a clipboard service, or if you have something else writing to the clipboard during the run. They're meant to be run locally on Windows.

- [ ] **Step 3: Replace `paste.rs`**

Replace the entire contents of `src-tauri/src/paste.rs` with:

```rust
/// Restore the clipboard to a previous text value.
/// Best-effort — silently swallows errors. If `prev` is None, leaves the
/// current clipboard alone (we have nothing better to put back).
pub(crate) fn restore_clipboard(prev: Option<String>) {
    if let Some(text) = prev {
        if let Ok(mut cb) = arboard::Clipboard::new() {
            let _ = cb.set_text(text);
        }
    }
}

pub fn paste_text(text: &str) -> Result<(), String> {
    // Capture whatever the user had in the clipboard so we can put it back
    // after our paste. If they had non-text content (image, files, HTML),
    // get_text() errors and we treat that as "nothing to restore".
    let previous: Option<String> = match arboard::Clipboard::new() {
        Ok(mut cb) => cb.get_text().ok(),
        Err(_) => None,
    };

    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())?;

    // Small delay to ensure clipboard is set before the paste keystroke.
    std::thread::sleep(std::time::Duration::from_millis(50));

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("osascript")
            .args(["-e", r#"tell application "System Events" to keystroke "v" using command down"#])
            .output()
            .map_err(|e| format!("Failed to simulate paste: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        use enigo::{Enigo, Keyboard, Settings, Key, Direction};
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
        enigo.key(Key::Control, Direction::Press).map_err(|e| e.to_string())?;
        enigo.key(Key::Unicode('v'), Direction::Click).map_err(|e| e.to_string())?;
        enigo.key(Key::Control, Direction::Release).map_err(|e| e.to_string())?;
    }

    // Give the target app time to actually consume the paste before we
    // overwrite the clipboard with the previous content.
    std::thread::sleep(std::time::Duration::from_millis(100));
    restore_clipboard(previous);

    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn restore_clipboard_some_writes_back() {
        let mut cb = arboard::Clipboard::new().expect("clipboard available");
        let _ = cb.set_text("our_paste_text");
        assert_eq!(cb.get_text().unwrap_or_default(), "our_paste_text");

        restore_clipboard(Some("ORIGINAL".to_string()));

        let after = arboard::Clipboard::new().unwrap().get_text().unwrap_or_default();
        assert_eq!(after, "ORIGINAL");
    }

    #[test]
    fn restore_clipboard_none_is_noop() {
        let mut cb = arboard::Clipboard::new().expect("clipboard available");
        let _ = cb.set_text("kept");

        restore_clipboard(None);

        let after = arboard::Clipboard::new().unwrap().get_text().unwrap_or_default();
        assert_eq!(after, "kept");
    }
}
```

- [ ] **Step 4: Run paste tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml paste -- --test-threads=1`
Expected: both tests pass on Windows. (`--test-threads=1` because they share clipboard state.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/paste.rs
git commit -m "Save and restore clipboard around auto-paste (Phase C #3)"
```

---

### Task 9: Frontend i18n — add EN + DE strings

**Files:**
- Modify: `src/i18n.ts`

- [ ] **Step 1: Add new keys to both dictionaries**

In `src/i18n.ts`, in the `en` dictionary, add after `hotkey_invalid`:

```typescript
  custom_prompt_label: "Custom Vocabulary",
  custom_prompt_hint: "Names, acronyms and jargon you dictate often. Helps Whisper get them right.",
  custom_prompt_placeholder: "e.g. Tauri, whisper.cpp, ggml, oggi",
  audio_empty_message: "No speech detected",
```

In the `de` dictionary, add after `hotkey_invalid`:

```typescript
  custom_prompt_label: "Eigenes Vokabular",
  custom_prompt_hint: "Namen, Abkürzungen und Fachbegriffe, die du oft diktierst. Hilft Whisper, sie korrekt zu erkennen.",
  custom_prompt_placeholder: "z. B. Tauri, whisper.cpp, ggml, oggi",
  audio_empty_message: "Keine Sprache erkannt",
```

- [ ] **Step 2: Verify the file still parses**

Run: `npm run build`
Expected: TypeScript build succeeds. (This also catches typos in the dictionary entries.)

- [ ] **Step 3: Commit**

```bash
git add src/i18n.ts
git commit -m "Add custom vocab + audio-empty i18n strings (EN/DE) (Phase C #1, #2)"
```

---

### Task 10: Frontend — custom vocabulary textarea (HTML, TS, CSS)

**Files:**
- Modify: `index.html` (add a row in the local-settings group inside section-engine)
- Modify: `src/main.ts` (add the field to the Settings interface, wire load/save)
- Modify: `src/style.css` (textarea styling — minimal)

- [ ] **Step 1: Add the textarea row to `index.html`**

Find the `setting-row` with id `local-settings` inside `<section id="section-engine">` (the Model Size row). Immediately after that closing `</div>` of the model row's `setting-row`, insert this new row (still inside `<div class="settings-list">`):

```html
            <div class="setting-row hidden" id="custom-prompt-row">
              <div class="setting-label">
                <span class="label-text" data-i18n="custom_prompt_label">Custom Vocabulary</span>
                <span class="label-hint" data-i18n="custom_prompt_hint">Names, acronyms and jargon you dictate often. Helps Whisper get them right.</span>
              </div>
              <div class="setting-control">
                <textarea
                  id="custom-prompt"
                  rows="3"
                  maxlength="2000"
                  data-i18n-placeholder="custom_prompt_placeholder"
                  placeholder="e.g. Tauri, whisper.cpp, ggml, oggi"
                ></textarea>
              </div>
            </div>
```

The `hidden` class is set initially because the row should only show on the local engine path (Groq supports prompt too, so we'll show it for both — see Step 3). For now, leave the class on; we'll remove it dynamically.

- [ ] **Step 2: Update the Settings interface and wire load/save in `src/main.ts`**

In `src/main.ts`, update the `Settings` interface to include the new field. Add after `autostart: boolean;`:

```typescript
  customPrompt: string;
```

Add a const for the textarea after the other DOM-element constants (after `hotkeyBtn`):

```typescript
const customPromptTextarea = document.getElementById("custom-prompt") as HTMLTextAreaElement;
const customPromptRow = document.getElementById("custom-prompt-row")!;
```

In `loadSettings()`, after the line `groqKey.value = currentSettings.groqApiKey;`, add:

```typescript
  customPromptTextarea.value = currentSettings.customPrompt || "";
```

In `setEngine`, after the existing class toggles, replace the function body with this version (it now also shows the custom prompt row regardless of engine, since both backends use it):

```typescript
function setEngine(engine: string) {
  currentSettings.engine = engine;
  engineLocal.classList.toggle("active", engine === "local");
  engineCloud.classList.toggle("active", engine === "cloud");
  localSettings.classList.toggle("hidden", engine !== "local");
  cloudSettings.classList.toggle("hidden", engine !== "cloud");
  // Custom vocab applies to both engines (whisper-cli's --prompt and Groq's prompt)
  customPromptRow.classList.remove("hidden");
}
```

In `saveSettings()`, add this line before `await invoke(...)`:

```typescript
  currentSettings.customPrompt = customPromptTextarea.value;
```

Add a change listener after `groqKey.addEventListener("change", () => saveSettings());`:

```typescript
customPromptTextarea.addEventListener("change", () => saveSettings());
```

Also extend `applyTranslations` so the placeholder updates when language changes. In `src/i18n.ts`, replace the `applyTranslations` function with:

```typescript
function applyTranslations() {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n")!;
    el.textContent = t(key);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder")!;
    if ("placeholder" in el) {
      (el as HTMLInputElement | HTMLTextAreaElement).placeholder = t(key);
    }
  });
}
```

- [ ] **Step 3: Add minimal CSS for the textarea in `src/style.css`**

Open `src/style.css`, scroll to the bottom, and append:

```css
#custom-prompt {
  width: 100%;
  min-height: 64px;
  resize: vertical;
  font: inherit;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
  box-sizing: border-box;
}
#custom-prompt:focus {
  outline: none;
  border-color: rgba(127, 127, 127, 0.4);
}
```

(If the existing CSS uses a dark theme with different conventions, match those. The above is intentionally neutral — adjust border/background to fit the existing input/select styles in `style.css` if they look out of place.)

- [ ] **Step 4: Verify the build**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 5: Manual smoke test**

Run: `npm run tauri dev`
Then:
1. Open the Engine section → confirm a "Custom Vocabulary" textarea appears.
2. Type "Tauri whisper.cpp ggml oggi" → click anywhere else → reopen the app → confirm the value persisted.
3. Switch UI language to German → confirm the label, hint, and placeholder are all in German.
4. Dictate "Open Tauri and run whisper-cli" → confirm "Tauri" and "whisper-cli" appear correctly in the pasted text.

- [ ] **Step 6: Commit**

```bash
git add index.html src/main.ts src/style.css src/i18n.ts
git commit -m "Add Custom Vocabulary textarea to settings (Phase C #1)"
```

---

### Task 11: Frontend overlay — handle `audio-empty` event

**Files:**
- Modify: `src/overlay.html`

- [ ] **Step 1: Add the listener and a brief banner**

In `src/overlay.html`, inside the `<style>` block (just before `</style>`), append:

```css
.notice {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.95);
  background: rgba(20, 20, 22, 0.92);
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms ease;
}
body[data-state="notice"] .notice { opacity: 1; }
```

Add the notice div inside the body, immediately after the `</div>` that closes `.pill`:

```html
    <div class="notice" id="notice"></div>
```

Inside the existing `<script type="module">`, after the `__overlayUpdate` function, append:

```javascript
      const noticeEl = document.getElementById("notice");
      let noticeTimer = null;
      function showNotice(text, ms) {
        noticeEl.textContent = text;
        document.body.dataset.state = "notice";
        if (noticeTimer) clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => {
          document.body.dataset.state = "ready";
          // Tell Rust we're done so it can hide the overlay window.
          invoke("diag_log", { source: "overlay", message: "notice timeout" });
        }, ms);
      }

      // i18n strings are owned by the main window. Keep a tiny EN/DE map here
      // since the overlay is a separate webview without access to the main
      // window's dictionary.
      const NOTICE_TEXT = {
        en: { audio_empty: "No speech detected" },
        de: { audio_empty: "Keine Sprache erkannt" },
      };
      function pickLang() {
        const nav = (navigator.language || "en").toLowerCase();
        return nav.startsWith("de") ? "de" : "en";
      }

      listen("audio-empty", () => {
        diag("audio-empty received");
        const lang = pickLang();
        showNotice(NOTICE_TEXT[lang].audio_empty, 1500);
      }).then(() => diag("audio-empty listener registered"));
```

For the overlay window to actually appear when this fires (the `audio-empty` event happens after `recording-state` already returned to `Ready`, which hides the overlay), we need the Rust side to keep the overlay visible during the notice. Add a follow-up step:

- [ ] **Step 2: Make the recorder show the overlay around `audio-empty`**

In `src-tauri/src/recorder.rs`, in `run_transcription_pipeline`, replace the `audio-empty` block with one that shows the overlay, emits, sleeps briefly, then hides:

```rust
        if let Err(e) = &save_result {
            if e == "no_speech" {
                // Make sure the overlay is visible so the notice can be seen.
                if let Some(overlay) = app.get_webview_window("overlay") {
                    let _ = overlay.set_always_on_top(false);
                    let _ = overlay.set_always_on_top(true);
                    let _ = overlay.show();
                }
                let _ = app.emit("audio-empty", ());
                // Hold the overlay open long enough for the 1.5s notice to play.
                let app_clone = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(1700)).await;
                    if let Some(overlay) = app_clone.get_webview_window("overlay") {
                        let _ = overlay.hide();
                    }
                });
                return Ok(String::new());
            }
        }
        save_result?;
```

- [ ] **Step 3: Build and smoke-test**

Run: `npm run tauri dev`

Then:
1. Press the hotkey, immediately press it again without speaking (toggle mode), or tap-and-release in PTT mode.
2. Confirm the overlay shows "No speech detected" briefly, then fades away.
3. Confirm a normal dictation still works.

- [ ] **Step 4: Commit**

```bash
git add src/overlay.html src-tauri/src/recorder.rs
git commit -m "Show 'no speech detected' notice on audio-empty (Phase C #2)"
```

---

### Task 12: Bundle pruning — explicit `resources` allowlist

**Files:**
- Modify: `src-tauri/tauri.conf.json`

This task is verification-heavy: the goal is the smallest set of files that lets `whisper-cli.exe` actually run on each backend. We prune optimistically, run, and add back any DLL whose absence breaks the spawn.

- [ ] **Step 1: Replace the `resources` array**

In `src-tauri/tauri.conf.json`, replace this line:

```json
    "resources": ["binaries/whisper-cuda/*", "binaries/whisper-cpu/*"],
```

with this explicit list:

```json
    "resources": [
      "binaries/whisper-cpu/whisper-cli.exe",
      "binaries/whisper-cpu/whisper.dll",
      "binaries/whisper-cpu/ggml.dll",
      "binaries/whisper-cpu/ggml-base.dll",
      "binaries/whisper-cpu/ggml-cpu.dll",
      "binaries/whisper-cuda/whisper-cli.exe",
      "binaries/whisper-cuda/whisper.dll",
      "binaries/whisper-cuda/ggml.dll",
      "binaries/whisper-cuda/ggml-base.dll",
      "binaries/whisper-cuda/ggml-cpu.dll",
      "binaries/whisper-cuda/ggml-cuda.dll",
      "binaries/whisper-cuda/cudart64_12.dll",
      "binaries/whisper-cuda/cublas64_12.dll",
      "binaries/whisper-cuda/cublasLt64_12.dll",
      "binaries/whisper-cuda/nvrtc64_120_0.dll",
      "binaries/whisper-cuda/nvrtc-builtins64_124.dll"
    ],
```

- [ ] **Step 2: Build the installer**

Run: `npm run tauri build`
Expected: build succeeds. The NSIS/MSI installer should be visibly smaller than the previous release (compare file sizes if you have a prior build to hand).

- [ ] **Step 3: Install and verify CUDA path**

1. Install the freshly built `RudariFlow_x.y.z_x64-setup.exe`.
2. Launch the app.
3. Make sure GPU Backend is set to CUDA (or Auto on a CUDA machine).
4. Dictate a short phrase. If transcription succeeds → CUDA allowlist is correct.
5. If it fails: the Rust process logs (`%APPDATA%\com.rudariflow.app\startup.log`) will show whisper-cli's stderr, which on a missing-DLL failure looks like `0xc0000135` or "The code execution cannot proceed because <name>.dll was not found". Add the named DLL to `resources` and re-run from Step 2.

- [ ] **Step 4: Verify CPU path**

If you have a CPU-only machine handy, install on it and verify CPU dictation works. If you don't, force CPU on the CUDA machine: in settings, set GPU Backend = "CPU only", dictate, confirm it works.

- [ ] **Step 5: Commit**

Once both backends transcribe successfully:

```bash
git add src-tauri/tauri.conf.json
git commit -m "Prune unused whisper.cpp binaries from bundle (Phase C #5)"
```

If you had to add back any DLLs not in the original allowlist, note them in the commit body so we have a paper trail.

---

### Task 13: Idle-posture baseline measurements

**Files:**
- Modify: `docs/superpowers/specs/2026-05-08-rudariflow-phase-c-design.md`

- [ ] **Step 1: Install the freshly built v0.3.0 build on your primary machine**

Use the installer produced in Task 12.

- [ ] **Step 2: Capture idle-posture numbers**

With the app running, no dictation in flight, no settings window interaction:
1. Open Task Manager → Details tab → find `RudariFlow.exe` and any child processes (look for `whisper-cli.exe` — should NOT be running while idle).
2. Sort by CPU. Watch for ~10 s. Note the median CPU% for `RudariFlow.exe`.
3. Note the "Memory (private working set)" column for `RudariFlow.exe` and any WebView2 processes spawned for it (look for `msedgewebview2.exe` with `RudariFlow` in command line).

- [ ] **Step 3: Capture recording-active numbers**

Start a 5-second dictation in toggle mode:
1. Press hotkey, count "one mississippi" five times, press hotkey to stop.
2. During the recording window, note the CPU% spike for `RudariFlow.exe`.
3. During the *transcribing* phase, note: peak CPU% for `whisper-cli.exe`, peak memory for `whisper-cli.exe` (this is the model + activations).

- [ ] **Step 4: Append the baseline appendix to the spec**

In `docs/superpowers/specs/2026-05-08-rudariflow-phase-c-design.md`, append at the very bottom:

```markdown
---

## Baseline measurements (v0.3.0)

Captured on YYYY-MM-DD on <machine description>: CPU model, RAM, OS build, GPU model.

| Phase | Process | CPU% (median) | Memory (private working set) |
|-------|---------|---------------|------------------------------|
| Idle  | RudariFlow.exe | _ % | _ MB |
| Idle  | WebView2 (×2)  | _ % | _ MB |
| Recording | RudariFlow.exe | _ % | _ MB |
| Transcribing (large-v3-turbo, CUDA) | whisper-cli.exe | _ % | _ MB |
| Transcribing (small, CPU) | whisper-cli.exe | _ % | _ MB |

**End-to-end latency** (hotkey-released → text pasted), median over 5 runs of a ~5 s clip:
- large-v3-turbo CUDA: _ ms
- small CPU: _ ms

**Notes:** anything unexpected — e.g. RAM that didn't drop after transcription, idle CPU above 1%.

These numbers are the "before" column for Phase B.
```

Fill in the underscore placeholders with your measurements. Don't ship empty placeholders — if you can't measure a row (e.g. no CPU-only machine), delete that row instead.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-05-08-rudariflow-phase-c-design.md
git commit -m "Add v0.3.0 idle-posture baseline measurements (Phase C #9)"
```

---

### Task 14: Bump version and ship

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `index.html` (the version label in the sidebar footer)

- [ ] **Step 1: Bump version to 0.3.0 in all four files**

- `package.json`: `"version": "0.3.0"`
- `src-tauri/Cargo.toml`: `version = "0.3.0"`
- `src-tauri/tauri.conf.json`: `"version": "0.3.0"`
- `index.html`: change `<span class="version-text">v0.2.0</span>` to `<span class="version-text">v0.3.0</span>`

- [ ] **Step 2: Run the full test suite one last time**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all tests pass.

Run: `npm run build`
Expected: clean TS build.

- [ ] **Step 3: Run through the manual checklist from the spec**

Tick each box in the "Manual test checklist" section of [docs/superpowers/specs/2026-05-08-rudariflow-phase-c-design.md](../specs/2026-05-08-rudariflow-phase-c-design.md). Any failure here goes back to the relevant task before release.

- [ ] **Step 4: Build the release installer**

Run: `npm run tauri build`
Expected: `RudariFlow_0.3.0_x64-setup.exe` and the MSI in `src-tauri/target/release/bundle/`.

- [ ] **Step 5: Commit version bump**

```bash
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock index.html
git commit -m "v0.3.0 — Phase C surgical wins"
git tag v0.3.0
```

---

## Self-review checklist (run by the engineer before declaring done)

- [ ] Every spec change (#1–#9) corresponds to at least one task above.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes locally with no warnings.
- [ ] `npm run build` produces no TypeScript errors.
- [ ] `npm run tauri build` produces an installer that's visibly smaller than v0.2.0.
- [ ] Manual test checklist from the spec is fully ticked.
- [ ] Baseline measurements appendix in the spec has real numbers, no underscores.
