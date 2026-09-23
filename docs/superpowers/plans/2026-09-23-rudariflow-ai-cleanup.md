# RudariFlow AI Cleanup Implementation Plan

**Goal:** After Whisper, a bundled local language model (llama.cpp `llama-server`, Vulkan) polishes the dictation and applies per-app rules. Any failure pastes the non-AI text.

**Spec:** [`docs/superpowers/specs/2026-09-23-rudariflow-ai-cleanup-design.md`](../specs/2026-09-23-rudariflow-ai-cleanup-design.md)

**Branch:** `feature/ai-cleanup` (based on `feature/quick-wins`). One commit per task.

**Build environment:** `vcvars64.bat`, `CMAKE_GENERATOR=Ninja`, `CARGO_TARGET_DIR=C:\t\rf`, `CUDAARCHS=75;80;86;89;120`. Tests: `cargo test --release --lib`. The app binary loads the UI from Vite (`npx vite --port 1420`) unless built with `tauri build`.

**Test instance:** `RUDARIFLOW_DATA_DIR=C:\t\rf-test-data`, `WEBVIEW2_USER_DATA_FOLDER=C:\t\rf-test-webview`, `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`, test hotkey `Ctrl+Shift+F9` (never Mouse5, which the installed app uses). UI checks go through the CDP harness in the session scratchpad.

**Pinned llama.cpp:** release `b11100`, `llama-b11100-bin-win-vulkan-x64.zip`, SHA-256 `2b1af3fb7a5da5b499871782f590b20caa92c3acf917baaab2da99eae9df4e88`. The zip has no llama.cpp licence; fetch `LICENSE` from the `b11100` tag.

---

## Task 1: Pure cleanup logic

**Files:** create `src-tauri/src/ai_cleanup.rs`; modify `src-tauri/src/replacements.rs`, `src-tauri/src/lib.rs`.

- [x] `AppContext { exe, title }` and `AppRule { app, instructions, off }` (serde, camelCase fields).
- [x] `rule_matches(rule, ctx)`: trimmed, lower-cased, `.exe` stripped; equals exe, or exe starts with it plus `.`, or whole word in the title. `matching_rules(rules, ctx)`; `ai_disabled_for(rules, ctx)` when any match has `off`.
- [x] `build_messages(style, global, rules, ctx, text) -> (system, user)`: static rules first in `system` (cacheable prefix), then style and global instructions; `user` carries target app, app rules and the dictation in `<dictation>` tags.
- [x] `sampling(style, input) -> (temperature, max_tokens)`: 0.2 / 0; 2 x token estimate + 64, capped at 1024 (token estimate = chars / 3.5).
- [x] `request_timeout(words, on_cpu)`: GPU 2 s + 25 ms/word, max 8 s; CPU 5 s + 150 ms/word, max 20 s.
- [x] `guard(input, output, placeholders) -> Result<String, &'static str>`: strip `<think>` blocks and outer quotes the input did not have; reject empty, too long (> 2.5 x + 80 chars), too short (> 20 words in, < 30% out), missing or repeated placeholder.
- [x] `replacements::protect(text, list) -> Protected { text, values }` (placeholders `⟦1⟧`, `⟦2⟧` in one pass, longest trigger first) and `restore(text, values)`; a text that is only a trigger returns `Protected::Whole(replacement)`.
- [x] Unit tests for every function above. `cargo test --release --lib` green.

## Task 2: llama-server manager and model benchmark

**Files:** create `src-tauri/src/llm_server.rs`, `src-tauri/src/ai_models.rs`, `src-tauri/examples/ai_bench.rs`; modify `Cargo.toml` (windows features `Win32_System_JobObjects`, `Win32_System_Threading`; `getrandom`), `lib.rs`.

- [x] `ai_models.rs`: curated list `{ id, label, repo, file, bytes }` (the four spec candidates for now), `model_path(app_dir, id)`, `download_url(model)`.
- [x] `llm_server.rs`: `parse_devices(list_devices_output)`, `pick_device(devices, whisper_gpu_name)` (name match, else most memory, else `none`); `LlmServer` with `ensure_running(llama_dir, model, device) -> Endpoint` (free port via `TcpListener` on port 0, random API key, `CREATE_NO_WINDOW`, stdout/stderr to `llm-server.log`, Job Object with kill-on-close, poll `/health`), `endpoint_if_ready(wait)`, `stop()`, crash detection via `try_wait`; status (`Stopped`, `Loading`, `Ready { device }`, `Failed(msg)`) with a change callback.
- [x] `ai_cleanup::cleanup(endpoint, messages, sampling, timeout)`: POST `/v1/chat/completions` with the API key, `chat_template_kwargs.enable_thinking = false`, non-streaming; returns content.
- [x] Unit tests: device parsing and picking, port helper.
- [x] `examples/ai_bench.rs`: for each candidate GGUF, start the server, warm up, run the 10 spec samples (5 EN, 5 DE: fillers, self-correction, list, question to "the AI", instruction to "summarise", placeholder, WhatsApp rule, Outlook rule, long ramble) 3 times; print outputs, guard verdicts, median and worst latency.
- [x] Download the candidates to `C:\t\rf-test-data\llm\`, run the benchmark on the RX 6800, pick the default (best quality with median <= 1.5 s for the 30-word samples; 12B only as a second choice if median < 3 s). Record the results in the spec's "Benchmark result" section and trim `ai_models.rs` to the models that passed. If placeholders do not survive, change the placeholder format and rerun.

## Task 3: Settings

**Files:** modify `src-tauri/src/settings.rs`.

- [x] Fields `aiCleanup` (false), `aiModel` (benchmark winner), `aiStyle` (`polished`), `aiInstructions` (""), `aiRules` ([]); invalid `aiStyle` / unknown `aiModel` fall back to defaults.
- [x] Tests: defaults for an old config, round trip, invalid values.

## Task 4: Foreground app

**Files:** create `src-tauri/src/foreground_app.rs`; modify `Cargo.toml` (windows-sys `Win32_Graphics_Dwm`), `lib.rs`.

- [x] `current() -> AppContext`: `GetForegroundWindow`, title via `GetWindowTextW`, exe via `QueryFullProcessImageNameW` (file stem, lower-case); `ApplicationFrameHost` resolved through `EnumChildWindows` to the child with another pid.
- [x] `open_apps() -> Vec<String>`: `EnumWindows`, visible, titled, unowned, not tool windows, not cloaked; unique exe names except `rudariflow` and `applicationframehost`.
- [x] Unit test for the exe-name normaliser; manual check prints the current app from an example.

## Task 5: Pipeline, history, overlay

**Files:** modify `src-tauri/src/recorder.rs`, `src-tauri/src/history.rs`, `src-tauri/src/downloader.rs`, `src/overlay.html`.

- [x] `stop_and_transcribe` captures `foreground_app::current()` first.
- [x] After "send it": if AI is on, the model file exists and no "off" rule matches: `protect`; `Whole` skips the model; else overlay `polishing`, `endpoint_if_ready(3 s)`, `cleanup` with `request_timeout`, `guard`, `restore`. Any error: log `[ai] fallback: <reason>` and use `apply_replacements`. Otherwise `apply_replacements` as today.
- [x] One shared function `polish(settings, ctx, text) -> Polished { text, raw, fallback }` used by the recorder, `history_rerun` and `ai_test`.
- [x] History entries gain optional `app` and `raw` (serde default, skip if none); re-run uses the entry's app.
- [x] Downloader: write to `<file>.part`, rename when complete, event name as parameter (`download-progress` for Whisper, `ai-download-progress` for the language model).
- [x] Overlay: `polishing` state (shimmer plus "Polishing…" / "Wird überarbeitet…").
- [x] Tests: history round trip with and without the new fields; `.part` rename.

## Task 6: App wiring

**Files:** modify `src-tauri/src/main.rs`.

- [x] `AppState` holds `Arc<LlmServer>`; llama dir = `resource_dir()/llama`, overridable with `RUDARIFLOW_LLAMA_DIR` for dev builds.
- [x] Start at app start when `aiCleanup` is on and the model exists; `save_settings` starts, stops or restarts on `aiCleanup` / `aiModel` changes; warmup on hotkey press; stop on `RunEvent::Exit`.
- [x] Commands: `ai_status`, `ai_download_model(id)`, `ai_test(text, app)`, `list_open_apps`; status changes emitted as `ai-status`.

## Task 7: Bundling

**Files:** create `scripts/setup-llama.ps1`; modify `src-tauri/tauri.conf.json`, `README.md`, `README.de.md`.

- [x] Script downloads the pinned zip, checks the SHA-256, copies `llama-server.exe`, `llama-server-impl.dll`, `llama-common.dll`, `llama.dll`, `mtmd.dll`, `ggml.dll`, `ggml-base.dll`, `ggml-vulkan.dll`, `ggml-cpu-*.dll`, `libomp.dll`, `LICENSE-LLVM-OpenMP` and llama.cpp's `LICENSE` to `src-tauri/binaries/llama/`.
- [x] `tauri.conf.json` resources: `binaries/llama/*` to `llama/`.
- [x] README development steps mention the script.

## Task 8: AI cleanup tab

**Files:** create `src/ai-settings.ts`; modify `index.html`, `src/main.ts`, `src/i18n.ts`, `src/style.css`.

- [x] Tab after Replacements: switch, model select with sizes and download progress, status line, style, instructions for all apps, rules (app field with open-app suggestions, instructions, "No AI here", remove, add), test box (text, app, Try, result, time or fallback reason).
- [x] History: app in the meta line, "Original" toggle when `raw` exists.
- [x] EN and DE strings; fixed 900 x 600 window, so check that everything fits or scrolls.

## Task 9: End-to-end verification

- [x] Test instance with the real model: status reaches "Ready on AMD Radeon RX 6800"; test box results for EN and DE; rules for `whatsapp` and `outlook`; "No AI here".
- [x] Re-run of TTS recordings through the full pipeline; latency within the goal.
- [x] Fallbacks: kill `llama-server` during a request; model missing; timeout forced low.
- [x] `llama-server` disappears when RudariFlow is killed (Job Object).
- [x] Screenshots of the tab, EN and DE; overlay `polishing` state.
- [x] Full test suite green.

## Task 10: Docs

- [x] README (EN/DE) feature bullets and the NVIDIA / Intel note (same Vulkan path, untested here); CHANGELOG `[Unreleased]`.
