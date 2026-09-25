# Free GPU hotkey and Files Clear button: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fourth hotkey frees the GPU (unloads Whisper, stops llama-server) and loads both again on the next press, with pill notices. The Files tab gets a Clear button that returns it to the empty state.

**Architecture:**
- Both engines learn a *release*: an unload that is remembered until something loads the model again (`WhisperEngine::release`, `LlmServer::release`). While the AI is released, background starts stay off, and `wait_ready` waits at least 20 s so the first dictation keeps its AI cleanup.
- `power::gpu_toggle` decides between free and load.
- In main.rs, `free_gpu_press` runs the presses in order behind a tokio mutex. It waits for a running dictation before it frees, loads Whisper before the AI, and shows pill notices (`gpu-notice`, with texts in `overlay.html`).
- A fourth `HotkeyAction::FreeGpu`, with the setting `freeGpuHotkey` (off by default), plugs into the existing hotkey code.
- The Files tab gets Clear in the file line, plus an `exporting` counter.

**Tech Stack:** Rust (Tauri 2.10.3, tokio), whisper-rs 0.16, the bundled llama-server, TypeScript (vanilla, Vite).

**Spec:** `docs/superpowers/specs/2026-09-25-free-gpu-and-files-clear-design.md`

## Global Constraints

- **Build environment:** Windows 10/11 x64. Set it up from Git Bash with `source /e/claude/RudariFlow/.superpowers/tools/env13.sh`. It puts CMake, LLVM and the Vulkan SDK on PATH and sets `LIBCLANG_PATH`, CUDA 13.4 (`CUDA_PATH`, `CUDA_PATH_V13_4`), `CMAKE_POLICY_VERSION_MINIMUM=3.5` and `CARGO_TARGET_DIR=C:\r`.
- **App build:** from the repo root, run `CARGO_TARGET_DIR='C:\r' npm run tauri build -- --no-bundle`. Run it in the foreground with a 600000 ms timeout. Afterwards, if `git diff --ignore-cr-at-eol --stat src-tauri/Cargo.toml` is empty, run `git checkout -- src-tauri/Cargo.toml`, because `tauri build` rewrites its line endings.
- **Unit tests:** the CPU build. From `src-tauri`, run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib <filter>` (use `--bins <filter>` for tests in `main.rs`). Always pass a filter. Never run the full suite while the user works: its `paste.rs` tests overwrite the user's clipboard.
- **Frontend:** `npx tsc --noEmit` from the repo root, with no errors.
- **Live checks:** only on the isolated test instance (see "Live checks" at the end).
  - Never stop, start or drive the installed app (`E:\Users\Shiggy\AppData\Local\RudariFlow`) or its llama-server.
  - No tray clicks, SendKeys, native dialogs or focus stealing.
  - Check the free video memory before starting, and stop the test instance right after each check.
- **Commits:** the message is `feat:`, `fix:`, `docs:` or `test:` plus a subject, then an **empty line**, then `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Use `git commit -F -` with a heredoc so the empty line is kept.
- **Strings:** every new UI string exists in English and German. Main-window strings go in `src/i18n.ts`. Pill strings go in the `NOTICE_TEXT` map in `src/overlay.html`, a separate webview (spec, open question 3).
- **Setting:** `freeGpuHotkey` (Rust `free_gpu_hotkey`), default `""`, which means off.
- **No version bump or release:** the controller does that.

## File map

| File | Change |
|---|---|
| `src-tauri/src/power.rs` | `GpuToggle`, `gpu_toggle` |
| `src-tauri/src/whisper_engine.rs` | `release`, `released`; a load ends the release |
| `src-tauri/src/llm_server.rs` | `release`, `released`, `RELEASED_WAIT`, `wait_budget`; a start ends the release |
| `src-tauri/src/polish.rs` | doc comment of `WAIT_FOR_MODEL` |
| `src-tauri/src/main.rs` | `GpuFree` state, `free_gpu_press`, `gpu_notice`, `free_gpu_test`, `start_ai`/`warm_ai`, `load_whisper -> bool`, `summary_error`, `AiStatus.gpuFreed`, `HotkeyAction::FreeGpu`, `taken_by_other`, registration, tests |
| `src-tauri/src/settings.rs` | `free_gpu_hotkey` |
| `src-tauri/src/mouse_hotkey.rs` | comments (four hotkeys) |
| `src/overlay.html` | `gpu-notice` texts and listener |
| `index.html`, `src/main.ts` | Free GPU row in the Recording tab |
| `src/ai-settings.ts` | "Unloaded to free the GPU" status |
| `src/files.ts`, `src/style.css` | Clear button, `exporting` counter, `showText` guard, `gpu_freed` error |
| `src/i18n.ts` | new strings (EN, DE) |
| `README.md`, `README.de.md`, `CHANGELOG.md` | docs |

---

### Task 1: Release in the engines, and the toggle decision

**Files:**
- Modify: `src-tauri/src/power.rs`
- Modify: `src-tauri/src/whisper_engine.rs`
- Modify: `src-tauri/src/llm_server.rs`
- Modify: `src-tauri/src/polish.rs` (doc comment only)

**Interfaces:**
- Produces:
  - `power::GpuToggle { Free, Load }`
  - `power::gpu_toggle(freed: bool, whisper_released: bool, ai_released: bool) -> GpuToggle`
  - `WhisperEngine::release(&self)`, `WhisperEngine::released(&self) -> bool`
  - `LlmServer::release(&self)`, `LlmServer::released(&self) -> bool`
  - `llm_server::RELEASED_WAIT: Duration` (20 s)

- [ ] **Step 1: Failing test for the decision**

In `src-tauri/src/power.rs`, add to `mod tests`:

```rust
    #[test]
    fn free_gpu_loads_only_what_the_last_press_freed() {
        assert_eq!(gpu_toggle(false, false, false), GpuToggle::Free, "loaded, or unloaded on battery");
        assert_eq!(gpu_toggle(true, true, true), GpuToggle::Load, "the last press freed both");
        assert_eq!(gpu_toggle(true, false, true), GpuToggle::Free, "a dictation or file loaded Whisper since");
        assert_eq!(gpu_toggle(true, true, false), GpuToggle::Free, "a dictation or summary started the AI since");
        assert_eq!(gpu_toggle(false, true, true), GpuToggle::Free, "the last press loaded; there was nothing to load");
    }
```

Run:

```bash
source /e/claude/RudariFlow/.superpowers/tools/env13.sh
cd /e/claude/RudariFlow/src-tauri && CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib power::
```

Expected: compile error `cannot find function gpu_toggle` / `GpuToggle`.

- [ ] **Step 2: The decision**

In `power.rs`, replace the module doc's first two lines with:

```rust
//! Power state. On battery, RudariFlow frees the GPU after a while without
//! dictation, so a laptop's graphics card can go to sleep. The Free GPU
//! hotkey frees it on demand (`gpu_toggle`).
```

Add after `should_unload`:

```rust
/// What a press of the Free GPU hotkey does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuToggle {
    /// Unload Whisper and stop the AI server.
    Free,
    /// Load them again.
    Load,
}

/// Load again only when the last press freed the GPU and both models are
/// still released. Once a dictation, a file or a summary has loaded one of
/// them, the press frees the GPU again. The battery watcher's unload is not
/// a release, so a press after it frees too.
pub fn gpu_toggle(freed: bool, whisper_released: bool, ai_released: bool) -> GpuToggle {
    if freed && whisper_released && ai_released {
        GpuToggle::Load
    } else {
        GpuToggle::Free
    }
}
```

Run the same command. Expected: `test result: ok. 2 passed`.

- [ ] **Step 3: Failing test for Whisper's release**

In `whisper_engine.rs`, add to `mod tests`:

```rust
    #[test]
    fn a_release_lasts_until_a_model_loads() {
        let engine = WhisperEngine::new();
        assert!(!engine.released());
        engine.release();
        assert!(engine.released());
        assert!(!engine.is_loaded());
        engine.invalidate();
        assert!(engine.released(), "a settings change keeps it released");
        // A load that fails does not end the release.
        assert!(engine.ensure_loaded(Path::new("no-such-model.bin"), "cpu").is_err());
        assert!(engine.released());
    }
```

Run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib whisper_engine::`. Expected: compile error (`release`, `released` missing).

- [ ] **Step 4: Whisper's release**

In `whisper_engine.rs`, below `use std::sync::Mutex;`, add:

```rust
use std::sync::atomic::{AtomicBool, Ordering};
```

In `pub struct WhisperEngine`, after `flash_attn`:

```rust
    /// Unloaded by the Free GPU hotkey and not loaded since (see `release`).
    released: AtomicBool,
```

In `WhisperEngine::new()`, add `released: AtomicBool::new(false),`. After `invalidate`:

```rust
    /// Free the GPU (Free GPU hotkey): drop the model like `invalidate`, and
    /// remember it until a load brings it back. Waits for a transcription
    /// that is running. A file being transcribed keeps its own reference to
    /// the model until it is done.
    pub fn release(&self) {
        let mut state = self.lock();
        state.loaded = None;
        self.released.store(true, Ordering::SeqCst);
    }

    /// Released by `release` and not loaded since.
    pub fn released(&self) -> bool {
        self.released.load(Ordering::SeqCst)
    }
```

In `ensure_loaded`, in the `Ok((ctx, wstate))` arm, directly after `state.loaded = Some(Loaded { … });`:

```rust
                    self.released.store(false, Ordering::SeqCst);
```

(The flag is set and cleared under the engine lock, so a load that was already running when a release came is undone by that release, never the other way round.)

Run the same command. Expected: all `whisper_engine` tests pass, one of them ignored.

- [ ] **Step 5: Failing tests for the AI server's release**

In `llm_server.rs`, add to `mod tests`:

```rust
    #[test]
    fn a_released_server_is_waited_for_longer() {
        let three = Duration::from_secs(3);
        assert_eq!(wait_budget(three, false), three);
        assert_eq!(wait_budget(three, true), RELEASED_WAIT);
        let summary = Duration::from_secs(120);
        assert_eq!(wait_budget(summary, true), summary, "a longer wait stays");
    }

    #[test]
    fn a_release_lasts_until_a_start_succeeds() {
        let dir = std::env::temp_dir().join("rudariflow_release");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let model = dir.join("model.gguf");
        std::fs::write(&model, b"not a model").unwrap();
        // No llama-server in this folder: every start fails.
        let llm = Arc::new(LlmServer::new(dir.join("llama"), dir.join("llm-server.log"), Box::new(|_| {})));
        assert!(!llm.released());
        llm.release();
        assert!(llm.released());
        assert_eq!(llm.status(), ServerStatus::Stopped);
        llm.stop();
        assert!(llm.released(), "a stop (settings, battery) keeps it");
        let started = Instant::now();
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(llm.wait_ready(&model, None, Duration::from_secs(3)));
        assert!(result.unwrap_err().contains("llama-server not found"));
        assert!(started.elapsed() < Duration::from_secs(3), "a failed start ends the longer wait early");
        assert!(llm.released(), "only a start that succeeds ends it");
    }
```

Run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib llm_server::`. Expected: compile error (`wait_budget`, `RELEASED_WAIT`, `release`, `released` missing).

- [ ] **Step 6: The AI server's release**

In `llm_server.rs`, after `const PRIME_TIMEOUT`:

```rust
/// A request waits at least this long for a server that the Free GPU hotkey
/// released: the first dictation after a free gets its AI cleanup a few
/// seconds late instead of losing it (llama-server needs 4 to 7 s on an
/// RTX 5080 from a warm disk).
pub const RELEASED_WAIT: Duration = Duration::from_secs(20);

/// How long a request waits for a loading server: `wait`, but at least
/// `RELEASED_WAIT` after a release.
fn wait_budget(wait: Duration, released: bool) -> Duration {
    if released {
        wait.max(RELEASED_WAIT)
    } else {
        wait
    }
}
```

In `pub struct LlmServer`, after `draft_crashed`:

```rust
    /// Set by `release` (Free GPU hotkey) until a start succeeds.
    released: AtomicBool,
```

In `LlmServer::new`, add `released: AtomicBool::new(false),` after `draft_crashed: …`. After `pub fn stop`:

```rust
    /// Free the GPU (Free GPU hotkey): stop the server like `stop`, and keep
    /// it released until a request starts it again. Background starts
    /// (`warm_ai` in main.rs) leave it off, and the request that brings it
    /// back waits up to `RELEASED_WAIT` for it.
    pub fn release(&self) {
        // Set before `stop` reports Stopped (the AI tab reads it then), and
        // again after it, in case a start finished in between.
        self.released.store(true, Ordering::SeqCst);
        self.stop();
        self.released.store(true, Ordering::SeqCst);
    }

    /// Released and not started since.
    pub fn released(&self) -> bool {
        self.released.load(Ordering::SeqCst)
    }
```

In `ensure_running`, in the `Ok(endpoint)` arm, after `self.failures.store(0, Ordering::SeqCst);`:

```rust
                self.released.store(false, Ordering::SeqCst);
```

In `wait_ready`, change its doc's last sentence to `Gives up after \`wait\` (at least \`RELEASED_WAIT\` after a release); the start continues.` and make this its first line:

```rust
        let wait = wait_budget(wait, self.released());
```

In `polish.rs`, replace the doc of `WAIT_FOR_MODEL` with:

```rust
/// How long a dictation waits for a model that is still loading; after the
/// Free GPU hotkey released it, `LlmServer::wait_ready` makes it at least
/// `llm_server::RELEASED_WAIT`.
```

Run:

```bash
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib llm_server::
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib polish::
```

Expected: both pass; `server_failure_pastes_plain_text` still finishes within 3 s.

- [ ] **Step 7: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/power.rs src-tauri/src/whisper_engine.rs src-tauri/src/llm_server.rs src-tauri/src/polish.rs
git commit -F - <<'EOF'
feat: Whisper and the AI server can be released to free the GPU

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: The Free GPU toggle and its pill notices

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src/overlay.html`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `AppState.gpu: GpuFree`
  - `async fn free_gpu_press(handle: &AppHandle, press: u64) -> FreeGpuResult`
  - the test command `free_gpu_test` → `"Freed" | "Loaded" | "LoadFailed" | "Overtaken"`
  - the event `gpu-notice` with `"freed" | "loading" | "loaded" | "failed"`
  - `AiStatus.gpuFreed`
  - the `summarize_text` error `"gpu_freed"`
  - `fn start_ai`, and `warm_ai` now gated

- [ ] **Step 1: Imports and state**

In `main.rs`, below `use std::sync::{Arc, Mutex, OnceLock};`, add `use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};`, and replace `use rudariflow_lib::power;` with `use rudariflow_lib::power::{self, GpuToggle};`. The function-local `use std::sync::atomic::Ordering;` in `on_rewrite_hotkey` is now redundant; delete it.

In `struct AppState`, after `last_activity`:

```rust
    /// The Free GPU hotkey (see `free_gpu_press`).
    gpu: GpuFree,
```

Below `struct AppState`:

```rust
/// State of the Free GPU hotkey.
#[derive(Default)]
struct GpuFree {
    /// The last press freed the GPU; a press that loads clears it.
    freed: AtomicBool,
    /// Counts presses, so a load that a newer press overtook shows no notice.
    press: AtomicU64,
    /// Presses run one after the other.
    ops: tokio::sync::Mutex<()>,
}
```

In `main()`, in `.manage(AppState { … })`, after `last_activity: …,` add `gpu: GpuFree::default(),`.

- [ ] **Step 2: `load_whisper` reports failure; background AI starts stay off while released**

Replace `load_whisper` with:

```rust
/// Load the Whisper model now instead of at the first dictation. False when
/// a load was tried and failed (the log says why); true when it loaded or
/// the settings load none (Groq, or no model downloaded).
async fn load_whisper(state: &AppState) -> bool {
    let settings = state.settings.lock().unwrap().clone();
    state.whisper_engine.set_flash_attn(settings.flash_attn_pref());
    let Some(model) = whisper_model_to_load(&settings, &state.app_dir) else {
        return true;
    };
    let engine = state.whisper_engine.clone();
    let started = std::time::Instant::now();
    let loaded = tauri::async_runtime::spawn_blocking(move || engine.ensure_loaded(&model, &settings.gpu_backend)).await;
    match loaded {
        Ok(Ok(_)) => {
            startup_log::log(&format!("[engine] ready after {} ms", started.elapsed().as_millis()));
            true
        }
        Ok(Err(e)) => {
            startup_log::log(&format!("[engine] load failed: {}", e));
            false
        }
        Err(e) => {
            startup_log::log(&format!("[engine] load task failed: {}", e));
            false
        }
    }
}
```

(Existing callers keep `load_whisper(…).await;`.) Replace `warm_ai` with:

```rust
/// Start the AI server in the background when the settings use it.
fn start_ai(state: &AppState) {
    let settings = state.settings.lock().unwrap().clone();
    if let Some(model) = ai_model_to_run(&settings, &state.app_dir) {
        state.llm.warm(model, Some(settings.gpu_backend));
    }
}

/// `start_ai` for background starts (app start, settings, a download), but
/// not while the Free GPU hotkey keeps the AI unloaded: then the next
/// request starts it.
fn warm_ai(state: &AppState) {
    if !state.llm.released() {
        start_ai(state);
    }
}
```

Replace `ai_restart` with:

```rust
/// Restart the AI server, e.g. after it failed twice. Retry is asked for, so
/// it starts after a Free GPU press too.
#[tauri::command]
fn ai_restart(state: State<AppState>) {
    state.llm.stop();
    start_ai(&state);
}
```

In `save_settings`, replace the `if engine_invalidate { … }` block with:

```rust
    if engine_invalidate {
        state.whisper_engine.invalidate();
        // Load the new model or backend now, not at the next dictation;
        // after a Free GPU press the next use loads it.
        if !state.whisper_engine.released() {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                load_whisper(app.state::<AppState>().inner()).await;
            });
        }
    }
```

- [ ] **Step 3: A summary cut off by a free, and the AI tab's status**

Above `summarize_text` add:

```rust
/// A summary request that failed because the Free GPU hotkey stopped the
/// AI server: "gpu_freed", which the Files tab shows in words.
fn summary_error(llm: &LlmServer, error: String) -> String {
    if llm.released() {
        "gpu_freed".to_string()
    } else {
        error
    }
}
```

In `summarize_text`, add `"gpu_freed"` to its doc ("…or \"gpu_freed\" when the Free GPU hotkey stopped the AI"). Both `ai_cleanup::complete_in( … )` calls end in `.await?;`; make each of them:

```rust
            .await
            .map_err(|e| summary_error(&state.llm, e))?;
```

In `struct AiStatus`, after `downloading`:

```rust
    /// Unloaded by the Free GPU hotkey; the next request starts it.
    #[serde(rename = "gpuFreed")]
    gpu_freed: bool,
```

In `ai_status`, add `gpu_freed: state.llm.released(),` after `downloading: …,`.

- [ ] **Step 4: The press**

Add after `paste_last_transcript`:

```rust
/// What a press of the Free GPU hotkey did.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
enum FreeGpuResult {
    Freed,
    Loaded,
    /// Whisper or the AI did not load; the log and the AI tab say why.
    LoadFailed,
    /// A newer press came while the AI was loading.
    Overtaken,
}

/// A Free GPU notice in the pill ("freed", "loading", "loaded", "failed"),
/// but not during a dictation: the pill shows its recording then.
fn gpu_notice(handle: &AppHandle, kind: &str) {
    let state = handle.state::<AppState>();
    if state.recorder.get_state() == RecordingState::Ready {
        state.recorder.notice(handle, "gpu-notice", kind);
    }
}

/// One press of the Free GPU hotkey, number `press` of `GpuFree::press`:
/// free the GPU, or load the models again when the last press freed it and
/// nothing has loaded them since (`power::gpu_toggle`). Presses run in order.
async fn free_gpu_press(handle: &AppHandle, press: u64) -> FreeGpuResult {
    let state = handle.state::<AppState>();
    let ops = state.gpu.ops.lock().await;
    let toggle = power::gpu_toggle(
        state.gpu.freed.load(Ordering::SeqCst),
        state.whisper_engine.released(),
        state.llm.released(),
    );
    if toggle == GpuToggle::Free {
        // A dictation keeps its models until it is pasted.
        if state.recorder.get_state() != RecordingState::Ready {
            startup_log::log("[gpu] freeing once the dictation is done");
            while state.recorder.get_state() != RecordingState::Ready {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
        state.gpu.freed.store(true, Ordering::SeqCst);
        let (llm, engine) = (state.llm.clone(), state.whisper_engine.clone());
        // Stopping llama-server waits for it to exit; Whisper waits for a
        // block of a file that is running (the file keeps its own reference
        // to the model until it is done).
        let _ = tauri::async_runtime::spawn_blocking(move || {
            llm.release();
            engine.release();
        })
        .await;
        startup_log::log("[gpu] freed: Whisper unloaded, AI server stopped");
        gpu_notice(handle, "freed");
        return FreeGpuResult::Freed;
    }
    state.gpu.freed.store(false, Ordering::SeqCst);
    // Asked for now: the battery watcher must not unload them at its next look.
    *state.last_activity.lock().unwrap() = std::time::Instant::now();
    gpu_notice(handle, "loading");
    let started = std::time::Instant::now();
    // Whisper first, as at start: llama-server's --fit measures the free
    // video memory once, when it loads.
    let whisper_ok = load_whisper(state.inner()).await;
    // A press from here on frees the GPU at once; its release stops this start.
    drop(ops);
    let settings = state.settings.lock().unwrap().clone();
    let ai_ok = match ai_model_to_run(&settings, &state.app_dir) {
        Some(model) => state.llm.ensure_running(&model, Some(settings.gpu_backend.as_str())).await.is_ok(),
        None => true,
    };
    if state.gpu.press.load(Ordering::SeqCst) != press {
        return FreeGpuResult::Overtaken;
    }
    let loaded = whisper_ok && ai_ok;
    startup_log::log(&format!(
        "[gpu] models {} after {} ms",
        if loaded { "loaded" } else { "not all loaded" },
        started.elapsed().as_millis()
    ));
    gpu_notice(handle, if loaded { "loaded" } else { "failed" });
    if loaded {
        FreeGpuResult::Loaded
    } else {
        FreeGpuResult::LoadFailed
    }
}

/// Test hook: one press of the Free GPU hotkey, waited for. Only with
/// RUDARIFLOW_TEST_COMMANDS=1.
#[tauri::command]
async fn free_gpu_test(app: AppHandle, state: State<'_, AppState>) -> Result<FreeGpuResult, String> {
    if std::env::var("RUDARIFLOW_TEST_COMMANDS").as_deref() != Ok("1") {
        return Err("test commands are off".to_string());
    }
    let press = state.gpu.press.fetch_add(1, Ordering::SeqCst) + 1;
    Ok(free_gpu_press(&app, press).await)
}
```

Register it: in `generate_handler![…]`, add `free_gpu_test,` after `caret_test,`.

- [ ] **Step 5: The pill's texts**

In `src/overlay.html`, in `NOTICE_TEXT.en` after `edit_failed: "Edit failed, text unchanged",`:

```js
          gpu_freed: "GPU freed", gpu_loading: "Loading models…", gpu_loaded: "Models loaded",
          gpu_failed: "Models could not be loaded",
```

In `NOTICE_TEXT.de` after `edit_failed: "Bearbeiten ging nicht, Text unverändert",`:

```js
          gpu_freed: "GPU freigegeben", gpu_loading: "Modelle werden geladen…", gpu_loaded: "Modelle geladen",
          gpu_failed: "Modelle konnten nicht geladen werden",
```

After the `rewrite-failed` listener:

```js
      // Free GPU hotkey: "freed", "loading", "loaded" or "failed".
      listen("gpu-notice", (event) => {
        const t = NOTICE_TEXT[pickLang()];
        const text = { freed: t.gpu_freed, loading: t.gpu_loading, loaded: t.gpu_loaded, failed: t.gpu_failed }[event.payload];
        diag(`gpu-notice received (${event.payload})`);
        if (text) showNotice(text, 3000);
      });
```

- [ ] **Step 6: Compile**

From `src-tauri`, run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo check --no-default-features --bins`. Expected: finishes with no errors and no warnings in `main.rs`. Then `cargo test --no-default-features --lib power::` still passes.

- [ ] **Step 7: Live check through `free_gpu_test`**

Build the app, check the headroom and start the test instance ("Live checks" below). Write these files to the scratch folder `$S`, replacing `MEDIA` with the media folder:

`free.js`:
```js
return JSON.stringify(await window.__TAURI_INTERNALS__.invoke("free_gpu_test"));
```

`status.js`:
```js
const s = await window.__TAURI_INTERNALS__.invoke("ai_status");
return JSON.stringify({ server: s.server, gpuFreed: s.gpuFreed });
```

`ai_after_free.js`:
```js
const r = await window.__TAURI_INTERNALS__.invoke("ai_test", { text: "um so we meet on tuesday no wait wednesday at three", app: "notepad" });
return JSON.stringify({ text: r.text, fallback: r.fallback, aiMs: r.aiMs });
```

`file_after_free.js`:
```js
const i = window.__TAURI_INTERNALS__.invoke;
const r = await i("transcribe_file", { path: "MEDIA/meeting.mp3", language: "", speakers: "off" });
const s = await i("ai_status");
return JSON.stringify({ segments: r.segments.length, ai: s.server.state, gpuFreed: s.gpuFreed });
```

`summary_cut.js`:
```js
const i = window.__TAURI_INTERNALS__.invoke;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r = await i("transcribe_file", { path: "MEDIA/long20min.m4a", language: "", speakers: "off" });
const text = await i("format_file_text", { segments: r.segments, names: [], times: false });
const summary = i("summarize_text", { text }).then(() => "finished", (e) => String(e));
for (let n = 0; n < 300 && (await i("ai_status")).server.state !== "ready"; n++) await sleep(100);
await sleep(1500);
const press = await i("free_gpu_test");
return JSON.stringify({ press, summary: await summary });
```

`double.js`:
```js
const i = window.__TAURI_INTERNALS__.invoke;
return JSON.stringify(await Promise.all([i("free_gpu_test"), i("free_gpu_test")]));
```

`overtaken.js`:
```js
const i = window.__TAURI_INTERNALS__.invoke;
const load = i("free_gpu_test");
await new Promise((r) => setTimeout(r, 2500));
const free = await i("free_gpu_test");
return JSON.stringify({ load: await load, free });
```

Run in this order. Use `cdp.mjs <file>` for the main window. For the pill, run:

```bash
node E:/claude/RudariFlow/.superpowers/tools/cdp.mjs -e "return document.getElementById('notice').textContent + ' | ' + document.body.dataset.state" overlay
```

Take every memory reading with `gpu_mem.ps1`.

1. `gpu_mem.ps1`: the baseline, both test processes with their MiB. Record them.
2. `free.js` returns `"Freed"`.
   - The pill shows "GPU freed" / "GPU freigegeben" with state `notice`.
   - `gpu_mem.ps1`: the test llama-server is gone from nvidia-smi and the counters. The test `rudariflow` dropped by more than 1 GB. Record what stays (the CUDA context).
   - `status.js`: `{"state":"stopped"}` with `gpuFreed: true`.
   - startup.log has `[gpu] freed`.
3. `ai_after_free.js`: `fallback: null` and `aiMs` between 3000 and 20000. The AI was waited for; before this change the call returned "The AI model is still loading" after about 3000 ms. `status.js`: `ready`, `gpuFreed: false`.
4. `free.js` returns `"Freed"`, because the AI had come back.
5. `file_after_free.js`: `segments > 0`, `ai: "stopped"`, `gpuFreed: true`. `gpu_mem.ps1`: `rudariflow` is back up, with no llama-server.
6. `summary_cut.js`: `{"press":"Freed","summary":"gpu_freed"}`.
7. `free.js` returns `"Loaded"`. Right after, the pill shows "Models loaded" / "Modelle geladen". startup.log has `[overlay] gpu-notice received (loading)` before `(loaded)`, so the notice at the press came first. `gpu_mem.ps1`: both test processes are near the baseline. startup.log has `[gpu] models loaded after N ms`; record N.
8. `double.js`: one `"Freed"` and one `"Loaded"`. `gpu_mem.ps1` shows both loaded.
9. `free.js` returns `"Freed"`. Then `overtaken.js` gives `{"load":"Overtaken","free":"Freed"}`, and `gpu_mem.ps1` shows no test llama-server.

Stop the test instance.

- [ ] **Step 8: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/main.rs src/overlay.html
git commit -F - <<'EOF'
feat: Free GPU toggle that unloads Whisper and the AI and loads them again

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: The hotkey setting and the Settings row

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/mouse_hotkey.rs` (comments)
- Modify: `index.html`
- Modify: `src/main.ts`
- Modify: `src/i18n.ts`
- Modify: `src/ai-settings.ts`
- Modify: `src/files.ts` (one error key)

**Interfaces:**
- Consumes: `free_gpu_press`, `GpuFree::press` (Task 2), `AiStatus.gpuFreed`, `"gpu_freed"`.
- Produces:
  - setting `freeGpuHotkey`
  - `HotkeyAction::FreeGpu` (target `"freeGpu"`)
  - `fn taken_by_other(all: &[(HotkeyAction, String)], action: HotkeyAction, hotkey: &str) -> bool`
  - `fn on_free_gpu_hotkey(handle: &AppHandle)`

- [ ] **Step 1: Failing settings test**

In `settings.rs`, add to `mod tests`:

```rust
    #[test]
    fn free_gpu_hotkey_is_off_by_default_and_kept() {
        assert_eq!(Settings::default().free_gpu_hotkey, "");
        let before_0_13 = r#"{
            "microphone": "default",
            "engine": "local",
            "whisperModel": "small",
            "groqApiKey": "",
            "recordingMode": "toggle",
            "hotkey": "Mouse5"
        }"#;
        let s: Settings = serde_json::from_str(before_0_13).unwrap();
        assert_eq!(s.free_gpu_hotkey, "");

        let dir = temp_dir().join("typr_test_free_gpu_hotkey");
        let _ = fs::remove_dir_all(&dir);
        let mut settings = Settings::default();
        settings.free_gpu_hotkey = "Ctrl+Mouse5".to_string();
        settings.save(&dir).unwrap();
        assert_eq!(Settings::load(&dir).free_gpu_hotkey, "Ctrl+Mouse5");
        let _ = fs::remove_dir_all(&dir);
    }
```

Run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib settings::`. Expected: compile error (no field `free_gpu_hotkey`).

- [ ] **Step 2: The setting**

In `struct Settings`, after `rewrite_last_hotkey`:

```rust
    /// Frees the GPU (unloads Whisper, stops the AI server); the next press
    /// loads them again. Empty = off, the default: a global chord is taken
    /// from every app, games included.
    #[serde(rename = "freeGpuHotkey", default)]
    pub free_gpu_hotkey: String,
```

In `Default for Settings`, after `rewrite_last_hotkey: String::new(),` add `free_gpu_hotkey: String::new(),`.

Run the same command. Expected: all `settings` tests pass.

- [ ] **Step 3: Failing hotkey tests**

At the end of `main.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_gpu_is_the_fourth_hotkey() {
        assert_eq!(HotkeyAction::from_target("freeGpu"), Ok(HotkeyAction::FreeGpu));
        assert!(HotkeyAction::from_target("freegpu").is_err());
        let mut s = Settings::default();
        s.free_gpu_hotkey = "Alt+Shift+F10".to_string();
        assert_eq!(hotkeys(&s)[3], (HotkeyAction::FreeGpu, "Alt+Shift+F10".to_string()));
    }

    #[test]
    fn a_hotkey_serves_one_action() {
        let mut s = Settings::default();
        s.rewrite_last_hotkey = "Shift+Mouse5".to_string();
        let all = hotkeys(&s);
        assert!(taken_by_other(&all, HotkeyAction::FreeGpu, "shift+mouse5"), "mouse bindings by button and modifiers");
        assert!(taken_by_other(&all, HotkeyAction::FreeGpu, "cmdorctrl+shift+space"), "chords without case");
        assert!(!taken_by_other(&all, HotkeyAction::RewriteLast, "Shift+Mouse5"), "its own hotkey");
        assert!(!taken_by_other(&all, HotkeyAction::FreeGpu, "Alt+Shift+F10"));
    }
}
```

Run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --bins hotkey`. Expected: compile error (`FreeGpu`, `taken_by_other` missing).

- [ ] **Step 4: The fourth hotkey**

In `main.rs`:

`HotkeyAction` gets a variant after `RewriteLast`:

```rust
    /// Free the GPU, or load the models again (see `free_gpu_press`).
    FreeGpu,
```

`from_target` gets `"freeGpu" => Ok(Self::FreeGpu),`. Replace `hotkeys` with:

```rust
/// Every hotkey setting with its action.
fn hotkeys(s: &Settings) -> [(HotkeyAction, String); 4] {
    [
        (HotkeyAction::Dictation, s.hotkey.clone()),
        (HotkeyAction::PasteLast, s.paste_last_hotkey.clone()),
        (HotkeyAction::RewriteLast, s.rewrite_last_hotkey.clone()),
        (HotkeyAction::FreeGpu, s.free_gpu_hotkey.clone()),
    ]
}

/// Whether `hotkey` is already another action's hotkey: mouse bindings by
/// button and modifiers, chords without regard to case.
fn taken_by_other(all: &[(HotkeyAction, String)], action: HotkeyAction, hotkey: &str) -> bool {
    let same = |h: &str| match (mouse_hotkey::parse(hotkey), mouse_hotkey::parse(h)) {
        (Some(a), Some(b)) => a == b,
        _ => hotkey.eq_ignore_ascii_case(h),
    };
    all.iter().any(|(a, h)| *a != action && !h.is_empty() && same(h))
}
```

In `change_hotkey`:
- Change the doc to `/// \`target\` is "dictation", "pasteLast", "rewriteLast" or "freeGpu"; each takes a keyboard chord or a mouse side button. An empty \`new_hotkey\` turns paste-last, rewrite or free GPU off; dictation always needs one.`
- Replace the `let same = …;`, `let taken = …;` and `if !new_hotkey.is_empty() && taken {` lines with `if !new_hotkey.is_empty() && taken_by_other(&all, action, &new_hotkey) {`.
- Add the match arm `HotkeyAction::FreeGpu => settings.free_gpu_hotkey = new_hotkey,`.

In `set_hotkey_paused`, change the comment to `// An optional chord (paste last, rewrite, free GPU) taken by another app must not block the dictation hotkey; it is logged by register_hotkey.`

In `on_hotkey_event`, add after the `RewriteLast` arm:

```rust
        HotkeyAction::FreeGpu if pressed => on_free_gpu_hotkey(handle),
        HotkeyAction::FreeGpu => {}
```

After `free_gpu_press`:

```rust
/// The Free GPU hotkey was pressed. The work runs in the background: chords
/// arrive on the main thread, side buttons on the mouse hook's handler thread.
fn on_free_gpu_hotkey(handle: &AppHandle) {
    let press = handle.state::<AppState>().gpu.press.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let result = free_gpu_press(&handle, press).await;
        startup_log::log(&format!("[gpu] press {}: {:?}", press, result));
    });
}
```

In `main()`, after `let initial_rewrite_last_hotkey = …;` add `let initial_free_gpu_hotkey = settings.free_gpu_hotkey.clone();`. In `setup`, change the comment above the optional registrations to `// Paste-last, rewrite and free GPU are optional: if another app owns the chord, the setting stays and the failure is in startup.log.` and add after the rewrite registration:

```rust
            if !initial_free_gpu_hotkey.is_empty() {
                let _ = register_hotkey(app.handle(), &initial_free_gpu_hotkey, HotkeyAction::FreeGpu);
            }
```

In `mouse_hotkey.rs`, change the first doc line to `//! Mouse side buttons as global hotkeys (dictation, paste last, rewrite last, free GPU).`, and change `/// Most bindings at once (three hotkeys use them today).` to `(four hotkeys use them today)`.

Run:

```bash
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --bins hotkey
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib mouse_hotkey::
```

Expected: 2 passed; `mouse_hotkey` passes.

- [ ] **Step 5: The Settings row**

In `index.html`, in `#section-recording`, after the "Rewrite last dictation" row and before the "send it" row:

```html
            <div class="setting-row">
              <div class="setting-label">
                <span class="label-text" data-i18n="free_gpu_label">Free GPU</span>
                <span class="label-hint" data-i18n="free_gpu_hint">Unloads Whisper and the AI model to free your graphics card, e.g. for a game. Press again to load them; a dictation also loads them, the first one takes a few seconds longer.</span>
              </div>
              <div class="setting-control hotkey-control">
                <button id="free-gpu-btn" class="hotkey-btn"><kbd id="free-gpu-text"></kbd></button>
                <button id="free-gpu-clear" class="icon-btn" data-i18n-title="paste_last_clear" title="Turn off">
                  <svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
                </button>
              </div>
            </div>
```

In `src/main.ts`:
- In `interface Settings`, after `rewriteLastHotkey: string;`, add `freeGpuHotkey: string;`.
- After `const rewriteLastClear = …;`:

```ts
const freeGpuBtn = document.getElementById("free-gpu-btn") as HTMLButtonElement;
const freeGpuText = document.getElementById("free-gpu-text")!;
const freeGpuClear = document.getElementById("free-gpu-clear") as HTMLButtonElement;
```

- Replace the comment and `type HotkeyTarget` with:

```ts
// Hotkey capture. "dictation" starts/stops recording, "pasteLast" pastes the
// last transcript again, "rewriteLast" selects it and records an edit,
// "freeGpu" unloads the models or loads them again. Each takes a key
// combination or a mouse side button (with or without modifiers).
type HotkeyTarget = "dictation" | "pasteLast" | "rewriteLast" | "freeGpu";
```

- In `renderHotkeys`, add at the end:

```ts
  freeGpuText.textContent = hotkeyLabel(currentSettings.freeGpuHotkey);
  freeGpuClear.classList.toggle("hidden", !currentSettings.freeGpuHotkey);
```

- Replace `captureElements` and `setHotkey`:

```ts
function captureElements(target: HotkeyTarget) {
  if (target === "dictation") return { btn: hotkeyBtn, text: hotkeyText };
  if (target === "pasteLast") return { btn: pasteLastBtn, text: pasteLastText };
  if (target === "rewriteLast") return { btn: rewriteLastBtn, text: rewriteLastText };
  return { btn: freeGpuBtn, text: freeGpuText };
}
```

```ts
async function setHotkey(target: HotkeyTarget, combo: string) {
  await invoke("change_hotkey", { target, newHotkey: combo });
  if (target === "dictation") currentSettings.hotkey = combo;
  else if (target === "pasteLast") currentSettings.pasteLastHotkey = combo;
  else if (target === "rewriteLast") currentSettings.rewriteLastHotkey = combo;
  else currentSettings.freeGpuHotkey = combo;
}
```

(`currentSettings` must follow every change: `save_settings` writes the whole object back.)

- After the `pasteLastClear` listener:

```ts
freeGpuBtn.addEventListener("click", () => startCapture("freeGpu"));
freeGpuClear.addEventListener("click", async () => {
  try {
    await setHotkey("freeGpu", "");
  } catch (err) {
    console.error("clearing free-GPU hotkey failed:", err);
  }
  renderHotkeys();
});
```

- [ ] **Step 6: Strings, AI tab status, summary error**

In `src/i18n.ts`, add to `en`:
- after `rewrite_last_hint`:

```ts
  free_gpu_label: "Free GPU",
  free_gpu_hint: "Unloads Whisper and the AI model to free your graphics card, e.g. for a game. Press again to load them; a dictation also loads them, the first one takes a few seconds longer.",
```

- after `ai_status_failed`: `ai_status_freed: "Unloaded to free the GPU. Loads again at the next dictation.",`
- after `files_err_failed`: `files_err_gpu_freed: "The summary stopped because the GPU was freed. Summarise again to start over.",`

Add to `de`:
- after `rewrite_last_hint`:

```ts
  free_gpu_label: "GPU freigeben",
  free_gpu_hint: "Entlädt Whisper und das KI-Modell, damit die Grafikkarte frei wird, z. B. für ein Spiel. Nochmals drücken lädt sie wieder; auch ein Diktat lädt sie, das erste dauert ein paar Sekunden länger.",
```

- after `ai_status_failed`: `ai_status_freed: "Entladen, um die GPU freizugeben. Lädt beim nächsten Diktat wieder.",`
- after `files_err_failed`: `files_err_gpu_freed: "Die Zusammenfassung wurde abgebrochen, weil die GPU freigegeben wurde. Fasse erneut zusammen, um neu zu beginnen.",`

In `src/ai-settings.ts`, add to `interface AiStatus`:

```ts
  /** Unloaded by the Free GPU hotkey; the next dictation loads it. */
  gpuFreed: boolean;
```

In `renderStatus`, insert before the final `} else {` (the one that shows `ai_status_starting`):

```ts
  } else if (status.gpuFreed) {
    text = t("ai_status_freed");
```

In `src/files.ts`, in `errorText`'s map, add `gpu_freed: "files_err_gpu_freed",`.

Run (repo root): `npx tsc --noEmit`. Expected: no errors.

- [ ] **Step 7: Live check**

Build and start the test instance; its UI language is German. Write these files to `$S`:

`hotkey_set.js`:
```js
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
document.querySelector('[data-section="recording"]').click();
const before = $("free-gpu-text").textContent;
// Capture a chord the way the settings UI does: synthetic events in this page only.
$("free-gpu-btn").click();
await sleep(200);
window.dispatchEvent(new KeyboardEvent("keydown", { key: "F9", code: "F9", ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
await sleep(800);
const saved = (await window.__TAURI_INTERNALS__.invoke("get_settings")).freeGpuHotkey;
return JSON.stringify({ before, shown: $("free-gpu-text").textContent, saved, clearVisible: !$("free-gpu-clear").classList.contains("hidden") });
```

`hotkey_taken.js`:
```js
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
$("free-gpu-btn").click();
await sleep(200);
window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
await sleep(500);
const refused = $("free-gpu-text").textContent;
await sleep(2600);
return JSON.stringify({ refused, after: $("free-gpu-text").textContent });
```

`ai_tab.js`:
```js
const i = window.__TAURI_INTERNALS__.invoke;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
document.querySelector('[data-section="ai"]').click();
const press = await i("free_gpu_test");
await sleep(500);
const freed = document.getElementById("ai-status-line").textContent;
const back = await i("free_gpu_test");
await sleep(500);
return JSON.stringify({ press, freed, back, ready: document.getElementById("ai-status-line").textContent });
```

`hotkey_off.js`:
```js
const $ = (id) => document.getElementById(id);
document.querySelector('[data-section="recording"]').click();
$("free-gpu-clear").click();
await new Promise((r) => setTimeout(r, 500));
return JSON.stringify({ shown: $("free-gpu-text").textContent, saved: (await window.__TAURI_INTERNALS__.invoke("get_settings")).freeGpuHotkey });
```

Expected results:
1. `hotkey_set.js`: `before: "Nicht gesetzt"`, `shown: "Ctrl+Alt+Shift+F9"`, `saved: "CmdOrCtrl+Alt+Shift+F9"`, `clearVisible: true`. startup.log has `[hotkey] registering CmdOrCtrl+Alt+Shift+F9 for FreeGpu`.
2. `hotkey_taken.js`: `refused: "Schon für einen anderen Hotkey vergeben"` (the test config's dictation chord), then `after: "Ctrl+Alt+Shift+F9"`.
3. Stop and start the test instance. The new startup.log section registers `CmdOrCtrl+Alt+Shift+F9 for FreeGpu`.
4. `ai_tab.js`: `press: "Freed"`, `freed: "Entladen, um die GPU freizugeben. Lädt beim nächsten Diktat wieder."`, `back: "Loaded"`, and `ready` starts with `Bereit auf`.
5. `hotkey_off.js`: `shown: "Nicht gesetzt"`, `saved: ""`.

Stop the test instance.

- [ ] **Step 8: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/settings.rs src-tauri/src/main.rs src-tauri/src/mouse_hotkey.rs index.html src/main.ts src/i18n.ts src/ai-settings.ts src/files.ts
git commit -F - <<'EOF'
feat: Free GPU hotkey in the Recording settings, off by default

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: Clear in the Files tab

**Files:**
- Modify: `index.html`
- Modify: `src/files.ts`
- Modify: `src/style.css`
- Modify: `src/i18n.ts`

**Interfaces:**
- Produces: `#file-clear`, `clearFile()`, `updateClear()`, and the `exporting` counter in `files.ts`.

- [ ] **Step 1: Markup, style, strings**

In `index.html`, replace the `file-job-head` block with:

```html
            <div class="file-job-head">
              <span id="file-name" class="file-name"></span>
              <div class="file-job-actions">
                <button id="file-cancel" class="btn-ghost hidden" data-i18n="files_cancel">Cancel</button>
                <button id="file-clear" class="btn-ghost" data-i18n="files_clear" data-i18n-title="files_clear_title" title="Removes the transcript to start over. The audio file stays where it is.">Clear</button>
              </div>
            </div>
```

In `src/style.css`, change `.btn-ghost:disabled { cursor: default; }` to:

```css
.btn-ghost:disabled {
  cursor: default;
  opacity: 0.45;
}
```

After the `.file-name { … }` rule, add:

```css
.file-job-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
```

In `src/i18n.ts`, add after `files_cancelled`, in `en`:

```ts
  files_clear: "Clear",
  files_clear_title: "Removes the transcript to start over. The audio file stays where it is.",
```

and in `de`:

```ts
  files_clear: "Leeren",
  files_clear_title: "Entfernt das Transkript, um neu anzufangen. Die Audiodatei bleibt, wo sie ist.",
```

- [ ] **Step 2: Clear in `files.ts`**

After `const speakerChips = …;`, add `const clearBtn = document.getElementById("file-clear") as HTMLButtonElement;`. After `let speakersOn = false;`:

```ts
/** Exports running, from the save dialog until the file is written. */
let exporting = 0;

/** Clear is off while a file is transcribed, summarised or exported. */
function updateClear() {
  clearBtn.disabled = running || summarizing || exporting > 0;
}
```

Replace `showText`:

```ts
async function showText() {
  if (!segments.length) return;
  const shown = segments;
  const text = await shownText(timesToggle.checked);
  // Cleared, or another file started, while the text was formatted.
  if (segments === shown) textArea.value = text;
}
```

In `transcribe`, add `updateClear();` right after the `setButtons(false);` that follows `textArea.readOnly = false;`. In its `finally`, add `updateClear();` after `cancelBtn.classList.add("hidden");`.

Replace `summarize`. It now marks the summary as running before it formats the text, so Clear is off from the click on:

```ts
async function summarize() {
  // A summary still running for an earlier file must not land in this one.
  const run = ++summaryRun;
  summarizing = true;
  summarizeBtn.disabled = true;
  updateClear();
  try {
    const text = segments.length ? await shownText(false) : textArea.value;
    if (!text.trim()) return;
    summaryBox.classList.remove("hidden");
    setSummaryCollapsed(false);
    summaryEl.textContent = t("files_summarizing");
    summaryEl.dataset.tone = "";
    const summary = await invoke<string>("summarize_text", { text });
    if (run === summaryRun) summaryEl.textContent = summary;
  } catch (e) {
    if (run === summaryRun) {
      summaryEl.textContent = errorText(e);
      summaryEl.dataset.tone = "error";
    }
  } finally {
    if (run === summaryRun) {
      summarizing = false;
      summarizeBtn.disabled = running;
    }
    updateClear();
  }
}
```

Replace `exportAs`:

```ts
async function exportAs(kind: ExportKind) {
  setExportMenu(false);
  // Clear waits until the file is written; the save dialog counts too.
  exporting++;
  updateClear();
  try {
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
  } finally {
    exporting--;
    updateClear();
  }
}
```

Before `export function renderFiles()`:

```ts
/** Back to the empty tab: the transcript, speaker names, summary and file
 *  line go, and the page lets go of the texts. The audio file is not
 *  touched; the Language, Speakers and Timestamps choices stay. */
function clearFile() {
  if (running || summarizing || exporting > 0) return;
  summaryRun++;
  transcript = null;
  transcribedAt = null;
  fileName = "";
  segments = [];
  // A new array: a rename still open writes into the old one and is dropped.
  names = [];
  renderChips();
  setExportMenu(false);
  summaryBox.classList.add("hidden");
  setSummaryCollapsed(false);
  summaryEl.textContent = "";
  summaryEl.dataset.tone = "";
  textArea.value = "";
  textArea.readOnly = false;
  setButtons(false);
  nameEl.textContent = "";
  setStatus("");
  setProgress(0);
  job.classList.add("hidden");
  result.classList.add("hidden");
  // The Clear button went with the file line.
  chooseBtn.focus();
}
```

In `initFiles`, after `summarizeBtn.addEventListener("click", summarize);`, add `clearBtn.addEventListener("click", clearFile);`.

Run (repo root): `npx tsc --noEmit`. Expected: no errors.

- [ ] **Step 3: Live check**

Build and start the test instance. Record `Get-FileHash "<media>\meeting.mp3"`. Copy `.superpowers/tools/drop_file.js` to `$S/drop_meeting.js`; its path is already `meeting.mp3` with speakers `"2"`. Also copy it to `$S/drop_silence.js`, changing the path to `silence.wav`, the name check to `"silence.wav"` and the speakers value to `"off"`. Then write:

`clear_run.js`:
```js
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const whileRunning = $("file-clear").disabled;
for (let n = 0; n < 600 && !$("file-cancel").classList.contains("hidden"); n++) await sleep(200);
await sleep(300);
return JSON.stringify({ whileRunning, afterRun: $("file-clear").disabled, chips: $("file-speaker-chips").children.length, chars: $("file-text").value.length });
```

`clear_summary.js`:
```js
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
$("file-summarize").click();
await sleep(100);
const duringSummary = $("file-clear").disabled;
for (let n = 0; n < 900 && $("file-summarize").disabled; n++) await sleep(200);
return JSON.stringify({ duringSummary, afterSummary: $("file-clear").disabled, summary: $("file-summary").textContent.slice(0, 80) });
```

`clear_click.js`:
```js
const $ = (id) => document.getElementById(id);
// A rename left open and a Timestamps switch: both format the text in the backend.
$("file-speaker-chips").querySelector(".speaker-chip").click();
$("file-times").click();
$("file-clear").click();
await new Promise((r) => setTimeout(r, 800));
return JSON.stringify({
  jobHidden: $("file-job").classList.contains("hidden"),
  resultHidden: $("file-result").classList.contains("hidden"),
  text: $("file-text").value,
  name: $("file-name").textContent,
  chips: $("file-speaker-chips").children.length,
  speakersRowHidden: $("file-speakers-row").classList.contains("hidden"),
  summaryHidden: $("file-summary-box").classList.contains("hidden"),
  summary: $("file-summary").textContent,
  focus: document.activeElement && document.activeElement.id,
});
```

`clear_error.js`:
```js
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let n = 0; n < 100 && !$("file-cancel").classList.contains("hidden"); n++) await sleep(100);
const before = { status: $("file-status").textContent, resultHidden: $("file-result").classList.contains("hidden"), clearDisabled: $("file-clear").disabled };
$("file-clear").click();
return JSON.stringify({ before, jobHidden: $("file-job").classList.contains("hidden") });
```

Run and expect:
1. `drop_meeting.js`, then at once `clear_run.js`: `whileRunning: true`, `afterRun: false`, `chips: 2`, `chars` over 1000.
2. `clear_summary.js`: `duringSummary: true`, `afterSummary: false`.
3. `clear_click.js`: everything hidden, `text: ""`, `name: ""`, `chips: 0`, `summary: ""`, `focus: "file-choose"`.
4. `drop_silence.js`, then `clear_error.js`: `before.status: "In dieser Datei wurde keine Sprache gefunden."`, `resultHidden: true`, `clearDisabled: false`, then `jobHidden: true`.
5. `Get-FileHash` of `meeting.mp3` is unchanged.

Clear during an export is not live-checked, because it opens a native save dialog. Read `exportAs` instead: the counter goes up before `save()` and down in `finally`. Stop the test instance.

- [ ] **Step 4: Commit**

```bash
cd /e/claude/RudariFlow
git add index.html src/files.ts src/style.css src/i18n.ts
git commit -F - <<'EOF'
feat: Clear button in the Files tab

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: Docs and the final check

**Files:**
- Modify: `README.md`, `README.de.md`, `CHANGELOG.md`

(The version line at the top of the READMEs changes with the release, not here.)

- [ ] **Step 1: README.md**

In Features:
- **Persistent model:** replace `(on battery it is unloaded after 10 minutes without dictation)` with `(on battery it is unloaded after 10 minutes without dictation; the Free GPU hotkey unloads it whenever you want)`.
- After the **Rewrite last dictation** bullet, add:

```markdown
- **Free GPU:** a fourth hotkey (off by default; set it under Recording) unloads Whisper and the AI model so a game gets the graphics card's memory, about 5 GB with Large v3 Turbo q8 and Gemma 4 E4B. Press it again to load them; a dictation, a file or a summary also loads what it needs, the first dictation a few seconds later than usual
```

- **Transcribe files:** replace `and the summary can be hidden to give the transcript more room.` with `and the summary can be hidden to give the transcript more room; Clear empties the tab for the next file.`
- Replace `for all three hotkeys` with `for all four hotkeys`.
- System requirements, **RAM:** after `…and load again at the next hotkey press.`, add ` The Free GPU hotkey unloads them on demand, e.g. before a game.`

Use the amounts measured in Task 2 if they differ from "about 5 GB".

- [ ] **Step 2: README.de.md**

- **Persistentes Modell:** replace `(im Akkubetrieb nach 10 Minuten ohne Diktat entladen)` with `(im Akkubetrieb nach 10 Minuten ohne Diktat entladen; das Tastenkürzel „GPU freigeben“ entlädt es, wann du willst)`.
- After **Letztes Diktat umschreiben**, add:

```markdown
- **GPU freigeben:** ein viertes Tastenkürzel (standardmäßig aus, unter Aufnahme festlegen) entlädt Whisper und das KI-Modell, damit ein Spiel den Grafikspeicher bekommt, etwa 5 GB mit Large v3 Turbo q8 und Gemma 4 E4B. Nochmals drücken lädt sie wieder; ein Diktat, eine Datei oder eine Zusammenfassung lädt ebenfalls, was sie braucht, das erste Diktat ein paar Sekunden später als sonst
```

- **Dateien transkribieren:** replace `die Zusammenfassung lässt sich ausblenden, damit der Text mehr Platz hat.` with `die Zusammenfassung lässt sich ausblenden, damit der Text mehr Platz hat; Leeren macht den Tab frei für die nächste Datei.`
- Replace `für alle drei Hotkeys` with `für alle vier Hotkeys`.
- **RAM:** after `…und beim nächsten Hotkey wieder geladen.`, add ` Das Tastenkürzel „GPU freigeben“ entlädt sie auf Wunsch, z. B. vor einem Spiel.`

- [ ] **Step 3: CHANGELOG.md**

Above `## [0.12.0] - 2026-09-25 - …`, add (there is no Unreleased section yet):

```markdown
## [Unreleased]

### Added
- **Free GPU hotkey:** a fourth hotkey (Settings → Recording, off by
  default, a key combination or a mouse side button) unloads Whisper and
  stops the AI model, so a game gets the graphics card's memory: about
  5 GB with Large v3 Turbo q8 and Gemma 4 E4B on an RTX 5080. The pill
  says "GPU freed". Press it again to load both ("Loading models…", then
  "Models loaded"). A dictation, a file or a summary also loads what it
  needs; the first dictation after a free waits for the AI model (a few
  seconds) instead of being pasted without AI cleanup. A press during a
  dictation frees the GPU once the text is pasted.
- **Clear in the Files tab:** empties the tab for the next file: the
  transcript, the speaker names, the summary and the file line go, and
  the audio file stays where it is. Not while a file, a summary or an
  export is running.
```

- [ ] **Step 4: Final check (filtered: no clipboard tests)**

```bash
source /e/claude/RudariFlow/.superpowers/tools/env13.sh
cd /e/claude/RudariFlow/src-tauri
for f in power:: whisper_engine:: llm_server:: polish:: settings:: mouse_hotkey::; do CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib "$f" || break; done
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --bins hotkey
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo clippy --no-default-features --lib --bins 2>&1 | grep -A4 -E "^(warning|error)" | grep -E "main.rs|power.rs|whisper_engine.rs|llm_server.rs|settings.rs" || echo "no findings in the changed files"
cd .. && npx tsc --noEmit
```

Expected: every filtered run passes; clippy has no finding in the changed files (compare with `main` if one shows up, since earlier ones may exist); tsc is clean.

- [ ] **Step 5: Commit**

```bash
cd /e/claude/RudariFlow
git add README.md README.de.md CHANGELOG.md
git commit -F - <<'EOF'
docs: Free GPU hotkey and the Files Clear button

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Live checks (test instance)

These checks use the isolated instance (`.superpowers/tools/live-checks.md`). It never touches the user's data or the installed app.

- **Scratch folder `$S`:** the session's scratchpad. **Media:** `C:/Users/Shiggy/AppData/Local/Temp/claude/e--claude/03e395af-fccf-48ce-a7bd-1bad55706d6a/scratchpad/media/` (`meeting.mp3`, `long20min.m4a`, `silence.wav`). If that folder is gone, use any speech MP3, any recording over 10 minutes, and a silent WAV.
- **Build:** `source /e/claude/RudariFlow/.superpowers/tools/env13.sh && cd /e/claude/RudariFlow && CARGO_TARGET_DIR='C:\r' npm run tauri build -- --no-bundle` (foreground, 600000 ms), then restore `src-tauri/Cargo.toml` if only its line endings changed. Plain `cargo build` is not enough: the exe would load the dev server.
- **Headroom first (PowerShell):** `nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader`. The test instance takes about 5.5 GB. If less than 6.5 GB is free, do not start it; tell the controller. The user's app once vanished while a test instance held the card.
- **Start:** `powershell -ExecutionPolicy Bypass -File E:\claude\RudariFlow\.superpowers\tools\start_test.ps1`. It stops only `C:\r\` instances, sets `RUDARIFLOW_DATA_DIR=C:\t\rf-test-data`, `RUDARIFLOW_TEST_COMMANDS=1` and CDP on port 9333, and waits for "llama-server ready". Keep `autostart: true` in `C:\t\rf-test-data\config.json`.
- **Drive:** run `node E:/claude/RudariFlow/.superpowers/tools/cdp.mjs $S/<file>.js` for the main window. Add a last argument `overlay` for the pill. The file is the body of an async function that `return`s a string.
- **Video memory:** `$S/gpu_mem.ps1`. Under WDDM, nvidia-smi shows `[N/A]` per process, so the numbers come from Windows' GPU counters:

```powershell
# The test instance's processes on the GPU; never the installed app's.
$test = @(Get-Process rudariflow -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "C:\r\*" }) +
        @(Get-Process llama-server -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "E:\claude\RudariFlow\src-tauri\binaries\llama\*" })
$ids = @($test | ForEach-Object { $_.Id })
"nvidia-smi (memory is [N/A] under WDDM):"
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader | Where-Object { $ids -contains [int]($_.Split(",")[0]) }
$samples = (Get-Counter '\GPU Process Memory(*)\Dedicated Usage').CounterSamples
foreach ($p in $test) {
    $mib = ($samples | Where-Object { $_.InstanceName -like "pid_$($p.Id)_*" } | Measure-Object CookedValue -Sum).Sum / 1MB
    "{0} (pid {1}): {2:N0} MiB dedicated" -f $p.ProcessName, $p.Id, $mib
}
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
```

- **Logs:** `C:\t\rf-test-data\startup.log` (`[gpu]`, `[hotkey]`, `[ai]`, `[engine]` lines).
- **Stop, right after each check:**

```powershell
Get-Process rudariflow -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "C:\r\*" } | Stop-Process -Force
Get-Process llama-server -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "E:\claude\RudariFlow\src-tauri\binaries\llama\*" } | Stop-Process -Force
```

- **Not driven:**
  - The real hotkey. Pressing it would need system key input on the user's desktop; `free_gpu_test` runs the same `free_gpu_press`.
  - A dictation. It needs the microphone.
  - Native dialogs, the tray, focus.
  - While the test instance runs, its pill may show on the primary monitor for 3 s at a time. It takes no focus.
