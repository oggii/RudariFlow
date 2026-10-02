# RudariFlow Soundboard: sounds on hotkeys, played into a virtual microphone

**Date:** 2026-09-29
**Branch:** `feature/soundboard`, based on `feature/shared-ai-slot` (unreleased 0.13.0 + the shared AI slot)
**Release:** version number decided at release time
**Status:** design approved in discussion (three sections), spec awaiting review

## Context

The user wants a soundboard like Steam's Soundpad inside RudariFlow: load audio files, bind each to a hotkey, and have friends hear them in Discord or a game, together with the user's own voice. Soundpad injects into the default microphone with its own driver; RudariFlow instead plays into a virtual audio cable (VB-Audio Virtual Cable), which the voice app then uses as its microphone.

Decisions from the discussion:

- **Voice + sounds mixed:** RudariFlow passes the real microphone through to the cable and mixes the sounds on top (Soundpad's behaviour). The user's voice keeps passing while they dictate.
- **Where:** a new Soundboard tab in the main window that can be popped out into its own window.
- **Extras in v1:** a stop-all hotkey, volumes (per sound; "others hear" and "you hear"), categories and search.
- **Playback:** a new sound replaces the playing one by default; a switch lets sounds play over each other. Pressing a playing sound's hotkey again stops it.
- **Storage:** added files are copied into a dedicated `soundboard` folder in RudariFlow's data folder.
- **Formats:** aac, flac, m4a, mp3, ogg, opus, wav, wma.
- **Approach A:** a native audio engine in the RudariFlow process (Rust, cpal/WASAPI), not web audio in the window and not a helper process.
- DramaVox (a separate voice-changer project that also planned a soundboard) is out of scope.

## Goals

- Add sounds (file picker or drag and drop), organise them in categories, find them by typing, play them with a click or a global hotkey.
- Friends hear the user's voice plus the sounds through one virtual microphone; the user hears the sounds on their headphones at their own volume.
- Sounds start instantly, including long songs, with the window closed and in games.
- The tab can be popped out into a window that can stay on top.

## Non-goals (v1)

- Recorder and editor, text-to-speech, auto push-to-talk keys, loudness normalisation, sound lists/pages/hotbar, play count, remote control, `soundpad://` import.
- Injecting into the microphone without a virtual cable (would need a driver).
- Voice effects (DramaVox is out of scope).
- Installing the virtual cable for the user (a driver install is the user's action; the tab links to it).

## Architecture

### Module map

| Unit | Responsibility |
|---|---|
| `src-tauri/src/soundboard/library.rs` | `soundboard.json` (sounds, categories, board settings): load, save (atomic write), add/rename/delete/categorise, defaults and migration |
| `src-tauri/src/soundboard/prepare.rs` | Copy an added file into `sounds/`, decode it to 48 kHz stereo and write the playback copy to `cache/<id>.wav` (16-bit PCM); duration; limits |
| `src-tauri/src/media.rs` | New `decode_48k_stereo(path)` next to `decode_16k_mono` (Media Foundation for aac/flac/m4a/mp3/wav/wma/Ogg Vorbis, libopus for Ogg Opus) |
| `src-tauri/src/soundboard/mixer.rs` | Pure playback logic: voices, replace/layer, toggle-stop, stop-all, per-sound and bus volumes, 15 ms fades; no devices |
| `src-tauri/src/soundboard/drift.rs` | Pure mic→cable buffer that keeps the delay bounded when the two clocks drift |
| `src-tauri/src/soundboard/engine.rs` | cpal streams (mic in, cable out, headphones out), per-voice reader threads, rate conversion, device lookup, start/stop, device-lost handling |
| `src-tauri/src/soundboard/mod.rs` | `Soundboard` state in `AppState`, Tauri commands, events, hotkey registration while on |
| `src-tauri/src/mouse_hotkey.rs` | More binding slots (8 → 64) |
| `src-tauri/src/main.rs` | Commands registered; hotkey actions for sounds and stop-all; conflict check across all hotkeys; the pop-out window; window-state and capabilities for it |
| `src/soundboard/*.ts` | The board UI as a component that renders into a container: used by the tab and by the pop-out page |
| `index.html`, `soundboard.html` (new Vite entry), `src/style.css`, `src/i18n.ts` | Tab markup, pop-out page, styles, EN/DE strings |

### Audio engine

- **Switch.** "Virtual microphone" on/off. Off: no stream is open, no microphone is captured, sound hotkeys are released. The state is remembered across restarts; on at start opens the engine (Windows then shows the microphone-in-use icon).
- **Streams (on):**
  - **Mic in:** the chosen microphone (default: the Recording setting's microphone), WASAPI shared mode through cpal.
  - **Cable out ("what others hear"):** the chosen output (default: an output whose name contains "VB-Audio Virtual Cable" or "CABLE Input", preferring one without "16 Ch" — the current VB-Cable driver names its endpoints "Speakers (VB-Audio Virtual Cable)" and "CABLE In 16 Ch (VB-Audio Virtual Cable)"; both feed "CABLE Output"). Carries `mic + Σ sounds × sound volume × others volume`.
  - **Headphones out ("what you hear"):** the chosen output (default: Windows' default output). Carries `Σ sounds × sound volume × me volume` — never the user's own voice (no echo).
  - Either volume at 0 gives "only me" / "only them".
- **Mic → cable.** The mic callback converts to stereo and writes into the drift buffer, which converts to the cable's rate; the cable callback reads from it. The lowest fill after a read (over 250 ms) is kept at 15 ms by converting a little faster or slower (a PI controller, at most 0.4 %, no periodic pattern); an excess of more than 20 ms (a stalled device) is skipped in one step with a 5 ms crossfade; on underrun silence is inserted until the fill is one read above the target. Expected extra delay of the voice: 15–25 ms.
- **Sounds.** Each playing sound (a *voice*) has a reader thread that streams its prepared WAV into a ring buffer about one second ahead (the first chunk is read before the voice starts, so it starts at once and nothing reads files in an audio callback). Each output keeps its own position in the voice, so the cable and the headphones can run on different clocks and rates; a voice ends when both outputs reached its end or it is stopped. Rate conversion (48 kHz → device rate) is linear and happens per output.
- **Playback rules.**
  - Play a sound while nothing plays: it starts.
  - Play a sound while another plays: replace mode fades the others out (15 ms) and starts the new one; layer mode adds it.
  - Play (hotkey or button) a sound that is playing: it fades out and stops.
  - Stop all (hotkey or button): every voice fades out.
  - Per-sound volume 0–100 %; "Others hear" and "You hear" 0–100 %.
- **With dictation.** Dictation captures the same microphone at the same time (shared mode allows it). The user's voice keeps going to the cable while dictating. "Mute other apps while recording" does not touch the soundboard (it is part of RudariFlow's own audio session, which is excluded).
- **Free GPU hotkey.** Unaffected: the soundboard uses no GPU.

### Library and storage

Folder: `<app data>\soundboard\` (`%APPDATA%\com.rudariflow.app\soundboard\`, or under `RUDARIFLOW_DATA_DIR`):

- `sounds\<id>.<ext>` — the copied original.
- `cache\<id>.wav` — the prepared 48 kHz stereo 16-bit copy that playback reads. Rebuilt from the original if missing.
- `soundboard.json`:

```json
{
  "version": 1,
  "enabled": false,
  "othersVolume": 1.0,
  "meVolume": 0.7,
  "layer": false,
  "devices": { "microphone": "", "cable": "", "headphones": "" },
  "stopHotkey": "",
  "window": { "poppedOut": false, "alwaysOnTop": false },
  "categories": [{ "id": "c-…", "name": "Memes" }],
  "sounds": [{
    "id": "s-…", "name": "airhorn", "file": "sounds/s-….mp3", "category": "c-…",
    "hotkey": "Num1", "volume": 1.0, "durationMs": 2310
  }]
}
```

- A device name `""` means automatic (see Streams). A saved device that is missing shows as "not connected" and the switch cannot turn on until it is back or another is chosen (the automatic cable is looked up again).
- A sound's name defaults to the file name without its extension; renaming never changes the files. The same file can be added twice.
- Deleting a sound deletes both of its files. Deleting a category moves its sounds to "No category".
- Limits: 30 minutes per sound; a file that cannot be decoded, is longer, or has no audio is refused with its name and the reason. Adding several files reports each failure and adds the rest.
- A missing or damaged `soundboard.json` starts an empty board; a damaged file is kept as `soundboard.json.bad`.

### Hotkeys

- Each sound has at most one hotkey: a key, a key combination, or a mouse side button with or without modifiers — the same capture UI and rules as the existing four hotkeys (Windows' own shortcuts are refused).
- A **Stop all** hotkey, off by default.
- Conflict check across everything: dictation, paste last, rewrite last, Free GPU, stop all and every sound. A taken key is refused with "Already used by <name>".
- Sound and stop-all hotkeys are registered only while the Virtual microphone is on, and unregistered when it turns off, so they never take keys away from games or other apps while the board is not in use. The four app hotkeys are unchanged.
- The mouse hook gets 64 binding slots (was 8).
- A keyboard hotkey that another program already owns is shown as "Taken by another program" on that sound; the board still turns on.

### UI

- **Soundboard tab** (sidebar, after Files):
  - Top: the Virtual microphone switch and a status line ("On: your mic + sounds → Speakers (VB-Audio Virtual Cable)", i.e. the chosen cable output, or why it is off/failed), the sliders "Others hear" and "You hear", the switch "Play sounds over each other", the Stop all hotkey, and a collapsible **Devices** area (Microphone, Virtual cable, Headphones; each "Automatic (…)" plus the list).
  - Toolbar: **Add sounds…** (multi-select file picker filtered to the 8 formats) and drag and drop onto the tab; a **search** box that filters by name as you type; **category chips** (All, each category, "+ New"; a category chip can be renamed or deleted); **Stop all**; **Pop out**.
  - List, one row per sound: play/stop button (disabled while the Virtual microphone is off, with the hint "Turn on the virtual microphone to play"), name (click to rename), category (select), hotkey (click to capture; ✕ clears), volume slider, length, delete. The playing sound is highlighted with its progress.
  - Empty state: how to add sounds; when no virtual cable is found, a short explanation with a link to <https://vb-audio.com/Cable/> and the Discord hint below.
- **Pop out:** opens the board in its own resizable window (label `soundboard`, page `soundboard.html`) with an "Always on top" toggle. The tab shows "Open in its own window" with **Bring back**. Closing the window docks it back. Its size and position are remembered (window-state plugin filter extended from `main` to `main` and `soundboard`); the window is added to the capabilities.
- **Sync:** library, playback and settings live in the backend; both views render from `soundboard_state` and listen to `soundboard-changed` (library/settings), `soundboard-playing` (voices with position, about 10 per second while something plays) and `soundboard-status` (off / on / error with a reason).
- **Discord hint** (shown once in the tab): choose "CABLE Output" as the input device in Discord, and turn off Discord's noise suppression and echo cancellation for it, since they can cut sound effects and music.
- Every string in English and German; every control usable with the keyboard; same look as the other tabs.

### Commands and events (backend)

`soundboard_state`, `soundboard_set_enabled`, `soundboard_devices` (inputs/outputs with the automatic picks), `soundboard_set_devices`, `soundboard_set_volumes`, `soundboard_set_layer`, `soundboard_add(paths)` (per-file results), `soundboard_remove(id)`, `soundboard_rename(id, name)`, `soundboard_set_category(id, category)`, `soundboard_set_sound_volume(id, volume)`, `soundboard_set_hotkey(id, hotkey)`, `soundboard_set_stop_hotkey`, `soundboard_play(id)` (toggle), `soundboard_stop_all`, `soundboard_category_add/rename/remove`, `soundboard_pop_out`, `soundboard_dock`, `soundboard_set_always_on_top`. Test-only (with `RUDARIFLOW_TEST_COMMANDS=1`): `soundboard_capture_test(device, ms, loopback)` (records from an input such as CABLE Output, or loops back an output, and returns RMS/peak), `soundboard_engine_stats` (drift-buffer fill, drops/inserts, device rates). Events as listed under Sync.

## Error handling

- No virtual cable: the switch explains it (link, hint); the rest of the tab works (adding, naming, categories, hotkeys). Playing needs the engine, and the engine needs all three devices.
- A device disappears while on (USB mic unplugged, cable removed): the engine stops, the switch goes off, the status says which device and why; hotkeys are released.
- A stream fails to open (device busy in exclusive mode, unsupported format): off with the reason.
- Add failures: per file, with the name and reason; the rest are added.
- Disk full while preparing: the half-written files are removed; the sound is not added.
- A sound whose files are missing (deleted by hand): shown as missing; play reports it; the original is re-prepared if only the cache is missing.

## Privacy

Everything stays on the PC. The microphone is captured only while the Virtual microphone is on (Windows shows its usual indicator).

## Tests

- **Unit (pure):** mixer (replace, layer, toggle-stop, stop-all, fades, per-sound and bus volumes, voice end with two outputs); drift buffer (delay stays within bounds under ±0.1 % clock skew over minutes; underrun inserts silence); rate conversion; `soundboard.json` round-trip, defaults, damaged file, category delete; hotkey conflict check including sounds and stop-all; `decode_48k_stereo` on one small fixture per format (aac, flac, m4a, mp3, ogg Vorbis, opus, wav, wma — 1 s tones generated once with ffmpeg and committed); prepare limits (too long, no audio, corrupt).
- **Live (isolated test instance, needs VB-Audio Virtual Cable installed):** switch on → a played sound arrives on CABLE Output (`soundboard_capture_test` RMS above threshold) and on the headphones output (the same test command in WASAPI loopback mode on that output); mic passthrough carries the voice (the mic path's stats show frames flowing, drift fill within bounds over a few minutes); replace vs layer; toggle-stop; stop-all; add all 8 formats; rename/category/search/delete; hotkeys registered only while on (log); pop-out, always-on-top, bring back, size remembered; device-lost path by switching the cable device away. Same rules as earlier features: never touch the user's installed app, no tray clicks, no SendKeys, no focus stealing, stop the test instance after each check.
- **With the user:** a real Discord call at the end.

## Risks

- WASAPI shared-mode latency on some USB microphones may exceed 30 ms; the drift buffer keeps it from growing, and the stats show it.
- Discord's noise suppression can cut sound effects (documented in the hint).
- Apps that open the cable in exclusive mode would block it (rare for voice apps).
- Many global keyboard hotkeys (e.g. the numpad) are taken from all apps while the board is on — by design, and released when it is off.
