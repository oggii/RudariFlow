# Files tab: export, speakers, a resizable window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Files tab separates speakers (Off / Auto / 2–8), exports PDF, Word, SRT, VTT and text, and the main window can be resized and maximised.

**Architecture:** A new `speakers` module wraps sherpa-onnx's C API (shared DLLs, delay-loaded) and assigns speakers to Whisper segments; `file_transcribe` formats paragraphs with names; a new `export` module writes text, subtitles, Word and the HTML that a new `pdf` module prints with WebView2. The Files tab keeps the segments and names and renders through the backend. The window gets size limits and `tauri-plugin-window-state`.

**Tech Stack:** Rust (Tauri 2.10.3), sherpa-rs-sys 0.6.8 (sherpa-onnx v1.12.9 C API), docx-rs 0.4, webview2-com 0.38, tauri-plugin-window-state 2.4, TypeScript (vanilla, Vite).

**Spec:** `docs/superpowers/specs/2026-09-24-files-export-speakers-design.md`

## Global Constraints

- Windows 10/11 x64. Everything runs locally; the only downloads are the pinned runtime (build time) and the two speaker models (first use).
- sherpa-onnx runtime: `sherpa-onnx-v1.12.9-win-x64-shared-no-tts.tar.bz2`, SHA-256 `ddd697771ffbf8db35bda6232b898f0c7778db9ac39ed01cd800f79af5d7180a`, from `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.12.9/`.
- Crate: `sherpa-rs-sys = { version = "=0.6.8", default-features = false }` (the `sherpa-rs` wrapper hard-codes one thread; do not use it).
- Segmentation model: `https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx`, 5 992 913 bytes, SHA-256 `220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079`, saved as `<app dir>\speakers\segmentation.onnx`.
- Embedding model: `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`, 39 593 761 bytes, SHA-256 `1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b`, saved as `<app dir>\speakers\embedding.onnx`.
- Clustering: Auto threshold `0.9` (`num_clusters = -1`); a number sets `num_clusters`. `min_duration_on = 0.3`, `min_duration_off = 0.5`. Threads: half the logical CPUs, at least 1, at most 8.
- Setting `fileSpeakers` (Rust `file_speakers`): `"off"` | `"auto"` | `"2"` … `"8"`, default `"off"`.
- Subtitles: at most 2 lines of 42 characters per cue; split at a sentence end, else a comma, else a space; time shared by characters; a cue lasts at least 1 000 ms unless the next one starts earlier. SRT `HH:MM:SS,mmm`, name as `Name: `; VTT `WEBVTT`, `HH:MM:SS.mmm`, name as `<v Name>`.
- PDF and Word paper: A4 (210 × 297 mm) unless the Windows region (`GetUserGeoID(GEOCLASS_NATION)`) is 244 (US) or 39 (Canada), then Letter. Margins 20 mm. PDF page numbers `n / total`.
- Window: `resizable: true`, `maximizable: true`, `minWidth: 900`, `minHeight: 600`.
- Every new UI string exists in English and German in `src/i18n.ts`.
- Build: from `src-tauri`, `CARGO_TARGET_DIR=C:\r`, CUDA 13.4 (`CUDA_PATH`, `CUDA_PATH_V13_4`), `CMAKE_POLICY_VERSION_MINIMUM=3.5`. Unit tests: `cargo test --no-default-features --lib --bins` with `CARGO_TARGET_DIR=C:\t\rf-cpu`. Frontend: `npx tsc --noEmit` from the repo root.
- Run `scripts\setup-*.ps1` from PowerShell, not Git Bash (Git's GNU tar misreads `C:\` paths).
- Commits: `feat:`, `fix:`, `docs:`, `test:`; each message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## File map

| File | Responsibility |
|---|---|
| `scripts/setup-speakers.ps1` (new) | Download and unpack the pinned sherpa-onnx runtime to `src-tauri/binaries/sherpa-onnx` |
| `src-tauri/.cargo/config.toml` (new) | `SHERPA_LIB_PATH` for `sherpa-rs-sys` |
| `src-tauri/build.rs` | Delay-load `sherpa-onnx-c-api.dll` |
| `src-tauri/src/speakers.rs` (new) | Runtime check, model files, `separate`, `assign`, setting parsing |
| `src-tauri/src/file_transcribe.rs` | `Paragraph`, `paragraphs`, `speaker_name`, `format(segments, names, times)` |
| `src-tauri/src/whisper_engine.rs` | `Segment.speaker` |
| `src-tauri/src/export.rs` (new) | `ExportDoc`, `Paper`, text, cues, SRT, VTT, DOCX, PDF HTML |
| `src-tauri/src/pdf.rs` (new) | Hidden webview window + WebView2 `PrintToPdf` |
| `src-tauri/src/main.rs` | `transcribe_file` with speakers, commands `format_file_text`, `speaker_model_status`, `speaker_model_download`, `export_file`; window-state plugin |
| `src-tauri/src/settings.rs` | `file_speakers` |
| `src/files.ts` | Speakers selector, chips, Export menu, collapsible summary |
| `src/main.ts` | `fileSpeakers` in `Settings`, `saveSettings` for the Files module |
| `index.html`, `src/style.css`, `src/i18n.ts` | Markup, layout for a resizable window, strings |
| `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` | DLL resources, window limits, crates |

---

### Task 1: sherpa-onnx runtime in the build

**Files:**
- Create: `scripts/setup-speakers.ps1`
- Create: `src-tauri/.cargo/config.toml`
- Create: `src-tauri/src/speakers.rs`
- Create: `src-tauri/examples/speakers_probe.rs`
- Modify: `src-tauri/Cargo.toml` (dependency, `windows-sys` feature, example)
- Modify: `src-tauri/build.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/tauri.conf.json` (resources)

**Interfaces:**
- Produces: `rudariflow_lib::speakers::runtime_available() -> bool`; the crate `sherpa_rs_sys` linked against `binaries/sherpa-onnx/lib`.

- [ ] **Step 1: Write the setup script**

`scripts/setup-speakers.ps1`:

```powershell
# RudariFlow - sherpa-onnx runtime for speaker separation (Files tab)
#
# Run once after cloning the repo (and after changing the pinned version):
#   powershell -ExecutionPolicy Bypass -File scripts/setup-speakers.ps1
#
# Downloads the pinned sherpa-onnx Windows shared build (without TTS), checks
# its SHA-256 and unpacks its lib folder to src-tauri\binaries\sherpa-onnx.
# The build links against its import library (SHERPA_LIB_PATH in
# src-tauri\.cargo\config.toml). The installer ships sherpa-onnx-c-api.dll
# and onnxruntime.dll next to rudariflow.exe, which delay-loads them: a
# missing DLL only turns speaker separation off. The static build is not
# used: it links the static C runtime, which clashes with the rest of the app.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Version = "v1.12.9"
$Name = "sherpa-onnx-$Version-win-x64-shared-no-tts"
$Archive = "$Name.tar.bz2"
$Sha256 = "ddd697771ffbf8db35bda6232b898f0c7778db9ac39ed01cd800f79af5d7180a"
$Url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/$Version/$Archive"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DestDir = Join-Path $RepoRoot "src-tauri\binaries\sherpa-onnx"
$Work = Join-Path ([IO.Path]::GetTempPath()) "rudariflow-$Name"

function Get-Sha256($path) { (Get-FileHash -Path $path -Algorithm SHA256).Hash.ToLower() }

New-Item -ItemType Directory -Path $Work -Force | Out-Null
$path = Join-Path $Work $Archive
if (-not (Test-Path $path) -or (Get-Sha256 $path) -ne $Sha256) {
    Write-Host "Downloading $Archive ..."
    Invoke-WebRequest -Uri $Url -OutFile $path -UseBasicParsing
}
$hash = Get-Sha256 $path
if ($hash -ne $Sha256) { throw "SHA-256 mismatch for ${Archive}: got $hash, expected $Sha256" }

$unpacked = Join-Path $Work "unpacked"
if (Test-Path $unpacked) { Remove-Item -Recurse -Force $unpacked }
New-Item -ItemType Directory -Path $unpacked -Force | Out-Null
# Windows' own tar (bsdtar) reads .tar.bz2.
& "$env:SystemRoot\System32\tar.exe" -xjf $path -C $unpacked
if ($LASTEXITCODE -ne 0) { throw "Could not unpack $Archive" }

# Emptied rather than deleted: a shell or Explorer in the folder would block it.
New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
Get-ChildItem -Path $DestDir | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $unpacked "$Name\lib") -Destination $DestDir -Recurse
$megabytes = (Get-ChildItem $DestDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ("sherpa-onnx {0} ready in {1} ({2:N0} MB)" -f $Version, $DestDir, $megabytes) -ForegroundColor Green
```

- [ ] **Step 2: Run it**

Run (PowerShell): `powershell -ExecutionPolicy Bypass -File scripts/setup-speakers.ps1`
Expected: `sherpa-onnx v1.12.9 ready in ...\src-tauri\binaries\sherpa-onnx (… MB)`, and `src-tauri\binaries\sherpa-onnx\lib` contains `sherpa-onnx-c-api.dll`, `sherpa-onnx-c-api.lib`, `onnxruntime.dll`, `onnxruntime_providers_shared.dll`.

- [ ] **Step 3: Point sherpa-rs-sys at it and add the crate**

`src-tauri/.cargo/config.toml`:

```toml
[env]
# sherpa-onnx (speaker separation in the Files tab), unpacked by
# scripts/setup-speakers.ps1; sherpa-rs-sys links its import library
# instead of downloading or building sherpa-onnx.
SHERPA_LIB_PATH = { value = "binaries/sherpa-onnx", relative = true }
```

In `src-tauri/Cargo.toml`, under `[target.'cfg(windows)'.dependencies]`, add after the `windows = …` entry:

```toml
# Speaker separation in the Files tab (src/speakers.rs): the C API of
# sherpa-onnx v1.12.9 from the shared build in binaries/sherpa-onnx
# (scripts/setup-speakers.ps1). Not the sherpa-rs wrapper: it runs the
# models on one thread, three times slower.
sherpa-rs-sys = { version = "=0.6.8", default-features = false }
```

In the same section add `"Win32_System_LibraryLoader",` to the `windows-sys` feature list (alphabetical, after `"Win32_Graphics_Dwm",`). Add the example at the end of the `[[example]]` entries:

```toml
[[example]]
name = "speakers_probe"
path = "examples/speakers_probe.rs"
```

- [ ] **Step 4: Delay-load the DLL**

Replace `src-tauri/build.rs` with:

```rust
fn main() {
    // Delay-loaded DLLs: rudariflow.exe starts without them and loads each
    // the first time it is used.
    // - nvcuda.dll: ggml's CUDA backend imports it, and only an NVIDIA
    //   display driver provides it. As a normal import, rudariflow.exe would
    //   fail to start on AMD / Intel / no-GPU machines.
    // - sherpa-onnx-c-api.dll: speaker separation in the Files tab
    //   (src/speakers.rs checks that it loads before calling it), so a
    //   missing DLL only turns speaker separation off.
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    if windows {
        let mut delayed = vec!["sherpa-onnx-c-api.dll"];
        if std::env::var_os("CARGO_FEATURE_CUDA").is_some() {
            delayed.push("nvcuda.dll");
        }
        for dll in delayed {
            println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}");
        }
        println!("cargo:rustc-link-arg=delayimp.lib");
    }
    tauri_build::build()
}
```

- [ ] **Step 5: Ship the DLLs**

In `src-tauri/tauri.conf.json` → `bundle.resources`, add after the `vulkan-1.dll` entry:

```json
      "binaries/sherpa-onnx/lib/sherpa-onnx-c-api.dll": "sherpa-onnx-c-api.dll",
      "binaries/sherpa-onnx/lib/onnxruntime.dll": "onnxruntime.dll",
      "binaries/sherpa-onnx/lib/onnxruntime_providers_shared.dll": "onnxruntime_providers_shared.dll",
```

- [ ] **Step 6: Runtime check and probe**

`src-tauri/src/speakers.rs`:

```rust
//! Speaker separation for the Files tab: who speaks when, with sherpa-onnx
//! (pyannote segmentation 3.0 and the 3D-Speaker ERes2Net voice embedding).

/// sherpa-onnx's C API, next to rudariflow.exe (delay-loaded, see build.rs).
const RUNTIME_DLL: &str = "sherpa-onnx-c-api.dll";

/// Whether the sherpa-onnx runtime loads. Checked before every call into
/// it: a delay-loaded DLL that is missing would end the process.
pub fn runtime_available() -> bool {
    imp::load(RUNTIME_DLL)
}

#[cfg(windows)]
mod imp {
    pub fn load(dll: &str) -> bool {
        use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;
        let wide: Vec<u16> = dll.encode_utf16().chain(std::iter::once(0)).collect();
        // The module stays loaded; the delay-load helper then finds it.
        !unsafe { LoadLibraryW(wide.as_ptr()) }.is_null()
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn load(_dll: &str) -> bool {
        false
    }
}
```

Add `pub mod speakers;` at the end of the module list in `src-tauri/src/lib.rs`.

`src-tauri/examples/speakers_probe.rs`:

```rust
//! The sherpa-onnx runtime loads and answers. Run with the runtime on PATH:
//!   $env:PATH = "$PWD\binaries\sherpa-onnx\lib;$env:PATH"
//!   cargo run --release --example speakers_probe

fn main() {
    assert!(
        rudariflow_lib::speakers::runtime_available(),
        "sherpa-onnx-c-api.dll does not load; is binaries\\sherpa-onnx\\lib on PATH?"
    );
    let version = unsafe { std::ffi::CStr::from_ptr(sherpa_rs_sys::SherpaOnnxGetVersionStr()) };
    println!("sherpa-onnx {}", version.to_string_lossy());
}
```

- [ ] **Step 7: Build and run the probe**

Run (from `src-tauri`, PowerShell, with the build environment set): `$env:PATH = "$PWD\binaries\sherpa-onnx\lib;$env:PATH"; cargo run --release --example speakers_probe`
Expected: `sherpa-onnx 1.12.9`

- [ ] **Step 8: The app still starts without the DLL on PATH, and tests pass**

Run: `cargo test --no-default-features --lib --bins` (from `src-tauri`, `CARGO_TARGET_DIR=C:\t\rf-cpu`, without the sherpa folder on PATH)
Expected: all tests pass (nothing calls into sherpa-onnx yet; the DLL is delay-loaded).

- [ ] **Step 9: Commit**

```bash
git add scripts/setup-speakers.ps1 src-tauri/.cargo/config.toml src-tauri/build.rs src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src-tauri/src/lib.rs src-tauri/src/speakers.rs src-tauri/examples/speakers_probe.rs
git commit -m "feat: sherpa-onnx runtime for speaker separation, delay-loaded"
```

---

### Task 2: Speakers of segments (pure logic)

**Files:**
- Modify: `src-tauri/src/speakers.rs`

**Interfaces:**
- Produces:
  - `pub struct Turn { pub start_ms: u64, pub end_ms: u64, pub speaker: u32 }` (derive `Debug, Clone, Copy, PartialEq`)
  - `pub enum SpeakerCount { Auto, Exactly(u32) }` (derive `Debug, Clone, Copy, PartialEq`)
  - `pub fn parse_setting(value: &str) -> Option<SpeakerCount>` — `None` for "off" or anything invalid
  - `pub fn assign(spans: &[(u64, u64)], turns: &[Turn]) -> Vec<Option<u8>>`

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/speakers.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn turn(start_s: f32, end_s: f32, speaker: u32) -> Turn {
        Turn { start_ms: (start_s * 1000.0) as u64, end_ms: (end_s * 1000.0) as u64, speaker }
    }

    #[test]
    fn segments_take_the_speaker_with_most_overlap_numbered_by_first_voice() {
        // sherpa-onnx calls the first voice 1 here; RudariFlow calls it 0.
        let turns = [turn(0.0, 5.0, 1), turn(5.0, 9.0, 0)];
        let spans = [(0, 4_000), (4_500, 8_000), (8_500, 9_500)];
        assert_eq!(assign(&spans, &turns), vec![Some(0), Some(1), Some(1)]);
    }

    #[test]
    fn gaps_go_to_the_nearest_turn_and_ties_to_the_earlier_voice() {
        let turns = [turn(0.0, 9.0, 0), turn(12.5, 20.0, 1)];
        // 10-11 s: 1 s after the first turn, 1.5 s before the second.
        assert_eq!(assign(&[(10_000, 11_000)], &turns), vec![Some(0)]);
        // Equal overlap with both: the voice heard first wins.
        let tie = [turn(0.0, 2.0, 0), turn(2.0, 4.0, 1)];
        assert_eq!(assign(&[(1_000, 3_000)], &tie), vec![Some(0)]);
    }

    #[test]
    fn no_turns_means_no_speakers() {
        assert_eq!(assign(&[(0, 1_000), (1_000, 2_000)], &[]), vec![None, None]);
    }

    #[test]
    fn the_setting_reads_off_auto_and_two_to_eight() {
        assert_eq!(parse_setting("off"), None);
        assert_eq!(parse_setting("auto"), Some(SpeakerCount::Auto));
        assert_eq!(parse_setting("3"), Some(SpeakerCount::Exactly(3)));
        assert_eq!(parse_setting("8"), Some(SpeakerCount::Exactly(8)));
        for bad in ["1", "9", "", "two"] {
            assert_eq!(parse_setting(bad), None, "{bad}");
        }
    }
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `cargo test --no-default-features --lib speakers`
Expected: compile errors (`Turn`, `assign`, `parse_setting`, `SpeakerCount` not found).

- [ ] **Step 3: Implement**

Insert above the `#[cfg(windows)] mod imp` block in `src-tauri/src/speakers.rs`:

```rust
/// Who speaks from `start_ms` to `end_ms`, as sherpa-onnx numbers the
/// speakers (0-based, in no particular order).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Turn {
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker: u32,
}

/// How many speakers to separate: found by the model, or a given number.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SpeakerCount {
    Auto,
    Exactly(u32),
}

/// The Files tab's setting: "off", "auto" or "2" … "8". `None` means off
/// (and anything unknown).
pub fn parse_setting(value: &str) -> Option<SpeakerCount> {
    match value.trim() {
        "auto" => Some(SpeakerCount::Auto),
        other => other.parse::<u32>().ok().filter(|n| (2..=8).contains(n)).map(SpeakerCount::Exactly),
    }
}

/// The speaker of each span (a Whisper segment, start and end in ms): the
/// one that talks most during it; a span no turn overlaps gets the nearest
/// turn's speaker; a tie goes to the voice heard first. Speakers are then
/// numbered by their first span, so the first voice is 0.
pub fn assign(spans: &[(u64, u64)], turns: &[Turn]) -> Vec<Option<u8>> {
    if turns.is_empty() {
        return vec![None; spans.len()];
    }
    let first_heard = |speaker: u32| {
        turns.iter().filter(|t| t.speaker == speaker).map(|t| t.start_ms).min().unwrap_or(u64::MAX)
    };
    let mut speakers: Vec<u32> = turns.iter().map(|t| t.speaker).collect();
    speakers.sort_unstable();
    speakers.dedup();
    // Earlier voice first, so `max_by_key` keeps it on a tie when reversed.
    speakers.sort_by_key(|&s| first_heard(s));

    let raw: Vec<u32> = spans
        .iter()
        .map(|&(start, end)| {
            let overlap = |s: u32| -> u64 {
                turns
                    .iter()
                    .filter(|t| t.speaker == s)
                    .map(|t| end.min(t.end_ms).saturating_sub(start.max(t.start_ms)))
                    .sum()
            };
            let distance = |s: u32| -> u64 {
                turns
                    .iter()
                    .filter(|t| t.speaker == s)
                    .map(|t| {
                        if t.end_ms <= start {
                            start - t.end_ms
                        } else if t.start_ms >= end {
                            t.start_ms - end
                        } else {
                            0
                        }
                    })
                    .min()
                    .unwrap_or(u64::MAX)
            };
            // First maximum (earliest voice) on a tie.
            let best = speakers.iter().copied().fold(None::<(u32, u64)>, |best, s| {
                let o = overlap(s);
                match best {
                    Some((_, b)) if b >= o => best,
                    _ => Some((s, o)),
                }
            });
            match best {
                Some((s, o)) if o > 0 => s,
                _ => speakers.iter().copied().min_by_key(|&s| distance(s)).unwrap_or(speakers[0]),
            }
        })
        .collect();

    let mut order: Vec<u32> = Vec::new();
    raw.iter()
        .map(|&s| {
            let index = order.iter().position(|&o| o == s).unwrap_or_else(|| {
                order.push(s);
                order.len() - 1
            });
            u8::try_from(index).ok()
        })
        .collect()
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test --no-default-features --lib speakers`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/speakers.rs
git commit -m "feat: speakers of segments from speaker turns"
```

---

### Task 3: Speaker models and separation

**Files:**
- Modify: `src-tauri/src/speakers.rs`
- Modify: `src-tauri/Cargo.toml` (`sha2`, example)
- Create: `src-tauri/examples/speakers_bench.rs`

**Interfaces:**
- Consumes: `runtime_available()`, `Turn`, `SpeakerCount` (Tasks 1–2); `crate::downloader::{download_file, DownloadProgress}`.
- Produces:
  - `pub fn model_dir(app_dir: &Path) -> PathBuf` → `<app dir>\speakers`
  - `pub fn models_ready(app_dir: &Path) -> bool`
  - `pub async fn download_models(app_dir: &Path, on_progress: impl FnMut(DownloadProgress)) -> Result<(), String>` (progress covers both files together)
  - `pub fn threads() -> i32`
  - `pub fn separate(audio: &[f32], count: SpeakerCount, app_dir: &Path, progress: &mut dyn FnMut(u32, u32)) -> Result<Vec<Turn>, String>`

- [ ] **Step 1: Add sha2**

In `src-tauri/Cargo.toml` `[dependencies]` add `sha2 = "0.10"`, and the example:

```toml
[[example]]
name = "speakers_bench"
path = "examples/speakers_bench.rs"
```

- [ ] **Step 2: Write the failing test for the model list and threads**

Add to the `tests` module in `speakers.rs`:

```rust
    #[test]
    fn models_are_pinned_and_threads_are_capped() {
        assert_eq!(MODELS.len(), 2);
        for m in &MODELS {
            assert_eq!(m.sha256.len(), 64, "{}", m.file);
            assert!(m.url.starts_with("https://"), "{}", m.file);
        }
        let dir = std::env::temp_dir().join("rudariflow_speakers_ready");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!models_ready(&dir));
        assert!((1..=8).contains(&threads()));
    }
```

Run: `cargo test --no-default-features --lib speakers`
Expected: FAIL to compile (`MODELS`, `models_ready`, `threads` missing).

- [ ] **Step 3: Implement models, download and separation**

Add to `speakers.rs` (below `assign`):

```rust
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::downloader::{download_file, DownloadProgress};

/// A model file of the speaker separation, pinned by size and SHA-256.
pub struct ModelFile {
    pub file: &'static str,
    pub url: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

/// pyannote segmentation 3.0 (where speech and speaker changes are) and
/// 3D-Speaker ERes2Net (a voice fingerprint per stretch of speech). ERes2Net
/// labelled the probe files best of four embedding models (see the spec).
pub const MODELS: [ModelFile; 2] = [
    ModelFile {
        file: "segmentation.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx",
        bytes: 5_992_913,
        sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
    },
    ModelFile {
        file: "embedding.onnx",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
        bytes: 39_593_761,
        sha256: "1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b",
    },
];

/// With a number, clustering makes exactly that many speakers; with Auto it
/// merges voices closer than this. 0.9 was the only value that counted the
/// three probe files right (4, 2 and 2 speakers).
const AUTO_THRESHOLD: f32 = 0.9;
/// sherpa-onnx's defaults, used in the probe: shorter speech is dropped,
/// shorter gaps of one speaker are closed.
const MIN_DURATION_ON: f32 = 0.3;
const MIN_DURATION_OFF: f32 = 0.5;

pub fn model_dir(app_dir: &Path) -> PathBuf {
    app_dir.join("speakers")
}

/// Both model files are there with their full size (the SHA-256 is checked
/// once, after the download).
pub fn models_ready(app_dir: &Path) -> bool {
    MODELS.iter().all(|m| {
        std::fs::metadata(model_dir(app_dir).join(m.file)).is_ok_and(|meta| meta.len() == m.bytes)
    })
}

fn sha256_of(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Download the missing model files, resumable, each checked by SHA-256.
/// `on_progress` gets the bytes of both files together.
pub async fn download_models(app_dir: &Path, mut on_progress: impl FnMut(DownloadProgress)) -> Result<(), String> {
    let dir = model_dir(app_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let total: u64 = MODELS.iter().map(|m| m.bytes).sum();
    let mut before = 0;
    for m in &MODELS {
        let dest = dir.join(m.file);
        if !std::fs::metadata(&dest).is_ok_and(|meta| meta.len() == m.bytes) {
            download_file(m.url, &dest, |p| {
                let downloaded = before + p.downloaded;
                on_progress(DownloadProgress { downloaded, total, percent: downloaded as f64 * 100.0 / total as f64 });
            })
            .await?;
            if sha256_of(&dest)? != m.sha256 {
                let _ = std::fs::remove_file(&dest);
                return Err(format!("{} did not download correctly; please try again", m.file));
            }
        }
        before += m.bytes;
    }
    Ok(())
}

/// Threads for separation: half the logical CPUs, 1 to 8. On a 24-thread
/// Ryzen 9 7900X 8 threads were fastest (12 were slower).
pub fn threads() -> i32 {
    let logical = std::thread::available_parallelism().map_or(2, |n| n.get());
    (logical / 2).clamp(1, 8) as i32
}

unsafe extern "C" fn progress_callback(done: i32, total: i32, arg: *mut std::ffi::c_void) -> i32 {
    let progress = &mut *(arg as *mut &mut dyn FnMut(u32, u32));
    progress(done.max(0) as u32, total.max(0) as u32);
    0
}

/// Who speaks when in `audio` (16 kHz mono), on the CPU. `progress(done,
/// total)` comes from sherpa-onnx while it runs (chunks of the file).
pub fn separate(
    audio: &[f32],
    count: SpeakerCount,
    app_dir: &Path,
    progress: &mut dyn FnMut(u32, u32),
) -> Result<Vec<Turn>, String> {
    use sherpa_rs_sys as sys;
    use std::ffi::CString;

    if !runtime_available() {
        return Err("the speaker runtime (sherpa-onnx-c-api.dll) is missing".to_string());
    }
    let dir = model_dir(app_dir);
    let path = |file: &str| CString::new(dir.join(file).to_string_lossy().as_bytes()).map_err(|e| e.to_string());
    let segmentation = path(MODELS[0].file)?;
    let embedding = path(MODELS[1].file)?;
    let provider = CString::new("cpu").expect("no NUL");
    let threads = threads();
    let num_clusters = match count {
        SpeakerCount::Auto => -1,
        SpeakerCount::Exactly(n) => n as i32,
    };
    let config = sys::SherpaOnnxOfflineSpeakerDiarizationConfig {
        segmentation: sys::SherpaOnnxOfflineSpeakerSegmentationModelConfig {
            pyannote: sys::SherpaOnnxOfflineSpeakerSegmentationPyannoteModelConfig { model: segmentation.as_ptr() },
            num_threads: threads,
            debug: 0,
            provider: provider.as_ptr(),
        },
        embedding: sys::SherpaOnnxSpeakerEmbeddingExtractorConfig {
            model: embedding.as_ptr(),
            num_threads: threads,
            debug: 0,
            provider: provider.as_ptr(),
        },
        clustering: sys::SherpaOnnxFastClusteringConfig { num_clusters, threshold: AUTO_THRESHOLD },
        min_duration_on: MIN_DURATION_ON,
        min_duration_off: MIN_DURATION_OFF,
    };

    struct Diarization(*const sys::SherpaOnnxOfflineSpeakerDiarization);
    impl Drop for Diarization {
        fn drop(&mut self) {
            unsafe { sys::SherpaOnnxDestroyOfflineSpeakerDiarization(self.0) }
        }
    }

    unsafe {
        let sd = sys::SherpaOnnxCreateOfflineSpeakerDiarization(&config);
        if sd.is_null() {
            return Err("the speaker model could not be loaded".to_string());
        }
        let sd = Diarization(sd);
        let rate = sys::SherpaOnnxOfflineSpeakerDiarizationGetSampleRate(sd.0);
        if rate != 16_000 {
            return Err(format!("the speaker model expects {rate} Hz"));
        }
        let mut progress: &mut dyn FnMut(u32, u32) = progress;
        let arg = &mut progress as *mut &mut dyn FnMut(u32, u32) as *mut std::ffi::c_void;
        let result = sys::SherpaOnnxOfflineSpeakerDiarizationProcessWithCallback(
            sd.0,
            audio.as_ptr(),
            audio.len() as i32,
            Some(progress_callback),
            arg,
        );
        if result.is_null() {
            return Err("speaker separation failed".to_string());
        }
        let n = sys::SherpaOnnxOfflineSpeakerDiarizationResultGetNumSegments(result);
        let segments = sys::SherpaOnnxOfflineSpeakerDiarizationResultSortByStartTime(result);
        let mut turns = Vec::new();
        if !segments.is_null() && n > 0 {
            for s in std::slice::from_raw_parts(segments, n as usize) {
                turns.push(Turn {
                    start_ms: (s.start.max(0.0) * 1000.0) as u64,
                    end_ms: (s.end.max(0.0) * 1000.0) as u64,
                    speaker: s.speaker.max(0) as u32,
                });
            }
            sys::SherpaOnnxOfflineSpeakerDiarizationDestroySegment(segments);
        }
        sys::SherpaOnnxOfflineSpeakerDiarizationDestroyResult(result);
        Ok(turns)
    }
}
```

If the bindgen signatures differ (e.g. `audio.as_ptr()` needs `*mut f32`, or the callback type is not `Option<…>`), adapt the call to the generated `bindings.rs` (in `C:\r\release\build\sherpa-rs-sys-*\out\bindings.rs`), keeping the behaviour.

- [ ] **Step 4: Run the unit tests**

Run: `cargo test --no-default-features --lib speakers`
Expected: 5 passed.

- [ ] **Step 5: Bench example**

`src-tauri/examples/speakers_bench.rs`:

```rust
//! Speaker separation on a 16 kHz mono 16-bit WAV: turns, speakers, time.
//! <app dir> must hold speakers\segmentation.onnx and speakers\embedding.onnx;
//! the sherpa-onnx runtime must be on PATH (see speakers_probe).
//!   cargo run --release --example speakers_bench -- <app dir> <wav> [auto|2..8]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(args.len() >= 3, "usage: speakers_bench <app dir> <wav> [auto|2..8]");
    let app_dir = std::path::PathBuf::from(&args[1]);
    let audio = rudariflow_lib::history::read_wav(std::path::Path::new(&args[2])).expect("16 kHz mono 16-bit WAV");
    let count = rudariflow_lib::speakers::parse_setting(args.get(3).map_or("auto", String::as_str)).expect("auto or 2..8");
    let started = std::time::Instant::now();
    let turns = rudariflow_lib::speakers::separate(&audio, count, &app_dir, &mut |done, total| {
        eprint!("\r{done}/{total}");
    })
    .expect("separate");
    eprintln!();
    for t in &turns {
        println!("{:>8.2} -- {:>8.2}  speaker {}", t.start_ms as f64 / 1000.0, t.end_ms as f64 / 1000.0, t.speaker);
    }
    let mut speakers: Vec<u32> = turns.iter().map(|t| t.speaker).collect();
    speakers.sort_unstable();
    speakers.dedup();
    println!(
        "{} speakers, {} turns, {:.1} s for {:.1} s of audio ({} threads)",
        speakers.len(),
        turns.len(),
        started.elapsed().as_secs_f64(),
        audio.len() as f64 / 16_000.0,
        rudariflow_lib::speakers::threads()
    );
}
```

- [ ] **Step 6: Get the models and test files, run the bench**

Download the two models into `C:\t\rf-test-data\speakers\` with the names `segmentation.onnx` and `embedding.onnx` (URLs in Global Constraints) and check their SHA-256 with `Get-FileHash`. Test files (16 kHz mono 16-bit WAV): the meeting file (`ffmpeg -i master.wav -ar 16000 -ac 1 meeting16k.wav`, voices Zira / Hazel / Zira at 0:01, 1:15, 2:30) and sherpa's `0-four-speakers-zh.wav` from `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/0-four-speakers-zh.wav`.

Run (from `src-tauri`, runtime on PATH): `cargo run --release --example speakers_bench -- C:\t\rf-test-data meeting16k.wav 2` and the same with `auto`, and `0-four-speakers-zh.wav 4` and `auto`.
Expected: meeting: 2 speakers, the turns around 1:15 have the other speaker than the ones at 0:01 and 2:30, with 2 and with auto. Four-speakers file: 4 speakers with 4 and with auto. Time well under 10 % of the audio length.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/speakers.rs src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/examples/speakers_bench.rs
git commit -m "feat: speaker models and separation with sherpa-onnx"
```

---

### Task 4: Segments with speakers, paragraphs with names

**Files:**
- Modify: `src-tauri/src/whisper_engine.rs` (`Segment`)
- Modify: `src-tauri/src/file_transcribe.rs`
- Modify: `src-tauri/src/main.rs` (callers of `format`)

**Interfaces:**
- Produces:
  - `Segment { start_ms, end_ms, text, speaker: Option<u8> }` — serde: `startMs`, `endMs`, `text`, `speaker` (omitted when `None`), also `Deserialize`
  - `pub struct Paragraph { pub start_ms: u64, pub speaker: Option<u8>, pub text: String }` in `file_transcribe`
  - `pub fn paragraphs(segments: &[Segment]) -> Vec<Paragraph>`
  - `pub fn speaker_name(names: &[String], speaker: u8) -> String`
  - `pub fn format(segments: &[Segment], names: &[String], times: bool) -> String`

- [ ] **Step 1: Segment gains a speaker**

In `whisper_engine.rs`, replace the `Segment` struct with:

```rust
/// A piece of a file transcript; times in ms from the start of the file.
/// `speaker` is set when the Files tab separated speakers (0 = first voice).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Segment {
    #[serde(rename = "startMs")]
    pub start_ms: u64,
    #[serde(rename = "endMs")]
    pub end_ms: u64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<u8>,
}
```

In `file_block`, the push becomes `out.push(Segment { start_ms: at(segment.start_timestamp()), end_ms: at(segment.end_timestamp()), text, speaker: None });`.

- [ ] **Step 2: Write the failing tests**

In `file_transcribe.rs` tests, change the helper and add speaker tests; replace every `format(&x, flag)` in existing tests with `format(&x, &[], flag)`:

```rust
    fn seg(start_s: f32, end_s: f32, text: &str) -> Segment {
        Segment { start_ms: (start_s * 1000.0) as u64, end_ms: (end_s * 1000.0) as u64, text: text.to_string(), speaker: None }
    }

    fn said(start_s: f32, end_s: f32, speaker: u8, text: &str) -> Segment {
        Segment { speaker: Some(speaker), ..seg(start_s, end_s, text) }
    }

    #[test]
    fn a_new_speaker_starts_a_paragraph_with_the_name() {
        let segments = vec![
            said(0.0, 2.0, 0, "Welcome."),
            said(2.1, 4.0, 0, "First topic."),
            said(4.2, 6.0, 1, "Version ten is out."),
            said(6.1, 8.0, 0, "Great."),
        ];
        let names = vec!["Saad".to_string()];
        assert_eq!(
            format(&segments, &names, true),
            "[0:00] Saad: Welcome. First topic.\n\n[0:04] Speaker 2: Version ten is out.\n\n[0:06] Saad: Great."
        );
        assert_eq!(
            format(&segments, &[], false),
            "Speaker 1: Welcome. First topic.\n\nSpeaker 2: Version ten is out.\n\nSpeaker 1: Great."
        );
        assert_eq!(paragraphs(&segments).len(), 3);
        assert_eq!(speaker_name(&["  ".to_string()], 0), "Speaker 1");
    }
```

Run: `cargo test --no-default-features --lib file_transcribe`
Expected: FAIL to compile (`paragraphs`, `speaker_name`, new `format` signature).

- [ ] **Step 3: Implement**

In `file_transcribe.rs`, replace `format` with:

```rust
/// A paragraph of a transcript: where it starts, who speaks, the text.
#[derive(Debug, Clone, PartialEq)]
pub struct Paragraph {
    pub start_ms: u64,
    pub speaker: Option<u8>,
    pub text: String,
}

/// The transcript in paragraphs: a new one after a pause, at a change of
/// speaker, or at a sentence end once a paragraph is long.
pub fn paragraphs(segments: &[Segment]) -> Vec<Paragraph> {
    let mut out: Vec<Paragraph> = Vec::new();
    let mut last_end = 0;
    for segment in segments {
        let text = segment.text.trim();
        if text.is_empty() {
            continue;
        }
        let new_paragraph = match out.last() {
            None => true,
            Some(p) => {
                p.speaker != segment.speaker
                    || segment.start_ms.saturating_sub(last_end) >= PARAGRAPH_PAUSE_MS
                    || (p.text.chars().count() >= PARAGRAPH_CHARS && p.text.ends_with(['.', '!', '?']))
            }
        };
        match out.last_mut() {
            Some(p) if !new_paragraph => {
                p.text.push(' ');
                p.text.push_str(text);
            }
            _ => out.push(Paragraph { start_ms: segment.start_ms, speaker: segment.speaker, text: capitalize_first(text) }),
        }
        last_end = segment.end_ms;
    }
    out
}

/// The name of speaker `speaker` (0 = first voice): the one the user gave,
/// else "Speaker 1", "Speaker 2", ….
pub fn speaker_name(names: &[String], speaker: u8) -> String {
    names
        .get(speaker as usize)
        .map(|n| n.trim())
        .filter(|n| !n.is_empty())
        .map_or_else(|| format!("Speaker {}", speaker as u32 + 1), str::to_string)
}

/// The transcript as text: paragraphs separated by a blank line; with
/// `times` each starts with its time ("[4:05] …"), with speakers with the
/// name ("[4:05] Saad: …").
pub fn format(segments: &[Segment], names: &[String], times: bool) -> String {
    paragraphs(segments)
        .into_iter()
        .map(|p| {
            let time = if times { format!("[{}] ", clock(p.start_ms)) } else { String::new() };
            let who = p.speaker.map_or(String::new(), |s| format!("{}: ", speaker_name(names, s)));
            format!("{time}{who}{}", p.text)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
```

In `main.rs` `transcribe_file`, the two calls become `file_transcribe::format(&segments, &[], false)` and `file_transcribe::format(&segments, &[], true)` (Task 5 replaces them).

- [ ] **Step 4: Run the tests**

Run: `cargo test --no-default-features --lib --bins`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/whisper_engine.rs src-tauri/src/file_transcribe.rs src-tauri/src/main.rs
git commit -m "feat: transcript paragraphs per speaker, with names"
```

---

### Task 5: Setting, separation next to Whisper, commands

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `speakers::{parse_setting, models_ready, runtime_available, separate, assign, download_models, model_dir}`, `file_transcribe::format`.
- Produces (commands, camelCase JSON):
  - `transcribe_file(path: String, language: String, speakers: String) -> FileTranscript { segments, speakers: u8, speakersError?: string, language, durationMs, elapsedMs }`; `file-progress` gains phase `"speakers"` (`done` = percent, `total` = 100)
  - `format_file_text(segments, names: string[], times: bool) -> string`
  - `speaker_model_status() -> { downloaded: bool, runtime: bool, downloading: bool }`
  - `speaker_model_download() -> ()`, events `speaker-model-progress` (`{ downloaded, total, percent }`); error `"busy"` when one runs
  - `speakersError` values: `"no_model"`, `"no_runtime"`, or an error text

- [ ] **Step 1: The setting**

In `settings.rs`, add the field after `learn_dictionary`:

```rust
    /// Files tab: "off", "auto" or "2" … "8" speakers to separate.
    #[serde(rename = "fileSpeakers", default = "default_file_speakers")]
    pub file_speakers: String,
```

the default function next to the others:

```rust
fn default_file_speakers() -> String {
    "off".to_string()
}
```

and `file_speakers: default_file_speakers(),` in `impl Default for Settings`. Add to the settings tests module:

```rust
    #[test]
    fn file_speakers_default_to_off() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s.file_speakers, "off");
    }
```

(If `Settings` cannot deserialize from `{}` because other fields are required, deserialize the existing test fixture used in the module instead and assert the same.)

Run: `cargo test --no-default-features --lib settings` — Expected: pass.

- [ ] **Step 2: transcribe_file with speakers**

In `main.rs`, replace `FileTranscript` and extend `FileProgress`'s doc comment:

```rust
#[derive(serde::Serialize)]
struct FileTranscript {
    segments: Vec<rudariflow_lib::whisper_engine::Segment>,
    /// Speakers found; 0 when not separated.
    speakers: u8,
    /// Why speakers are missing although asked for: "no_model",
    /// "no_runtime" or an error text.
    #[serde(rename = "speakersError", skip_serializing_if = "Option::is_none")]
    speakers_error: Option<String>,
    language: String,
    #[serde(rename = "durationMs")]
    duration_ms: u64,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
}
```

(`FileProgress.phase` doc: `"reading"`, `"loading"`, `"transcribing"` or `"speakers"`; for `"speakers"` `done` is the percent.)

Change the command signature to `async fn transcribe_file(app: AppHandle, state: State<'_, AppState>, path: String, language: String, speakers: String) -> Result<FileTranscript, String>` and replace the body of the `spawn_blocking` closure from `let audio = media::decode_16k_mono(...)` to its `Ok(FileTranscript { … })` with:

```rust
        let audio = media::decode_16k_mono(std::path::Path::new(&path), |done, total| {
            if last_emit.elapsed() >= std::time::Duration::from_millis(100) {
                emit("reading", done, total, String::new());
                last_emit = std::time::Instant::now();
            }
        })?;
        if audio::trim_silence(&audio, 16_000).is_none() {
            return Err("no_speech".to_string());
        }
        let audio = std::sync::Arc::new(audio);

        // Speakers: on the CPU while Whisper runs on the GPU.
        use rudariflow_lib::speakers;
        let mut speakers_error = None;
        let percent = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let separation = match speakers::parse_setting(&speaker_setting) {
            None => None,
            Some(_) if !speakers::models_ready(&app_dir) => {
                speakers_error = Some("no_model".to_string());
                None
            }
            Some(_) if !speakers::runtime_available() => {
                speakers_error = Some("no_runtime".to_string());
                None
            }
            Some(count) => {
                let (audio, app_dir, percent) = (audio.clone(), app_dir.clone(), percent.clone());
                let started = std::time::Instant::now();
                let handle = std::thread::Builder::new()
                    .name("rf-speakers".into())
                    .spawn(move || {
                        let turns = speakers::separate(&audio, count, &app_dir, &mut |done, total| {
                            if total > 0 {
                                percent.store(done * 100 / total, SeqCst);
                            }
                        });
                        (turns, started.elapsed())
                    })
                    .map_err(|e| e.to_string())?;
                Some(handle)
            }
        };

        emit("loading", 0, 1, String::new());
        engine.ensure_loaded(&model, &settings.gpu_backend)?;
        let terms = dictionary::terms(&settings.custom_prompt);
        let prompt = screen_context::whisper_prompt(&[], &settings.custom_prompt);
        let spelling = |text: &str| {
            let text = dictionary::apply_spelling(&file_transcribe::tidy_segment(text), &terms);
            if settings.swiss_spelling { dictionary::swiss_spelling(&text) } else { text }
        };
        let (mut segments, language) =
            file_transcribe::transcribe(&engine, &audio, &language, &prompt, spelling, &FILE_CANCEL, |p| {
                let text = p.segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
                emit("transcribing", p.done_ms, p.total_ms, text);
            })?;

        let mut found = 0u8;
        if let Some(handle) = separation {
            while !handle.is_finished() {
                if FILE_CANCEL.load(SeqCst) {
                    // The thread finishes on its own; its result is dropped.
                    return Err(file_transcribe::CANCELLED.to_string());
                }
                emit("speakers", percent.load(SeqCst) as u64, 100, String::new());
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            match handle.join() {
                Ok((Ok(turns), took)) => {
                    let spans: Vec<(u64, u64)> = segments.iter().map(|s| (s.start_ms, s.end_ms)).collect();
                    for (segment, speaker) in segments.iter_mut().zip(speakers::assign(&spans, &turns)) {
                        segment.speaker = speaker;
                    }
                    found = segments.iter().filter_map(|s| s.speaker).max().map_or(0, |m| m + 1);
                    startup_log::log(&format!(
                        "[speakers] {} speakers, {} turns in {:.1} s ({:.0} s of audio, {} threads)",
                        found,
                        turns.len(),
                        took.as_secs_f64(),
                        audio.len() as f64 / 16_000.0,
                        speakers::threads()
                    ));
                }
                Ok((Err(e), _)) => {
                    startup_log::log(&format!("[speakers] failed: {}", e));
                    speakers_error = Some(e);
                }
                Err(_) => speakers_error = Some("speaker separation stopped unexpectedly".to_string()),
            }
        }
        Ok(FileTranscript {
            segments,
            speakers: found,
            speakers_error,
            language,
            duration_ms: audio.len() as u64 / 16,
            elapsed_ms: 0,
        })
```

Before the `spawn_blocking` call add `let (speaker_setting, app_dir) = (speakers, state.app_dir.clone());` (the `speakers` parameter shadows nothing else). Update the final log line to use `transcript.segments.len()` segments instead of `transcript.text.chars().count()` characters:

```rust
    startup_log::log(&format!(
        "[file] {:.0} s of audio in {:.1} s, language {}, {} segments, {} speakers",
        transcript.duration_ms as f64 / 1000.0,
        transcript.elapsed_ms as f64 / 1000.0,
        transcript.language,
        transcript.segments.len(),
        transcript.speakers
    ));
```

`SeqCst` is already imported at the top of the command (`use std::sync::atomic::Ordering::SeqCst;`).

- [ ] **Step 3: The new commands**

Add near `summarize_text` in `main.rs`:

```rust
/// The Files tab's transcript text: paragraphs, optional times, speaker
/// names (`names[n]` for speaker n; empty = "Speaker n+1").
#[tauri::command]
fn format_file_text(segments: Vec<rudariflow_lib::whisper_engine::Segment>, names: Vec<String>, times: bool) -> String {
    file_transcribe::format(&segments, &names, times)
}

#[derive(serde::Serialize)]
struct SpeakerModelStatus {
    downloaded: bool,
    runtime: bool,
    downloading: bool,
}

static SPEAKER_DOWNLOAD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn speaker_model_status(state: State<AppState>) -> SpeakerModelStatus {
    use std::sync::atomic::Ordering::SeqCst;
    SpeakerModelStatus {
        downloaded: rudariflow_lib::speakers::models_ready(&state.app_dir),
        runtime: rudariflow_lib::speakers::runtime_available(),
        downloading: SPEAKER_DOWNLOAD.load(SeqCst),
    }
}

/// Download the speaker models (about 45 MB), with "speaker-model-progress"
/// events. "busy" while a download runs.
#[tauri::command]
async fn speaker_model_download(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use std::sync::atomic::Ordering::SeqCst;
    if SPEAKER_DOWNLOAD.swap(true, SeqCst) {
        return Err("busy".to_string());
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            SPEAKER_DOWNLOAD.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _done = Done;
    let result = rudariflow_lib::speakers::download_models(&state.app_dir, |p| {
        let _ = app.emit("speaker-model-progress", p);
    })
    .await;
    startup_log::log(&match &result {
        Ok(()) => "[speakers] models downloaded".to_string(),
        Err(e) => format!("[speakers] model download failed: {}", e),
    });
    result
}
```

Register `format_file_text, speaker_model_status, speaker_model_download,` in `generate_handler!` after `summarize_text`.

- [ ] **Step 4: Build and test**

Run: `cargo test --no-default-features --lib --bins` — Expected: all pass. Run `cargo build --release` (full features) — Expected: builds.

- [ ] **Step 5: Live check through the test hooks**

Start the test instance (see "Live checks" at the end) with the models from Task 3 in `C:\t\rf-test-data\speakers\` and the runtime on PATH. In the webview (CDP):

```js
const i = window.__TAURI_INTERNALS__.invoke;
const r = await i("transcribe_file", { path: "<scratchpad>/media/meeting.mp3", language: "", speakers: "2" });
return JSON.stringify({ speakers: r.speakers, error: r.speakersError, labels: [...new Set(r.segments.map(s => s.speaker))], text: await i("format_file_text", { segments: r.segments, names: ["Zira", "Hazel"], times: true }) });
```

Expected: `speakers: 2`, the paragraph at `[1:14]` starts with `Hazel:`, the ones at `[0:00]` and `[2:29]` with `Zira:`. Same with `speakers: "auto"`. With `speakers: "off"`: `speakers: 0`, no names.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/settings.rs src-tauri/src/main.rs
git commit -m "feat: separate speakers next to Whisper in the Files tab"
```

---

### Task 6: Files tab: speakers selector, names, statuses

**Files:**
- Modify: `index.html` (Files section)
- Modify: `src/files.ts`
- Modify: `src/main.ts`
- Modify: `src/i18n.ts`
- Modify: `src/style.css`

**Interfaces:**
- Consumes: commands of Task 5.
- Produces: `FilesHost.saveSettings(patch: { fileSpeakers?: string }): Promise<void>`; module state `segments: Segment[]`, `names: string[]`; `async function shownText(times: boolean): Promise<string>` (used by Task 10).

- [ ] **Step 1: Markup**

In `index.html`, inside `.files-options` after the Language row, add:

```html
            <div class="setting-row">
              <div class="setting-label">
                <span class="label-text" data-i18n="files_speakers_label">Speakers</span>
                <span class="label-hint" id="file-speakers-hint" data-i18n="files_speakers_hint">Who speaks when, for meetings and interviews. Off keeps voice messages fast.</span>
              </div>
              <div class="setting-control">
                <select id="file-speakers">
                  <option value="off" data-i18n="files_speakers_off">Off</option>
                  <option value="auto" data-i18n="files_speakers_auto">Auto</option>
                  <option value="2">2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                  <option value="5">5</option>
                  <option value="6">6</option>
                  <option value="7">7</option>
                  <option value="8">8</option>
                </select>
              </div>
            </div>
```

Inside `#file-result`, directly after the `.file-toolbar` div, add:

```html
            <div id="file-speakers-row" class="file-speakers hidden">
              <span class="label-hint" data-i18n="files_speakers_names">Speakers:</span>
              <div id="file-speaker-chips" class="file-speaker-chips"></div>
            </div>
```

- [ ] **Step 2: Strings**

In `src/i18n.ts`, English block (after `files_err_failed`):

```ts
  files_speakers_label: "Speakers",
  files_speakers_hint: "Who speaks when, for meetings and interviews. Off keeps voice messages fast.",
  files_speakers_off: "Off",
  files_speakers_auto: "Auto",
  files_speakers_names: "Speakers:",
  files_speaker_n: "Speaker {n}",
  files_speaker_rename: "Click to rename",
  files_speakers_downloading: "Downloading the speaker model… {percent} %",
  files_speakers_download_failed: "The speaker model could not be downloaded. Try again by choosing the number once more.",
  files_speakers_running: "Separating speakers… {percent} %",
  files_speakers_missing_no_model: "Speakers were not separated: the speaker model is not downloaded.",
  files_speakers_missing_no_runtime: "Speakers were not separated: a file of RudariFlow is missing. Reinstall RudariFlow.",
  files_speakers_missing_error: "Speakers were not separated: {error}",
  files_speakers_count: "{n} speakers",
```

German block:

```ts
  files_speakers_label: "Sprecher",
  files_speakers_hint: "Wer wann spricht, für Sitzungen und Interviews. Aus hält Sprachnachrichten schnell.",
  files_speakers_off: "Aus",
  files_speakers_auto: "Automatisch",
  files_speakers_names: "Sprecher:",
  files_speaker_n: "Sprecher {n}",
  files_speaker_rename: "Zum Umbenennen klicken",
  files_speakers_downloading: "Sprechermodell wird geladen… {percent} %",
  files_speakers_download_failed: "Das Sprechermodell konnte nicht geladen werden. Wähle die Anzahl noch einmal, um es erneut zu versuchen.",
  files_speakers_running: "Sprecher werden getrennt… {percent} %",
  files_speakers_missing_no_model: "Sprecher wurden nicht getrennt: das Sprechermodell ist nicht geladen.",
  files_speakers_missing_no_runtime: "Sprecher wurden nicht getrennt: eine Datei von RudariFlow fehlt. Installiere RudariFlow neu.",
  files_speakers_missing_error: "Sprecher wurden nicht getrennt: {error}",
  files_speakers_count: "{n} Sprecher",
```

- [ ] **Step 3: main.ts**

Add `fileSpeakers: string;` to `interface Settings` (after `learnDictionary`). Replace the `initFiles(...)` call with:

```ts
initFiles({
  settings: () => currentSettings,
  saveSettings: async (patch) => {
    Object.assign(currentSettings, patch);
    await invoke("save_settings", { settings: currentSettings });
  },
  showSection: () => showSection("files"),
});
```

- [ ] **Step 4: files.ts**

Change the host interface and types:

```ts
export interface FilesHost {
  settings(): { language: string; fileSpeakers: string };
  saveSettings(patch: { fileSpeakers?: string }): Promise<void>;
  /** Show the Files section (a file dropped on another tab). */
  showSection(): void;
}

interface Segment {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: number;
}

interface FileTranscript {
  segments: Segment[];
  speakers: number;
  speakersError?: string;
  language: string;
  durationMs: number;
  elapsedMs: number;
}

interface FileProgress {
  phase: "reading" | "loading" | "transcribing" | "speakers";
  done: number;
  total: number;
  text: string;
}

interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
}
```

New element references and state (next to the existing ones):

```ts
const speakersSelect = document.getElementById("file-speakers") as HTMLSelectElement;
const speakersHint = document.getElementById("file-speakers-hint")!;
const speakersRow = document.getElementById("file-speakers-row")!;
const speakerChips = document.getElementById("file-speaker-chips")!;

let segments: Segment[] = [];
/** One name per speaker, "Speaker 1" … until renamed. */
let names: string[] = [];
/** The speaker model download, while it runs. */
let modelDownload: Promise<boolean> | null = null;
```

Replace `showText` with:

```ts
/** The transcript as shown: paragraphs, speaker names, times if on. */
async function shownText(times: boolean): Promise<string> {
  return invoke<string>("format_file_text", { segments, names, times });
}

async function showText() {
  if (!segments.length) return;
  textArea.value = await shownText(timesToggle.checked);
}
```

Speaker names and chips:

```ts
function defaultName(i: number): string {
  return t("files_speaker_n").replace("{n}", String(i + 1));
}

function renderChips() {
  speakerChips.replaceChildren();
  speakersRow.classList.toggle("hidden", names.length === 0);
  names.forEach((name, i) => {
    const chip = document.createElement("button");
    chip.className = "speaker-chip";
    chip.textContent = name;
    chip.title = t("files_speaker_rename");
    chip.addEventListener("click", () => renameSpeaker(i, chip));
    speakerChips.append(chip);
  });
}

function renameSpeaker(i: number, chip: HTMLButtonElement) {
  const input = document.createElement("input");
  input.className = "speaker-chip-input";
  input.value = names[i];
  chip.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const apply = async (keep: boolean) => {
    if (done) return;
    done = true;
    if (keep) names[i] = input.value.trim() || defaultName(i);
    renderChips();
    await showText();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") apply(true);
    if (e.key === "Escape") apply(false);
  });
  input.addEventListener("blur", () => apply(true));
}
```

Speaker model download:

```ts
/** Download the speaker model if needed; true when it is ready. */
function ensureSpeakerModel(): Promise<boolean> {
  if (modelDownload) return modelDownload;
  modelDownload = (async () => {
    try {
      const status = await invoke<{ downloaded: boolean }>("speaker_model_status");
      if (status.downloaded) return true;
      speakersHint.textContent = t("files_speakers_downloading").replace("{percent}", "0");
      await invoke("speaker_model_download");
      speakersHint.textContent = t("files_speakers_hint");
      return true;
    } catch {
      speakersHint.textContent = t("files_speakers_download_failed");
      return false;
    } finally {
      modelDownload = null;
    }
  })();
  return modelDownload;
}
```

In `transcribe(path)`: after `running = true;` reset `segments = []; names = []; renderChips();`, and before invoking wait for the model:

```ts
  if (speakersSelect.value !== "off" && !(await ensureSpeakerModel())) {
    setStatus(t("files_speakers_download_failed"), "error");
    running = false;
    cancelBtn.classList.add("hidden");
    return;
  }
```

Replace the `invoke<FileTranscript>("transcribe_file", …)` block's success path with:

```ts
    transcript = await invoke<FileTranscript>("transcribe_file", {
      path,
      language: languageSelect.value,
      speakers: speakersSelect.value,
    });
    segments = transcript.segments;
    names = Array.from({ length: transcript.speakers }, (_, i) => defaultName(i));
    renderChips();
    await showText();
    setProgress(1);
    const secs = (transcript.elapsedMs / 1000).toFixed(1);
    let status = t("files_done")
      .replace("{audio}", clock(transcript.durationMs))
      .replace("{secs}", secs)
      .replace("{language}", languageName(transcript.language));
    if (transcript.speakersError) {
      const key = `files_speakers_missing_${transcript.speakersError}`;
      const known = key === "files_speakers_missing_no_model" || key === "files_speakers_missing_no_runtime";
      status += " · " + (known ? t(key) : t("files_speakers_missing_error").replace("{error}", transcript.speakersError));
    }
    setStatus(status, transcript.speakersError ? "error" : "ok");
    setButtons(true);
```

(`FileTranscript` no longer has `text`/`textWithTimes`; remove their uses.) In `summarize()` replace `const text = transcript?.text ?? textArea.value;` with:

```ts
  const text = segments.length ? await shownText(false) : textArea.value;
```

In `onProgress`, add the speakers phase before the `else`:

```ts
  } else if (p.phase === "speakers") {
    setStatus(t("files_speakers_running").replace("{percent}", String(p.done)));
    setProgress(0.95 + (p.done / 100) * 0.05);
  } else {
```

In `renderFiles()`, set the selector from the settings once (next to the language):

```ts
  if (!speakersSet) {
    speakersSelect.value = host.settings().fileSpeakers || "off";
    speakersSet = true;
  }
```

with `let speakersSet = false;` among the state variables. In `initFiles`, add:

```ts
  speakersSelect.addEventListener("change", async () => {
    await host.saveSettings({ fileSpeakers: speakersSelect.value });
    if (speakersSelect.value !== "off") ensureSpeakerModel();
  });
  listen<DownloadProgress>("speaker-model-progress", (e) => {
    speakersHint.textContent = t("files_speakers_downloading").replace("{percent}", String(Math.round(e.payload.percent)));
  });
```

- [ ] **Step 5: Styles**

Append to `src/style.css`:

```css
.file-speakers {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.file-speaker-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.speaker-chip,
.speaker-chip-input {
  font: inherit;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
}

.speaker-chip {
  cursor: pointer;
}

.speaker-chip:hover {
  border-color: var(--accent);
}

.speaker-chip-input {
  width: 140px;
  outline: none;
  border-color: var(--accent);
  user-select: text;
  -webkit-user-select: text;
}
```

(Use the variable names `style.css` already defines for accent, border and surface; if `--accent` does not exist, use the one the existing focus styles use.)

- [ ] **Step 6: Type check**

Run (repo root): `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 7: Live check**

Build the app (`npm run tauri build -- --no-bundle`), start the test instance, and in the Files tab (driven through CDP or by hand): choose Speakers → 2 (model already present: no download), drop the meeting file. Expected: status runs "Transcribing…", then "Separating speakers… n %", then the chips "Speaker 1", "Speaker 2" and the text in three paragraphs with names. Rename "Speaker 1" to "Zira" → every paragraph of that speaker shows "Zira:". Toggle Timestamps → times appear and disappear, names stay. Delete `C:\t\rf-test-data\speakers\embedding.onnx`, choose 3 → the hint shows the download percent and ends with the normal hint; the file is back.

- [ ] **Step 8: Commit**

```bash
git add index.html src/files.ts src/main.ts src/i18n.ts src/style.css
git commit -m "feat: speakers selector and names in the Files tab"
```

---

### Task 7: Export module: text and subtitles

**Files:**
- Create: `src-tauri/src/export.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `file_transcribe::{format, paragraphs, speaker_name, clock, Paragraph}`, `whisper_engine::Segment`.
- Produces:
  - `pub struct ExportDoc { title, meta, segments, names, times, summary: Option<String>, summary_title, transcript_title }` (`Deserialize`, camelCase: `summaryTitle`, `transcriptTitle`)
  - `pub fn text(doc: &ExportDoc) -> String`
  - `pub struct Cue { pub start_ms: u64, pub end_ms: u64, pub text: String, pub speaker: Option<u8> }`
  - `pub fn cues(segments: &[Segment]) -> Vec<Cue>`
  - `pub fn srt(segments: &[Segment], names: &[String]) -> String`
  - `pub fn vtt(segments: &[Segment], names: &[String]) -> String`

- [ ] **Step 1: Write the failing tests**

`src-tauri/src/export.rs` (tests first; the module body follows in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn said(start_s: f32, end_s: f32, speaker: Option<u8>, text: &str) -> Segment {
        Segment { start_ms: (start_s * 1000.0) as u64, end_ms: (end_s * 1000.0) as u64, text: text.to_string(), speaker }
    }

    fn doc(summary: Option<&str>) -> ExportDoc {
        ExportDoc {
            title: "meeting.mp3".into(),
            meta: "2:52 · English · 2 speakers".into(),
            segments: vec![said(0.0, 3.0, Some(0), "Welcome to the meeting."), said(14.0, 18.0, Some(1), "Version ten is out.")],
            names: vec!["Saad".into()],
            times: true,
            summary: summary.map(str::to_string),
            summary_title: "Summary".into(),
            transcript_title: "Transcript".into(),
        }
    }

    #[test]
    fn text_is_the_shown_transcript_with_the_summary_on_top() {
        assert_eq!(text(&doc(None)), "[0:00] Saad: Welcome to the meeting.\n\n[0:14] Speaker 2: Version ten is out.");
        assert!(text(&doc(Some("- One point"))).starts_with("Summary\n\n- One point\n\nTranscript\n\n[0:00] Saad:"));
    }

    #[test]
    fn subtitle_times_are_formatted_for_srt_and_vtt() {
        assert_eq!(srt_time(3_723_456), "01:02:03,456");
        assert_eq!(vtt_time(3_723_456), "01:02:03.456");
        assert_eq!(srt_time(0), "00:00:00,000");
    }

    #[test]
    fn long_segments_are_split_into_two_line_cues_with_shared_time() {
        let long = "This is the first sentence of a long answer. And this is the second one, which goes on for quite a while longer than the first.";
        let cues = cues(&[said(10.0, 20.0, None, long)]);
        assert!(cues.len() >= 2, "{cues:?}");
        assert!(cues.iter().all(|c| c.text.chars().count() <= CUE_CHARS + 1), "{cues:?}");
        assert!(cues[0].text.ends_with("answer."), "split at the sentence end: {cues:?}");
        assert_eq!(cues[0].start_ms, 10_000);
        assert_eq!(cues.last().unwrap().end_ms, 20_000);
        for pair in cues.windows(2) {
            assert!(pair[0].end_ms <= pair[1].start_ms, "{cues:?}");
        }
    }

    #[test]
    fn short_cues_last_a_second_unless_the_next_one_starts() {
        let cues = cues(&[said(0.0, 0.3, None, "Hi."), said(0.5, 2.0, None, "Hello there."), said(5.0, 5.2, None, "Bye.")]);
        assert_eq!((cues[0].start_ms, cues[0].end_ms), (0, 500));
        assert_eq!((cues[2].start_ms, cues[2].end_ms), (5_000, 6_000));
    }

    #[test]
    fn srt_and_vtt_carry_the_speaker() {
        let d = doc(None);
        let s = srt(&d.segments, &d.names);
        assert!(s.starts_with("1\n00:00:00,000 --> 00:00:03,000\nSaad: Welcome to the meeting.\n\n2\n"), "{s}");
        let v = vtt(&d.segments, &d.names);
        assert!(v.starts_with("WEBVTT\n\n00:00:00.000 --> 00:00:03.000\n<v Saad>Welcome to the meeting.\n\n"), "{v}");
        assert!(v.contains("<v Speaker 2>Version ten is out."), "{v}");
        let tricky = vtt(&[said(0.0, 2.0, Some(0), "a < b & c")], &["A<B>".into()]);
        assert!(tricky.contains("<v AB>a &lt; b &amp; c"), "{tricky}");
    }
}
```

Add `pub mod export;` to `lib.rs`.

Run: `cargo test --no-default-features --lib export` — Expected: FAIL to compile.

- [ ] **Step 2: (no separate step: implement in Step 3)**

- [ ] **Step 3: Implement**

Top of `src-tauri/src/export.rs`:

```rust
//! Exports of the Files tab: text, subtitles (SRT, VTT), Word, and the HTML
//! the PDF is printed from. They take what the tab shows: the times switch,
//! the speaker names, the summary if there is one.

use crate::file_transcribe::{clock, format, paragraphs, speaker_name};
use crate::whisper_engine::Segment;

/// What an export contains, sent by the Files tab. `meta` is the line under
/// the title ("2:52 · English · 2 speakers · 24.09.2026") and the headings
/// are in the UI language.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ExportDoc {
    pub title: String,
    pub meta: String,
    pub segments: Vec<Segment>,
    pub names: Vec<String>,
    pub times: bool,
    pub summary: Option<String>,
    #[serde(rename = "summaryTitle")]
    pub summary_title: String,
    #[serde(rename = "transcriptTitle")]
    pub transcript_title: String,
}

/// The transcript as the text box shows it, the summary above it.
pub fn text(doc: &ExportDoc) -> String {
    let transcript = format(&doc.segments, &doc.names, doc.times);
    match doc.summary.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(summary) => format!("{}\n\n{}\n\n{}\n\n{}", doc.summary_title, summary, doc.transcript_title, transcript),
        None => transcript,
    }
}

/// A subtitle: its time, one or two lines of text, the speaker.
#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub speaker: Option<u8>,
}

const LINE_CHARS: usize = 42;
const CUE_CHARS: usize = 2 * LINE_CHARS;
const MIN_CUE_MS: u64 = 1_000;

/// The segments as cues of at most two lines: a longer segment is split at
/// a sentence end, else a comma, else a space, and its time is shared out by
/// characters. A cue lasts at least a second unless the next one starts.
pub fn cues(segments: &[Segment]) -> Vec<Cue> {
    let mut out: Vec<Cue> = Vec::new();
    for segment in segments {
        let parts = split_text(segment.text.trim(), CUE_CHARS);
        let total: usize = parts.iter().map(|p| p.chars().count()).sum::<usize>().max(1);
        let span = segment.end_ms.saturating_sub(segment.start_ms);
        let mut start = segment.start_ms;
        let mut chars_before = 0;
        for (i, part) in parts.iter().enumerate() {
            chars_before += part.chars().count();
            let end = if i + 1 == parts.len() {
                segment.end_ms
            } else {
                segment.start_ms + span * chars_before as u64 / total as u64
            };
            out.push(Cue { start_ms: start, end_ms: end, text: part.clone(), speaker: segment.speaker });
            start = end;
        }
    }
    for i in 0..out.len() {
        let next_start = out.get(i + 1).map(|c| c.start_ms);
        let cue = &mut out[i];
        if cue.end_ms < cue.start_ms + MIN_CUE_MS {
            cue.end_ms = match next_start {
                Some(next) => (cue.start_ms + MIN_CUE_MS).min(next.max(cue.end_ms)),
                None => cue.start_ms + MIN_CUE_MS,
            };
        }
    }
    out
}

/// `text` in parts of at most `max` characters.
fn split_text(text: &str, max: usize) -> Vec<String> {
    let mut parts = Vec::new();
    let mut rest = text;
    while rest.chars().count() > max {
        let window_end = rest.char_indices().nth(max).map_or(rest.len(), |(i, _)| i);
        let window = &rest[..window_end];
        let cut = best_cut(window).unwrap_or(window_end);
        let (head, tail) = rest.split_at(cut);
        if !head.trim().is_empty() {
            parts.push(head.trim().to_string());
        }
        rest = tail.trim_start();
    }
    if !rest.is_empty() {
        parts.push(rest.to_string());
    }
    parts
}

/// Where to cut `window` (a byte index): after the last sentence end, else
/// after the last comma, else at the last space; ends in the first third
/// of the window do not count, so no part is a word or two.
fn best_cut(window: &str) -> Option<usize> {
    let min = window.len() / 3;
    let after = |marks: &[char]| {
        window
            .char_indices()
            .filter(|&(i, c)| marks.contains(&c) && i >= min)
            .map(|(i, c)| i + c.len_utf8())
            .last()
    };
    after(&['.', '!', '?']).or_else(|| after(&[',', ';', ':'])).or_else(|| window.rfind(' ').filter(|&i| i > 0))
}

/// A cue's text in at most two lines, broken at the space nearest the middle.
fn two_lines(text: &str) -> String {
    if text.chars().count() <= LINE_CHARS {
        return text.to_string();
    }
    let middle = text.len() / 2;
    match text.char_indices().filter(|&(_, c)| c == ' ').min_by_key(|&(i, _)| i.abs_diff(middle)) {
        Some((i, _)) => format!("{}\n{}", &text[..i], &text[i + 1..]),
        None => text.to_string(),
    }
}

fn hms(ms: u64) -> (u64, u64, u64, u64) {
    (ms / 3_600_000, ms / 60_000 % 60, ms / 1_000 % 60, ms % 1_000)
}

fn srt_time(ms: u64) -> String {
    let (h, m, s, f) = hms(ms);
    format!("{h:02}:{m:02}:{s:02},{f:03}")
}

fn vtt_time(ms: u64) -> String {
    let (h, m, s, f) = hms(ms);
    format!("{h:02}:{m:02}:{s:02}.{f:03}")
}

/// SubRip: numbered cues, the speaker as "Name: " before the text.
pub fn srt(segments: &[Segment], names: &[String]) -> String {
    cues(segments)
        .iter()
        .enumerate()
        .map(|(i, cue)| {
            let who = cue.speaker.map_or(String::new(), |s| format!("{}: ", speaker_name(names, s)));
            format!("{}\n{} --> {}\n{}\n", i + 1, srt_time(cue.start_ms), srt_time(cue.end_ms), two_lines(&format!("{who}{}", cue.text)))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn vtt_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// WebVTT: the speaker as a voice tag (`<v Name>`).
pub fn vtt(segments: &[Segment], names: &[String]) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for cue in cues(segments) {
        let who = cue.speaker.map_or(String::new(), |s| {
            let name: String = speaker_name(names, s).chars().filter(|c| !matches!(c, '<' | '>' | '&')).collect();
            format!("<v {name}>")
        });
        out.push_str(&format!(
            "{} --> {}\n{}{}\n\n",
            vtt_time(cue.start_ms),
            vtt_time(cue.end_ms),
            who,
            two_lines(&vtt_escape(&cue.text))
        ));
    }
    out
}
```

`paragraphs` is imported for Tasks 8–9; if the compiler warns that it is unused, keep the import and add those tasks' code, or import it there.

- [ ] **Step 4: Run the tests**

Run: `cargo test --no-default-features --lib export` — Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/export.rs src-tauri/src/lib.rs
git commit -m "feat: text and subtitle exports of file transcripts"
```

---

### Task 8: Word export and paper size

**Files:**
- Modify: `src-tauri/src/export.rs`
- Modify: `src-tauri/Cargo.toml` (`docx-rs`, dev-dependency `zip`)

**Interfaces:**
- Produces:
  - `pub enum Paper { A4, Letter }` with `pub fn for_region() -> Paper`, `pub fn twips(self) -> (u32, u32)`, `pub fn inches(self) -> (f64, f64)`, `pub fn css(self) -> &'static str`
  - `pub fn docx(doc: &ExportDoc, paper: Paper) -> Result<Vec<u8>, String>`

- [ ] **Step 1: Crates**

`[dependencies]`: `docx-rs = "0.4"`. `[dev-dependencies]` (create the section if missing): `zip = { version = "2", default-features = false, features = ["deflate"] }`.

- [ ] **Step 2: Write the failing test**

Add to the `tests` module in `export.rs`:

```rust
    #[test]
    fn word_has_the_title_summary_names_and_times() {
        use std::io::Read;
        let bytes = docx(&doc(Some("- One point")), Paper::A4).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut xml = String::new();
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut xml).unwrap();
        for expected in ["meeting.mp3", "Summary", "- One point", "Transcript", "[0:00] ", "Saad: ", "Welcome to the meeting.", "Speaker 2: "] {
            assert!(xml.contains(expected), "{expected} missing");
        }
        assert!(xml.contains("11906"), "A4 width in twips");
    }

    #[test]
    fn paper_sizes() {
        assert_eq!(Paper::A4.twips(), (11906, 16838));
        assert_eq!(Paper::Letter.twips(), (12240, 15840));
        assert_eq!(Paper::Letter.css(), "letter");
    }
```

Run: `cargo test --no-default-features --lib export` — Expected: FAIL to compile.

- [ ] **Step 3: Implement**

Add to `export.rs`:

```rust
/// Paper for PDF and Word: Letter in the US and Canada (Windows region), A4
/// elsewhere.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Paper {
    A4,
    Letter,
}

impl Paper {
    pub fn for_region() -> Paper {
        // GEOIDs: 244 United States, 39 Canada.
        match region::geo_id() {
            Some(244) | Some(39) => Paper::Letter,
            _ => Paper::A4,
        }
    }

    /// Width and height in twentieths of a point (Word).
    pub fn twips(self) -> (u32, u32) {
        match self {
            Paper::A4 => (11906, 16838),
            Paper::Letter => (12240, 15840),
        }
    }

    /// Width and height in inches (WebView2 print settings).
    pub fn inches(self) -> (f64, f64) {
        match self {
            Paper::A4 => (8.27, 11.69),
            Paper::Letter => (8.5, 11.0),
        }
    }

    /// The CSS `@page` size.
    pub fn css(self) -> &'static str {
        match self {
            Paper::A4 => "A4",
            Paper::Letter => "letter",
        }
    }
}

#[cfg(windows)]
mod region {
    pub fn geo_id() -> Option<i32> {
        use windows_sys::Win32::Globalization::{GetUserGeoID, GEOCLASS_NATION};
        let id = unsafe { GetUserGeoID(GEOCLASS_NATION) };
        (id > 0).then_some(id)
    }
}

#[cfg(not(windows))]
mod region {
    pub fn geo_id() -> Option<i32> {
        None
    }
}

/// 20 mm in twips.
const MARGIN_TWIPS: i32 = 1134;

/// The transcript as a Word document: title, the line under it, the summary,
/// the transcript paragraphs (time grey, name bold).
pub fn docx(doc: &ExportDoc, paper: Paper) -> Result<Vec<u8>, String> {
    use docx_rs::{Docx, PageMargin, Paragraph as P, Run, Style, StyleType};

    let (width, height) = paper.twips();
    let mut d = Docx::new()
        .page_size(width, height)
        .page_margin(PageMargin::new().top(MARGIN_TWIPS).bottom(MARGIN_TWIPS).left(MARGIN_TWIPS).right(MARGIN_TWIPS))
        .add_style(Style::new("Title", StyleType::Paragraph).name("Title").size(36).bold())
        .add_style(Style::new("Heading1", StyleType::Paragraph).name("Heading 1").size(28).bold())
        .add_paragraph(P::new().style("Title").add_run(Run::new().add_text(&doc.title)))
        .add_paragraph(P::new().add_run(Run::new().add_text(&doc.meta).color("666666")));
    if let Some(summary) = doc.summary.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        d = d.add_paragraph(P::new().style("Heading1").add_run(Run::new().add_text(&doc.summary_title)));
        for line in summary.lines().filter(|l| !l.trim().is_empty()) {
            d = d.add_paragraph(P::new().add_run(Run::new().add_text(line)));
        }
    }
    d = d.add_paragraph(P::new().style("Heading1").add_run(Run::new().add_text(&doc.transcript_title)));
    for p in paragraphs(&doc.segments) {
        let mut para = P::new();
        if doc.times {
            para = para.add_run(Run::new().add_text(format!("[{}] ", clock(p.start_ms))).color("808080"));
        }
        if let Some(s) = p.speaker {
            para = para.add_run(Run::new().add_text(format!("{}: ", speaker_name(&doc.names, s))).bold());
        }
        d = d.add_paragraph(para.add_run(Run::new().add_text(&p.text)));
    }
    let mut out = std::io::Cursor::new(Vec::new());
    d.build().pack(&mut out).map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}
```

If a docx-rs method name differs in the resolved 0.4.x (check `C:\Users\<you>\.cargo\registry\src\*\docx-rs-0.4.*\src\documents\mod.rs` and `…\elements\run.rs`), use the equivalent there with the same effect.

- [ ] **Step 4: Run the tests**

Run: `cargo test --no-default-features --lib export` — Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/export.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: Word export of file transcripts, paper by Windows region"
```

---

### Task 9: PDF export

**Files:**
- Modify: `src-tauri/src/export.rs` (`pdf_html`)
- Create: `src-tauri/src/pdf.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml` (`webview2-com`)

**Interfaces:**
- Produces:
  - `pub fn pdf_html(doc: &ExportDoc, paper: Paper) -> String` (in `export`)
  - `pub async fn print(app: &tauri::AppHandle, html: String, paper: Paper, path: std::path::PathBuf) -> Result<(), String>` (in `pdf`)

- [ ] **Step 1: Write the failing test for the HTML**

Add to `export.rs` tests:

```rust
    #[test]
    fn pdf_html_has_paper_header_names_and_escapes() {
        let mut d = doc(Some("- One <point>"));
        d.title = "Q&A.mp3".into();
        let html = pdf_html(&d, Paper::Letter);
        assert!(html.contains("size: letter"));
        assert!(html.contains("<h1>Q&amp;A.mp3</h1>"));
        assert!(html.contains("- One &lt;point&gt;"));
        assert!(html.contains("<span class=\"time\">[0:14]</span>"));
        assert!(html.contains("<span class=\"who\">Speaker 2:</span>"));
        d.times = false;
        assert!(!pdf_html(&d, Paper::A4).contains("class=\"time\""));
    }
```

Run: `cargo test --no-default-features --lib export` — Expected: FAIL to compile.

- [ ] **Step 2: Implement the HTML**

Add to `export.rs`:

```rust
fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The page the PDF is printed from: system fonts (every script Windows can
/// show), 20 mm margins, page numbers "n / total" in the footer.
pub fn pdf_html(doc: &ExportDoc, paper: Paper) -> String {
    let mut body = format!(
        "<h1>{}</h1>\n<div class=\"meta\">{}</div>\n",
        html_escape(&doc.title),
        html_escape(&doc.meta)
    );
    if let Some(summary) = doc.summary.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        body.push_str(&format!("<h2>{}</h2>\n<div class=\"summary\">\n", html_escape(&doc.summary_title)));
        for line in summary.lines().filter(|l| !l.trim().is_empty()) {
            body.push_str(&format!("<p>{}</p>\n", html_escape(line)));
        }
        body.push_str("</div>\n");
    }
    body.push_str(&format!("<h2>{}</h2>\n", html_escape(&doc.transcript_title)));
    for p in paragraphs(&doc.segments) {
        body.push_str("<p>");
        if doc.times {
            body.push_str(&format!("<span class=\"time\">[{}]</span> ", clock(p.start_ms)));
        }
        if let Some(s) = p.speaker {
            body.push_str(&format!("<span class=\"who\">{}:</span> ", html_escape(&speaker_name(&doc.names, s))));
        }
        body.push_str(&html_escape(&p.text));
        body.push_str("</p>\n");
    }
    format!(
        r#"<!doctype html>
<html><head><meta charset="utf-8"><title>{title}</title>
<style>
@page {{ size: {size}; margin: 20mm; @bottom-center {{ content: counter(page) " / " counter(pages); font: 9pt "Segoe UI", sans-serif; color: #888; }} }}
body {{ font: 11pt/1.5 "Segoe UI", "Segoe UI Emoji", "Microsoft YaHei", "Yu Gothic", "Malgun Gothic", "Nirmala UI", "Leelawadee UI", sans-serif; color: #111; margin: 0; }}
h1 {{ font-size: 18pt; margin: 0 0 4pt; }}
.meta {{ color: #666; font-size: 9.5pt; margin-bottom: 14pt; }}
h2 {{ font-size: 13pt; margin: 16pt 0 6pt; }}
p {{ margin: 0 0 8pt; orphans: 2; widows: 2; }}
.summary p {{ margin-bottom: 4pt; }}
.time {{ color: #888; font-variant-numeric: tabular-nums; }}
.who {{ font-weight: 600; }}
</style></head>
<body>
{body}</body></html>
"#,
        title = html_escape(&doc.title),
        size = paper.css(),
        body = body
    )
}
```

Run: `cargo test --no-default-features --lib export` — Expected: 8 passed.

- [ ] **Step 3: Print with WebView2**

`Cargo.toml`, `[target.'cfg(windows)'.dependencies]`:

```toml
# PDF export (src/pdf.rs): WebView2's PrintToPdf on a hidden window; the
# version wry 0.54 uses, so the COM types match Tauri's webview.
webview2-com = "0.38"
```

`src-tauri/src/pdf.rs`:

```rust
//! PDF export: the export's HTML in a hidden webview window, printed with
//! WebView2's PrintToPdf. The page goes through a temporary file, since
//! NavigateToString is limited to 2 MB.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::time::Duration;

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

use crate::export::Paper;

const WINDOW: &str = "pdf-export";
static BUSY: AtomicBool = AtomicBool::new(false);

/// Print `html` to a PDF at `path`.
pub async fn print(app: &AppHandle, html: String, paper: Paper, path: PathBuf) -> Result<(), String> {
    if BUSY.swap(true, SeqCst) {
        return Err("busy".to_string());
    }
    struct Done;
    impl Drop for Done {
        fn drop(&mut self) {
            BUSY.store(false, SeqCst);
        }
    }
    let _done = Done;

    let page = std::env::temp_dir().join(format!("rudariflow-export-{}.html", std::process::id()));
    std::fs::write(&page, html).map_err(|e| e.to_string())?;
    let url = tauri::Url::from_file_path(&page).map_err(|_| "bad temporary path".to_string())?;

    let (loaded_tx, loaded_rx) = tokio::sync::oneshot::channel::<()>();
    let loaded_tx = std::sync::Mutex::new(Some(loaded_tx));
    let window = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(url))
        .visible(false)
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if let Some(tx) = loaded_tx.lock().unwrap_or_else(|p| p.into_inner()).take() {
                    let _ = tx.send(());
                }
            }
        })
        .build()
        .map_err(|e| e.to_string())?;

    let result = async {
        tokio::time::timeout(Duration::from_secs(30), loaded_rx)
            .await
            .map_err(|_| "the page did not load".to_string())?
            .map_err(|_| "the page did not load".to_string())?;
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let target = path.clone();
        window
            .with_webview(move |webview| imp::print_to_pdf(&webview, &target, paper, done_tx))
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(180), done_rx)
            .await
            .map_err(|_| "printing took too long".to_string())?
            .map_err(|_| "printing stopped".to_string())?
    }
    .await;
    let _ = window.destroy();
    let _ = std::fs::remove_file(&page);
    result
}

#[cfg(windows)]
mod imp {
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    use tokio::sync::oneshot::Sender;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING};

    use crate::export::Paper;

    /// 20 mm, as the page's @page rule; whichever wins, the margin is the same.
    const MARGIN_INCHES: f64 = 0.787;

    pub fn print_to_pdf(
        webview: &tauri::webview::PlatformWebview,
        path: &Path,
        paper: Paper,
        done: Sender<Result<(), String>>,
    ) {
        let done = Arc::new(Mutex::new(Some(done)));
        let send = {
            let done = done.clone();
            move |result: Result<(), String>| {
                if let Some(tx) = done.lock().unwrap_or_else(|p| p.into_inner()).take() {
                    let _ = tx.send(result);
                }
            }
        };
        let handler_send = send.clone();
        let start = || -> windows::core::Result<()> {
            unsafe {
                let core: ICoreWebView2_7 = webview.controller().CoreWebView2()?.cast()?;
                let environment: ICoreWebView2Environment6 = webview.environment().cast()?;
                let settings = environment.CreatePrintSettings()?;
                let (width, height) = paper.inches();
                settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
                settings.SetPageWidth(width)?;
                settings.SetPageHeight(height)?;
                settings.SetMarginTop(MARGIN_INCHES)?;
                settings.SetMarginBottom(MARGIN_INCHES)?;
                settings.SetMarginLeft(MARGIN_INCHES)?;
                settings.SetMarginRight(MARGIN_INCHES)?;
                settings.SetShouldPrintBackgrounds(true)?;
                settings.SetShouldPrintHeaderAndFooter(false)?;
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                    handler_send(match (result, ok) {
                        (Ok(()), true) => Ok(()),
                        (Err(e), _) => Err(e.message().to_string()),
                        (Ok(()), false) => Err("the PDF could not be written".to_string()),
                    });
                    Ok(())
                }));
                core.PrintToPdf(&HSTRING::from(path.as_os_str()), &settings, &handler)
            }
        };
        if let Err(e) = start() {
            send(Err(e.message().to_string()));
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn print_to_pdf(
        _webview: &tauri::webview::PlatformWebview,
        _path: &std::path::Path,
        _paper: crate::export::Paper,
        done: tokio::sync::oneshot::Sender<Result<(), String>>,
    ) {
        let _ = done.send(Err("PDF export needs Windows".to_string()));
    }
}
```

Add `pub mod pdf;` to `lib.rs`. `send` must be `Clone`: it is a closure over an `Arc`, which is `Clone`.

- [ ] **Step 4: Build**

Run: `cargo build --release` (full features) — Expected: builds. If a method name differs in webview2-com 0.38 (e.g. `SetShouldPrintHeaderAndFooter`), look it up in `webview2-com-sys-0.38.2\src\bindings.rs` under `ICoreWebView2PrintSettings`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/export.rs src-tauri/src/pdf.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat: PDF export of file transcripts with WebView2"
```

---

### Task 10: Export command and menu

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `index.html`, `src/files.ts`, `src/i18n.ts`, `src/style.css`

**Interfaces:**
- Consumes: `export::{ExportDoc, Paper, text, srt, vtt, docx, pdf_html}`, `pdf::print`, `shownText` (Task 6).
- Produces: command `export_file(kind: "pdf" | "docx" | "srt" | "vtt" | "txt", path: String, doc: ExportDoc) -> ()`. The command `save_text` is removed.

- [ ] **Step 1: The command**

In `main.rs`, replace `save_text` (and its `generate_handler!` entry) with:

```rust
/// Write the Files tab's transcript as `kind`: "pdf", "docx", "srt", "vtt"
/// or "txt".
#[tauri::command]
async fn export_file(app: AppHandle, kind: String, path: String, doc: rudariflow_lib::export::ExportDoc) -> Result<(), String> {
    use rudariflow_lib::export;
    let paper = export::Paper::for_region();
    let path = std::path::PathBuf::from(path);
    let write = |bytes: &[u8]| std::fs::write(&path, bytes).map_err(|e| e.to_string());
    let result = match kind.as_str() {
        "txt" => write(export::text(&doc).as_bytes()),
        "srt" => write(export::srt(&doc.segments, &doc.names).as_bytes()),
        "vtt" => write(export::vtt(&doc.segments, &doc.names).as_bytes()),
        "docx" => write(&export::docx(&doc, paper)?),
        "pdf" => rudariflow_lib::pdf::print(&app, export::pdf_html(&doc, paper), paper, path.clone()).await,
        other => Err(format!("unknown export '{}'", other)),
    };
    startup_log::log(&match &result {
        Ok(()) => format!("[export] {} with {} segments", kind, doc.segments.len()),
        Err(e) => format!("[export] {} failed: {}", kind, e),
    });
    result
}
```

Register `export_file,` in `generate_handler!` where `save_text` was.

- [ ] **Step 2: Markup**

In `index.html`, replace `<button id="file-save" …>Save as text…</button>` with:

```html
                <div class="export-menu">
                  <button id="file-export" class="btn-secondary" aria-haspopup="menu" aria-expanded="false"><span data-i18n="files_export">Export</span> ▾</button>
                  <div id="file-export-list" class="export-list hidden" role="menu">
                    <button role="menuitem" data-kind="pdf" data-i18n="files_export_pdf">PDF…</button>
                    <button role="menuitem" data-kind="docx" data-i18n="files_export_docx">Word (.docx)…</button>
                    <button role="menuitem" data-kind="srt" data-i18n="files_export_srt">Subtitles (.srt)…</button>
                    <button role="menuitem" data-kind="vtt" data-i18n="files_export_vtt">Subtitles (.vtt)…</button>
                    <button role="menuitem" data-kind="txt" data-i18n="files_export_txt">Text (.txt)…</button>
                  </div>
                </div>
```

- [ ] **Step 3: Strings**

English (replace `files_save`):

```ts
  files_export: "Export",
  files_export_pdf: "PDF…",
  files_export_docx: "Word (.docx)…",
  files_export_srt: "Subtitles (.srt)…",
  files_export_vtt: "Subtitles (.vtt)…",
  files_export_txt: "Text (.txt)…",
  files_exported: "Saved: {name}",
  files_filter_pdf: "PDF",
  files_filter_docx: "Word document",
  files_filter_srt: "SubRip subtitles",
  files_filter_vtt: "WebVTT subtitles",
  files_filter_txt: "Text",
```

German:

```ts
  files_export: "Exportieren",
  files_export_pdf: "PDF…",
  files_export_docx: "Word (.docx)…",
  files_export_srt: "Untertitel (.srt)…",
  files_export_vtt: "Untertitel (.vtt)…",
  files_export_txt: "Text (.txt)…",
  files_exported: "Gespeichert: {name}",
  files_filter_pdf: "PDF",
  files_filter_docx: "Word-Dokument",
  files_filter_srt: "SubRip-Untertitel",
  files_filter_vtt: "WebVTT-Untertitel",
  files_filter_txt: "Text",
```

- [ ] **Step 4: files.ts**

Replace `saveBtn`/`saveText` with the menu:

```ts
const exportBtn = document.getElementById("file-export") as HTMLButtonElement;
const exportList = document.getElementById("file-export-list")!;

type ExportKind = "pdf" | "docx" | "srt" | "vtt" | "txt";

function setExportMenu(open: boolean) {
  exportList.classList.toggle("hidden", !open);
  exportBtn.setAttribute("aria-expanded", String(open));
}

/** "2:52 · English · 2 speakers · 24.09.2026" under the title. */
function exportMeta(): string {
  const parts = [clock(transcript?.durationMs ?? 0), languageName(transcript?.language ?? "")];
  if (names.length) parts.push(t("files_speakers_count").replace("{n}", String(names.length)));
  parts.push(new Date().toLocaleDateString(getLang()));
  return parts.join(" · ");
}

async function exportAs(kind: ExportKind) {
  setExportMenu(false);
  const base = fileName.replace(/\.[^.]+$/, "") || "transcript";
  const path = await save({
    defaultPath: `${base}.${kind}`,
    filters: [{ name: t(`files_filter_${kind}`), extensions: [kind] }],
  });
  if (!path) return;
  const summaryReady = !summarizing && !summaryBox.classList.contains("hidden") && summaryEl.dataset.tone !== "error";
  const doc = {
    title: fileName,
    meta: exportMeta(),
    segments,
    names,
    times: timesToggle.checked,
    summary: summaryReady && summaryEl.textContent ? summaryEl.textContent : null,
    summaryTitle: t("files_summary"),
    transcriptTitle: t("files_transcript"),
  };
  try {
    await invoke("export_file", { kind, path, doc });
    setStatus(t("files_exported").replace("{name}", path.split(/[\\/]/).pop() ?? path), "ok");
  } catch (e) {
    setStatus(`${t("files_err_failed")}: ${e}`, "error");
  }
}
```

In `setButtons`, replace `saveBtn.disabled = !enabled;` with `exportBtn.disabled = !enabled || !segments.length;`. In `initFiles`, replace the `saveBtn` listener with:

```ts
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setExportMenu(exportList.classList.contains("hidden"));
  });
  exportList.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((item) =>
    item.addEventListener("click", () => exportAs(item.dataset.kind as ExportKind)),
  );
  document.addEventListener("click", () => setExportMenu(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setExportMenu(false);
  });
```

Remove the now unused `saveText` and the `files_save` string in both languages.

- [ ] **Step 5: Styles**

```css
.export-menu {
  position: relative;
}

.export-list {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  min-width: 190px;
  display: flex;
  flex-direction: column;
  padding: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

.export-list.hidden {
  display: none;
}

.export-list button {
  font: inherit;
  text-align: left;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}

.export-list button:hover,
.export-list button:focus-visible {
  background: var(--bg);
}
```

- [ ] **Step 6: Type check and build**

Run: `npx tsc --noEmit` (root) — no errors. `npm run tauri build -- --no-bundle` — builds.

- [ ] **Step 7: Live check of every format**

With the test instance and a transcript of the meeting file with speakers 2 and names renamed ("Zira", "Hazel"), timestamps on, and a summary made: export each format to `C:\t\export\meeting.<ext>` through CDP (`invoke("export_file", …)` with the same doc the menu builds) or through the menu. Check:
- PDF: `py -m pip install pypdf` once, then `py -c "import pypdf;r=pypdf.PdfReader(r'C:\t\export\meeting.pdf');print(len(r.pages));print(r.pages[0].extract_text()[:600])"` — the title, the meta line, "Summary", "[1:14] Hazel:" appear; page size A4 (595 × 842 pt) on a Swiss region.
- A second PDF with a Chinese and a German sample (a segment text "我们下周二开会。 Grüsse aus Zürich." via CDP) extracts with those characters.
- DOCX: opens in Word (or unzip and grep `word/document.xml` for "Hazel: ").
- SRT/VTT: first cue times `00:00:00,…`/`00:00:00.…`, speaker prefix / `<v Zira>`; play `meeting.mp4` in VLC with the `.srt` to see the cues line up.
- TXT: same as the text box plus the summary on top.
Timestamps off: PDF, DOCX and TXT have no `[m:ss]`; subtitles still have times.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/main.rs index.html src/files.ts src/i18n.ts src/style.css
git commit -m "feat: export menu for PDF, Word, subtitles and text"
```

---

### Task 11: Resizable window

**Files:**
- Modify: `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/src/main.rs`
- Modify: `src/style.css`, `index.html`, `src/files.ts`, `src/i18n.ts`

**Interfaces:**
- Produces: the main window resizable/maximisable with remembered state; `#section-files` fills the height; the summary can be collapsed.

- [ ] **Step 1: Window limits**

In `tauri.conf.json`, main window: `"resizable": true`, `"maximizable": true`, and add `"minWidth": 900`, `"minHeight": 600`.

- [ ] **Step 2: Remember size and position**

`Cargo.toml` `[dependencies]`: `tauri-plugin-window-state = "2.4"`. In `main.rs`, register after the dialog plugin:

```rust
        // Size, position and maximised state of the main window, restored at
        // start (not the overlay pill or the hidden PDF window).
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .with_denylist(&["overlay", "pdf-export"])
                .build(),
        )
```

In `setup`, where the main window handle is obtained and before it is shown, add:

```rust
            // A saved position on a monitor that is gone: centre it.
            if matches!(main_window.current_monitor(), Ok(None)) {
                let _ = main_window.center();
                startup_log::log("main window was off-screen; centred");
            }
```

(Use the variable name `setup` already has for the main window.)

- [ ] **Step 3: Layout**

In `src/style.css`, change `.content-section` to keep today's width and centre it:

```css
.content-section {
  display: none;
  max-width: 680px;
  margin: 0 auto;
  padding: 32px 40px;
  animation: fadeIn 200ms ease;
}
```

and add:

```css
/* The Files tab uses the whole window: the transcript takes the height. */
#section-files {
  max-width: none;
}

#section-files.active {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

#section-files .file-result:not(.hidden) {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

#section-files .file-text {
  flex: 1;
  min-height: 260px;
  resize: none;
}

.file-summary.collapsed .file-summary-text {
  display: none;
}
```

Check the History tab: if its list has a fixed `max-height`, change it to fill the section the same way (`flex: 1`) so it uses the extra height.

- [ ] **Step 4: Collapsible summary**

In `index.html`, in `.file-summary-head`, before the copy button, add `<button id="file-summary-toggle" class="btn-ghost" aria-expanded="true" data-i18n="files_summary_hide">Hide</button>`. Strings: EN `files_summary_hide: "Hide"`, `files_summary_show: "Show"`; DE `files_summary_hide: "Ausblenden"`, `files_summary_show: "Einblenden"`. In `files.ts`:

```ts
const summaryToggle = document.getElementById("file-summary-toggle") as HTMLButtonElement;

function setSummaryCollapsed(collapsed: boolean) {
  summaryBox.classList.toggle("collapsed", collapsed);
  summaryToggle.textContent = t(collapsed ? "files_summary_show" : "files_summary_hide");
  summaryToggle.setAttribute("aria-expanded", String(!collapsed));
}
```

In `initFiles`: `summaryToggle.addEventListener("click", () => setSummaryCollapsed(!summaryBox.classList.contains("collapsed")));`. In `summarize()`, call `setSummaryCollapsed(false)` when a summary starts.

- [ ] **Step 5: Build and check**

Run: `npx tsc --noEmit`; `npm run tauri build -- --no-bundle`. Start the app (test instance). Check at 900 × 600, at 1400 × 900 and maximised on a 2560 × 1440 screen: every tab renders without overflow or clipping; settings tabs look as before, centred; the Files transcript fills the height. Close the app from the tray, start it again: size, position and maximised state are back. Edit the plugin's state file (`.window-state.json` in the app data folder) to put the window at x = 20000, start: the window is centred and the log says "main window was off-screen; centred".

- [ ] **Step 6: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/main.rs src/style.css index.html src/files.ts src/i18n.ts
git commit -m "feat: resizable main window that remembers its size"
```

---

### Task 12: Docs and full check

**Files:**
- Modify: `README.md`, `README.de.md`, `CHANGELOG.md`

- [ ] **Step 1: README (EN, DE)**

- Features, "Transcribe files" bullet: add "export as PDF, Word (.docx), subtitles (.srt, .vtt) or text, with or without timestamps; separate the speakers (Auto or 2 to 8, names you set once; a 45 MB speaker model downloads on first use and runs on the CPU, about 8 % of the audio length on a 12-core desktop)".
- Features: "The window can be resized and maximised and remembers its size."
- Development setup: after step 3b add

```powershell
# 3d. Fetch the sherpa-onnx runtime for speaker separation (pinned, SHA-256 checked)
powershell -ExecutionPolicy Bypass -File scripts/setup-speakers.ps1
```

  and a note: "`cargo run`, examples and dev builds need `src-tauri\binaries\sherpa-onnx\lib` on PATH for speaker separation (the installer puts the DLLs next to the exe)."
- Architecture: "**Speakers:** [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) v1.12.9 (pyannote segmentation 3.0, 3D-Speaker ERes2Net), shared DLLs delay-loaded by `rudariflow.exe`"; "**Export:** Word via docx-rs, PDF through WebView2's PrintToPdf".

German versions with the same content.

- [ ] **Step 2: CHANGELOG**

Under `## [Unreleased]` → `### Added`:

```markdown
- **Speakers in file transcripts:** choose Auto or 2 to 8 speakers next to
  the language, and each change of speaker starts a paragraph with the
  name. Rename a speaker once and the name is used everywhere, the summary
  included. The speaker model (45 MB) downloads on first use and runs on
  the CPU: about 50 s for a 10-minute meeting on a 12-core desktop.
- **Export** file transcripts as PDF, Word (.docx), subtitles (.srt, .vtt)
  or text, with or without timestamps and with the summary on top.
- **A resizable window:** the main window can be resized and maximised,
  and remembers its size and position. Long transcripts use the height.
```

- [ ] **Step 3: Full check**

Run: `cargo test --no-default-features --lib --bins`; `npx tsc --noEmit`; `cargo clippy --no-default-features --lib --bins` (no new warnings in the new files); build the NSIS installer (`npm run tauri build -- --bundles nsis`) and install it over the current version on a test profile: the Files tab separates speakers on the meeting file and exports all five formats; a PC without the speaker model downloads it when a number is chosen; with `sherpa-onnx-c-api.dll` renamed in the install folder, choosing 2 speakers transcribes without speakers and the status says a file is missing, the app does not crash.

- [ ] **Step 4: Commit**

```bash
git add README.md README.de.md CHANGELOG.md
git commit -m "docs: speakers, exports and the resizable window"
```

---

## Live checks (test instance)

The checks in Tasks 5, 6, 10 and 11 use an isolated instance that never touches the user's data. From PowerShell:

```powershell
$env:RUDARIFLOW_DATA_DIR = "C:\t\rf-test-data"          # config.json, models (hardlinked), history
$env:RUDARIFLOW_TEST_COMMANDS = "1"
$env:WEBVIEW2_USER_DATA_FOLDER = "C:\t\rf-test-data\webview"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
$env:RUDARIFLOW_LLAMA_DIR = "E:\claude\RudariFlow\src-tauri\binaries\llama"
$env:PATH = "E:\claude\RudariFlow\src-tauri\binaries\gpu-runtime;E:\claude\RudariFlow\src-tauri\binaries\sherpa-onnx\lib;" + $env:PATH
Start-Process C:\r\release\rudariflow.exe -ArgumentList "--start-minimized" -WorkingDirectory C:\r\release
```

Drive it through the Chrome DevTools Protocol on port 9333: evaluate `await window.__TAURI_INTERNALS__.invoke("<command>", {...})` in the page titled "RudariFlow". Keep `autostart: true` in the test `config.json` (startup syncs the shared autostart registry entry). The test media (meeting.mp3/.wav/.mp4, WhatsApp .opus) are TTS recordings with Zira at 0:01 and 2:30 and Hazel at 1:15.
