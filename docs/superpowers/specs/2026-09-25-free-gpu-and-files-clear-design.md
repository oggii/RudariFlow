# RudariFlow: a Free GPU hotkey and a Clear button for the Files tab

**Date:** 2026-09-25
**Target release:** 0.13.0
**Branch:** `feature/free-gpu-and-files-clear`, based on `main` after 0.12.0
**Status:** the user's decisions are fixed; spec awaiting review

## Context

Whisper (in `rudariflow.exe`) and the AI model (the bundled llama-server) stay loaded so dictations start fast. With Large v3 Turbo q8 and Gemma 4 E4B on CUDA, that is about 5.2 GB of video memory: 1.4 GB plus 3.8 GB, per Windows' GPU memory counters on the RTX 5080. llama-server also holds about 3.3 GB of RAM. A game wants that memory. The Files tab has no way back to its empty state.

The user's decisions:

1. **Free GPU hotkey, a toggle.** A press frees the GPU: it unloads Whisper, stops llama-server, and the pill says "GPU freed". The next press loads both back ("Models loaded"). Anything that needs a model while the GPU is freed loads it: a dictation, a file, a summary. The first dictation may take a few seconds longer. There is no game detection. The hotkey takes a chord or a mouse side button.
2. **Clear in the Files tab.** It empties the tab: transcript, speaker chips, summary and file line go, and the page frees the texts. No confirmation. The audio file is not touched. Clear is disabled while a transcription, a summary or an export runs.
3. Every new string exists in English and German.

## What the code does today (checked)

- **Battery unload.** `watch_idle_on_battery` checks every 60 s. When the PC is on battery, idle for 10 min and no dictation runs, it calls `WhisperEngine::invalidate()` and `LlmServer::stop()`.
  - `invalidate` drops the model under the engine lock, so it waits for a running transcription.
  - `stop` bumps the generation: a start in progress then ends as "stopped", not as a failure. It also kills the process, waits for it to exit, resets the failure count and reports `Stopped`.
- **Reload on demand.** A dictation press starts both loads (`on_hotkey`).
  - The transcription waits for Whisper.
  - The AI step waits only **3 s** for a server that is still loading (`polish::WAIT_FOR_MODEL`; Edit mode waits 10 s, summaries 120 s). After that, the text is pasted **without AI cleanup**, and without the "Write in" translation.
  - llama-server needs 4 to 7 s here from a warm disk (startup.log). Its first start after the model download took 34 s. So after an unload, a dictation shorter than about 2 to 4 s loses its AI cleanup.
  - A Files transcription loads Whisper; a summary starts the AI.
- **Background loads.** The battery unload does not stop any of these: app start (Whisper first, because llama-server's `--fit` measures free video memory once), a settings change, the end of a model download, Retry in the AI tab, the PC check.
- **A running file keeps Whisper alive.** Its `FileRun` owns a `WhisperState`, which holds an `Arc` of the context (whisper-rs 0.16). So `invalidate` frees Whisper's memory only once the file is done.
- **Pill notices.** `Recorder::notice` shows the pill for 3.2 s. `src/overlay.html` takes the text from its own EN/DE map: it is a separate webview without `src/i18n.ts`, and it follows the Windows display language.
- **Hotkeys.**
  - One setting per `HotkeyAction { Dictation, PasteLast, RewriteLast }`.
  - `change_hotkey` refuses a chord another action has.
  - Chords go through tauri-plugin-global-shortcut. It registers them with `MOD_NOREPEAT`, so holding a key does not repeat the action.
  - Side buttons go through `mouse_hotkey`: 8 slots, 40 ms debounce.
  - Defaults: paste last is Alt+Shift+V (since 0.6); rewrite last (0.10) is off.
- **nvidia-smi** under WDDM lists the processes but shows their memory as `[N/A]`. The per-process numbers come from the counter `\GPU Process Memory(*)\Dedicated Usage`.

## Goals

- One hotkey frees the GPU; the next press brings both models back. Each shows a notice in the pill.
- After a free, nothing reloads in the background. Only a use reloads, and the first dictation keeps its AI cleanup.
- Clear empties the Files tab in one click and never loses a result that is still in progress.

## Non-goals

- Game detection; a free button in the tray or the settings.
- Remembering a free across restarts. The models load at start as always.
- A "freed mode". Once something reloads a model, it stays loaded, as today.
- Changing the battery unload.
- Undo for Clear; resetting the Language, Speakers or Timestamps choices; deleting the audio file.

## Free GPU

**Release.** Both engines get `release()`: an unload that is remembered until a load succeeds.

- `WhisperEngine::release()` drops the model and sets `released`, both under the engine lock. A successful `ensure_loaded` clears the flag.
- `LlmServer::release()` calls `stop()` and sets `released`. It sets the flag before the `Stopped` event and again after it. A successful `ensure_running` clears it.
- While the AI is released:
  - Background starts (`warm_ai`: app start, settings, download) leave it off.
  - Requests start it as before, and `wait_ready` waits at least `RELEASED_WAIT` = 20 s for it. So the first dictation after a free waits a few seconds for its AI cleanup instead of losing it.
  - Retry in the AI tab starts it anyway.
  - `ai_status` reports `gpuFreed`.
- While Whisper is released, a changed model or backend loads at the next use, not in the background.
- The battery unload is **not** a release. A press after a battery unload therefore frees the GPU (little is left to free), not "Models loaded".

**Toggle.** `AppState.gpu` holds `freed` (the last press freed), a `press` counter, and a tokio mutex so presses run in order. `power::gpu_toggle(freed, whisper_released, ai_released)` loads only when the last press freed the GPU and both engines are still released. In every other case it frees:

| At the press | Does | Pill |
|---|---|---|
| Models loaded or loading, including reloaded by a use after a free | Free | "GPU freed" |
| Unloaded by the battery watcher | Free (now released) | "GPU freed" |
| The last press freed and nothing loaded since | Load | "Loading models…", then "Models loaded" or "Models could not be loaded" |
| The last press loaded, but there was nothing to load (Groq, AI off) | Free | "GPU freed" |

- **Free:**
  1. Wait until a dictation that is recording or being transcribed is pasted.
  2. Set `freed`.
  3. On a blocking thread, release the AI (waits for the process to exit), then Whisper (waits for a running file block).
  4. Log `[gpu] freed` and show the notice.
- **Load:**
  1. Clear `freed`.
  2. Reset the battery idle timer.
  3. Show "Loading models…" at once. The reload takes 2 to 7 s, and without feedback a second press would free again.
  4. Load Whisper first (`load_whisper` now reports failure), then start the AI (`ensure_running`) outside the mutex, so a new press can free at once and its release stops the start.
  5. When both are done and no newer press came, show "Models loaded", or "Models could not be loaded".
- Notices show only while no dictation runs, because the pill shows the recording then.
- A test command, `free_gpu_test` (only with `RUDARIFLOW_TEST_COMMANDS=1`), runs the same `free_gpu_press` and returns `Freed`, `Loaded`, `LoadFailed` or `Overtaken`.

**Edge cases:**

| Situation | Behaviour |
|---|---|
| Pressed during a dictation (recording, transcribing, polishing) | The free happens after the text is pasted. |
| Pressed during a file transcription | The AI stops at once. Whisper leaves the engine at once, but the file keeps its own reference to the model and finishes; its memory is freed then. A dictation during that file loads a second copy until the file ends. |
| Pressed during a summary | The AI stops. `summarize_text` returns `gpu_freed`, and the summary box says "The summary stopped because the GPU was freed. Summarise again to start over." |
| Pressed during a History re-run, the AI tab's "Try it" or the PC check | Not waited for. That request falls back to plain text or reloads the models. |
| Pressed twice quickly | The presses run in order: free, then load, with both notices. Key repeat and button bounce are already filtered out. |
| Pressed while the models come back | Whisper finishes loading and is then unloaded, the AI start is stopped, "GPU freed". The load shows no notice (`Overtaken`). |
| Freed, then a dictation | Both load at the press. Whisper is waited for, the AI up to 20 s. Only past that (a very cold disk) is the text pasted without AI cleanup. |
| Freed, then a file | Whisper loads ("Loading Whisper…"). The AI stays off until a summary or a dictation. The next press frees Whisper again. |
| Freed, then settings change or a download ends | Saved; the new model loads at the next use. |
| On battery | The battery watcher finds nothing loaded and does nothing. A Load press counts as activity. |
| llama-server crashed earlier | `release()` resets the failure count, so Free + Load is also a manual restart. |
| The AI fails during a Load, or on demand after a free (a game holds the memory) | The pill shows "Models could not be loaded" (Load only). The AI tab shows "Not running … Retry", and Retry works. A dictation falls back to plain text as with any failed start. The release lasts until a start succeeds. |
| Groq engine or AI cleanup off | Only what the settings use is loaded. With neither, the presses only show notices. |

## Files tab: Clear

- **Where:** a ghost button "Clear" at the right end of the file line, next to Cancel. It sits away from Copy / Export / Summarise, because it deletes without confirmation. There it also covers a failed file, where the result row is hidden. Its tooltip says the audio file stays.
- **When:**
  - Visible whenever a file is shown.
  - Disabled while a file is transcribed (Cancel beside it), while a summary runs, and while an export runs, from the save dialog until the file is written. A new `exporting` counter tracks exports.
  - `.btn-ghost:disabled` gets `opacity: 0.45`, since disabled ghost buttons look enabled today.
- **Does:**
  - Resets `transcript`, `segments`, `names` (to a new array), `transcribedAt`, `fileName`, the text box (and its read-only flag), the summary (text, tone, collapsed, hidden), the chips, the export menu, the file line and the result area.
  - Bumps `summaryRun`.
  - Moves focus to "Choose file…".
  - Keeps the Language, Speakers and Timestamps choices, as a new file does.
  - The backend keeps no transcript, so the text is gone from memory once the page drops it.
- **Edge cases:**
  - A rename left open writes into the old `names` array, which is already ignored.
  - `showText` writes only if `segments` is still the same array, so a format call still in flight (a rename, Timestamps) cannot refill the cleared box.

## Settings & migration

- `freeGpuHotkey` (Rust `free_gpu_hotkey`), serde default `""` (off). 0.12 configs load unchanged, and older versions ignore the field.
- **Off by default, like rewrite last** (the newest optional hotkey), unlike paste last (a harmless re-paste, 0.6). Three reasons:
  - A global chord is taken from every app, including games.
  - An accidental press makes the next dictation wait.
  - No chord is free in every game.
- `change_hotkey` accepts `"freeGpu"`. `hotkeys()` returns four entries, so `set_hotkey_paused` and the "already used" check cover the new hotkey. `mouse_hotkey`'s 8 slots still suffice.

## UI and strings

Recording tab: a row after "Rewrite last dictation", with a hotkey button and a ✕ to turn it off.

| Key (`src/i18n.ts`) | English | German |
|---|---|---|
| `free_gpu_label` | Free GPU | GPU freigeben |
| `free_gpu_hint` | Unloads Whisper and the AI model to free your graphics card, e.g. for a game. Press again to load them; a dictation also loads them, the first one takes a few seconds longer. | Entlädt Whisper und das KI-Modell, damit die Grafikkarte frei wird, z. B. für ein Spiel. Nochmals drücken lädt sie wieder; auch ein Diktat lädt sie, das erste dauert ein paar Sekunden länger. |
| `ai_status_freed` | Unloaded to free the GPU. Loads again at the next dictation. | Entladen, um die GPU freizugeben. Lädt beim nächsten Diktat wieder. |
| `files_err_gpu_freed` | The summary stopped because the GPU was freed. Summarise again to start over. | Die Zusammenfassung wurde abgebrochen, weil die GPU freigegeben wurde. Fasse erneut zusammen, um neu zu beginnen. |
| `files_clear` | Clear | Leeren |
| `files_clear_title` | Removes the transcript to start over. The audio file stays where it is. | Entfernt das Transkript, um neu anzufangen. Die Audiodatei bleibt, wo sie ist. |

Pill (`NOTICE_TEXT` in `src/overlay.html`, event `gpu-notice`, shown for 3 s):

| Payload | English | German |
|---|---|---|
| `freed` | GPU freed | GPU freigegeben |
| `loading` | Loading models… | Modelle werden geladen… |
| `loaded` | Models loaded | Modelle geladen |
| `failed` | Models could not be loaded | Modelle konnten nicht geladen werden |

## Tests

- **Unit** (CPU build, filtered runs):
  - The `gpu_toggle` table.
  - The release lifetimes: they survive `invalidate`, `stop` and failed loads, and a failed start ends the 20 s wait early (`wait_budget`).
  - `freeGpuHotkey` default and migration.
  - The `"freeGpu"` target, four hotkeys, and the "already used" check.
- **Frontend:** `npx tsc --noEmit`.
- **Live** (test instance, over CDP through `free_gpu_test`; VRAM from the Windows counters, processes from nvidia-smi):
  - Free, Load, a double press, `Overtaken`.
  - The AI is waited for after a free.
  - A file after a free.
  - A summary cut off.
  - The Settings row and the AI tab status.
  - Every Clear state.
- **Read in code, not driven:**
  - The real hotkey: it needs system key input.
  - A free during a dictation: it needs the microphone.
  - Clear during an export: it opens a native dialog.
  - Battery: this PC is a desktop.

## Risks

- **Memory left over:** the CUDA/Vulkan context of `rudariflow.exe` stays until exit. The live check measures it.
- **A longer first dictation:** a very short first dictation after a free now waits up to 20 s for the AI (2 to 5 s typically) instead of returning after 3 s without it. After a game, the 5 GB model may have left the file cache. The first start after the download took 34 s, so 20 s is not always enough.
- **Parallel loads:** a reload at a dictation press starts Whisper and the AI together, as after the battery unload. llama-server's `--fit` may measure memory before Whisper has taken its share, which is tight on 8 GB cards. The Load press loads Whisper first.
- **Reloading while a game runs:** Whisper on `auto` falls back from CUDA to Vulkan to CPU when memory is short; the AI fits fewer layers. Dictation gets slower but keeps working.
- **The pill over a fullscreen game:** it appears like the recording pill (topmost, no focus), with the same effect on exclusive-fullscreen games.
- **Races of a few milliseconds:** a press between a file's model load and its first block fails that file, and a press during a History re-run fails that re-run. Starting again works.

## Open questions

1. **The AI wait after a free:** 20 s (this spec), so the first dictation keeps its AI cleanup and "Write in" translation. The alternative is today's 3 s: a dictation that ends before llama-server is up (4 to 7 s after the press here) is pasted without AI cleanup. The user's "a few seconds longer" suggests 20 s.
2. **Two extra pill texts:** "Loading models…" gives feedback at the press, and "Models could not be loaded" covers a failed load. The user named only "GPU freed" and "Models loaded".
3. **Where the pill strings live:** in `src/overlay.html`'s own EN/DE map, like every pill notice, not in `src/i18n.ts` as decision 3 says. The overlay is a separate webview and follows the Windows language.
4. **Summaries:** a free stops a running summary (one click restarts it) rather than waiting minutes for it. Dictations are waited for; files finish on their own copy of the model.
