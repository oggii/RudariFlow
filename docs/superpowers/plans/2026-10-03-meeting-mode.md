# Meeting Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Meetings tab records an online call on this PC as two tracks, the microphone ("You") and what the PC plays ("Others"), transcribes them live, and after Stop tells the others apart (Speaker 1, 2, …), writes AI notes (Summary, Decisions, Action items) and keeps every meeting in a searchable library.
**Architecture:** A new `meeting` module in the Rust library: `store` (meeting.json, ids, the 30-day audio cleanup, recovery), `wav` (growing 16 kHz WAV tracks), `lines` and `notes` (pure text logic), `capture` (two cpal capture streams, a writer thread), `playback` (▶), `worker` (the live transcription) and `finish` (the end steps), behind a `Meetings` object in `AppState`. A new `whisper_gate` makes dictations go before meeting pieces and meeting pieces before Files-tab blocks. main.rs adds the commands, events, tray item, optional hotkey and the quit question; the recorder shows a red dot in the pill. The frontend is `src/meetings.ts` in a new tab.
**Tech Stack:** Rust (Tauri 2.10.3, cpal 0.15 on WASAPI shared mode incl. loopback, whisper-rs 0.16, sherpa-onnx via sherpa-rs-sys, the bundled llama-server), TypeScript (vanilla, Vite), tauri-plugin-dialog, tauri-plugin-global-shortcut.
**Spec:** docs/superpowers/specs/2026-10-03-meeting-mode-design.md

## Global Constraints

- **Build environment:** from Git Bash, `source /e/claude/RudariFlow/.superpowers/tools/env13.sh` (CUDA/LLVM/Vulkan/CMake env and `CARGO_TARGET_DIR=C:\r`).
- **Unit tests:** the CPU build with a filter only. From `src-tauri`: `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib <filter>` (use `--bins <filter>` for tests in `main.rs`). NEVER run the full suite: the `paste.rs` tests overwrite the user's clipboard while they work.
- **App build:** from the repo root, `CARGO_TARGET_DIR='C:\r' npm run tauri build -- --no-bundle`, in the foreground with a 600000 ms timeout. Afterwards, if `git diff --ignore-cr-at-eol --stat src-tauri/Cargo.toml` is empty, run `git checkout -- src-tauri/Cargo.toml` (`tauri build` rewrites its line endings). This plan changes no dependency, so Cargo.toml must have no real change.
- **Frontend:** `npx tsc --noEmit` from the repo root, no errors.
- **Real time (audio callbacks):** no allocation (every buffer gets its capacity before the stream starts), no logging, no file I/O, no blocking beyond the short buffer lock the soundboard's callbacks also take. Callback threads register as MMCSS "Pro Audio" once (`soundboard::engine::boost_this_thread`). A writer thread does every disk write.
- **Live checks:** only on the isolated test instance, as in `.superpowers/tools/live-checks.md` and "Live checks" at the end of this plan (`RUDARIFLOW_DATA_DIR=C:\t\rf-test-data`, `RUDARIFLOW_TEST_COMMANDS=1`, CDP on port 9333, tools in `.superpowers/tools`). Never stop, start or drive the installed RudariFlow (`E:\Users\Shiggy\AppData\Local\RudariFlow`) or its llama-server. No tray clicks, SendKeys, native dialogs or focus stealing. Check the GPU headroom first (stop if less than 6.5 GB of 16 GB is free) and stop the test instance right after each check.
- **Audio safety:** test audio is played only into `CABLE Input (VB-Audio Virtual Cable)`, through the test-only command `meeting_test_play`, which refuses to play without the test override. The override, `RUDARIFLOW_MEETING_LOOPBACK=CABLE Input (VB-Audio Virtual Cable)` (honoured only with `RUDARIFLOW_TEST_COMMANDS=1`), points the meeting's loopback at that endpoint, and ▶ plays there too. Nothing plays on the user's real outputs. The virtual cable is shared with the user's Discord: a live check runs only after the controller confirmed the user is not in a call.
- **Commits:** `feat:`, `fix:`, `docs:` or `test:` plus a subject, then an EMPTY line, then exactly `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Use `git commit -F -` with a heredoc.
- **Strings:** every new UI string in English and German in `src/i18n.ts`; the pill's texts in the EN/DE map in `src/overlay.html`; the tray item in English and German by the UI language.
- **No version bump or release.**
- **Storage (spec):** `<app data>\meetings\<id>\meeting.json`, `you.wav`, `others.wav` (`get_app_dir()`, so `RUDARIFLOW_DATA_DIR` moves it). `<id>` = `m-` + 12 hex characters (`soundboard::library::new_id("m")`). The WAVs are 16 kHz mono 16-bit, appended every second; the header's sizes are written on stop and repaired on recovery. `meeting.json` holds version, id, title, start time (UTC ms + local offset in minutes), length, Whisper model, language, state (`recording` / `finishing` / `finished` / `interrupted`), lines (start ms, end ms, track `you`/`others`, speaker number or none, text), speaker names, notes (summary text, decisions list, action items with done flags), audio-deleted flag, and is written through a temp file and a rename after every change.
- **Recording (spec):** the microphone is the Recording setting's (`settings.microphone`), its own shared-mode stream; the PC sound is WASAPI loopback of Windows' default output and moves to a new default output; a lost track keeps the other recording, warns ("Microphone lost — retrying" / "PC sound lost — retrying") and reopens every 3 s; no PC sound within 30 s warns "No sound from the PC yet — is the call playing on this PC?"; starting needs ≥ 1 GB free; a meeting stops itself at 4 hours with a notice; starting while one records is refused ("A meeting is already recording").
- **Live transcription (spec):** pieces of 15–30 s ending in a pause, with the user's Whisper model, language and dictionary prompt plus the end of that track's text; silence (2 s and more) is left out; Whisper priority dictation > meeting > Files tab, and a dictation never waits longer than the piece already running; while Free GPU or the battery watcher has unloaded the models, recording goes on, transcription pauses and catches up once something else loads them (the next dictation, the Free GPU hotkey again, or Stop).
- **Echo (spec):** a "You" line whose words are ≥ 70 % in the "Others" lines of the same moment is dropped.
- **After Stop (spec):** the rest of both tracks is transcribed; sherpa-onnx separates `others.wav` with the Files tab's models and an automatic count, and the Others lines get Speaker 1, 2, … by overlap (`speakers::assign`); without the models "Others" stays with a download hint; the AI writes Summary, Decisions, Action items in the meeting's language (long meetings condensed in parts as in the Files tab); AI cleanup off or the AI unavailable → no notes, a hint and **Write notes**; the meeting is saved as finished.
- **Library (spec):** newest first, search by title and transcript, open/rename/export/delete (asks once); audio deleted 30 days after the meeting ended (at start and once a day), text kept; an interrupted meeting offers **Finish**.
- **Commands (spec):** `meeting_start(title?)`, `meeting_stop()`, `meeting_state()`, `meeting_list(query?)`, `meeting_get(id)`, `meeting_rename(id, title)`, `meeting_rename_speaker(id, speaker, name)`, `meeting_set_action_done(id, index, done)`, `meeting_delete(id)`, `meeting_finish(id)`, `meeting_write_notes(id)`, `meeting_play(id, fromMs)`, `meeting_stop_playing()`; exports through the existing `export_file`. Added by this plan: `meeting_default_title()`, `meeting_quit()`, test-only `meeting_test_play(path)`.
- **Events (spec):** `meeting-status`, `meeting-lines`, `meetings-changed`. Added by this plan: `meeting-playing` (▶ started or ended), `meeting-quit-asked` (tray Quit while recording), `meeting-notice` (pill only).
- **Hotkey (spec):** optional, under Recording, off by default, same capture and conflict rules as the other hotkeys; a press toggles start/stop.

---

## File map

| File | Change |
|---|---|
| `src-tauri/src/lib.rs` | `pub mod meeting;`, `pub mod whisper_gate;` |
| `src-tauri/src/meeting/mod.rs` | `Meetings`, `Config`, `Status`, `Recording`, `Finishing`, `Event`, `MeetingView`, `Current`, `LinesChanged`, `Playing`, `free_bytes` |
| `src-tauri/src/meeting/store.rs` | `Meeting`, `Line`, `Track`, `State`, `Notes`, `ActionItem`, `Summary`; save/load/list/delete, ids, 30-day cleanup, recovery, default title, UTC offset |
| `src-tauri/src/meeting/wav.rs` | `TrackFile` (growing WAV), `repair`, `sample_count`, `read_range` |
| `src-tauri/src/meeting/lines.rs` | `next_piece`, echo rule, `add_lines`, `label_others`, `paragraphs`, `changed_from`, `transcript` |
| `src-tauri/src/meeting/notes.rs` | `meeting_prompt`, `parse`, `write` |
| `src-tauri/src/meeting/capture.rs` | `Capture` (mic + loopback streams, writer thread), `Resampler`, `to_append`, `Warning`, `loopback_override` |
| `src-tauri/src/meeting/playback.rs` | `Player`, `meeting_source`, `samples_source`, `mix` |
| `src-tauri/src/meeting/worker.rs` | `Worker`, `Source`/`Transcriber` traits, `Tracks`, `Whisper`, `PAUSED` |
| `src-tauri/src/meeting/finish.rs` | `run` (end steps), `apply_piece`, `Step` |
| `src-tauri/src/whisper_gate.rs` | `Gate`, `Priority` |
| `src-tauri/src/whisper_engine.rs` | the gate in `transcribe` and `file_block`, `FileRun.priority`, `start_meeting` |
| `src-tauri/src/file_transcribe.rs` | `pub(crate) written_in`, `transcribe_stretch`, `condense`, `AI_TIMEOUT` |
| `src-tauri/src/soundboard/engine.rs` | `MmcssGuard`, `boost_this_thread`, `find_device` become `pub(crate)` |
| `src-tauri/src/settings.rs` | `meeting_hotkey`, `meeting_reminder_off`, `meeting_headphones_seen` |
| `src-tauri/src/recorder.rs` | the pill's meeting dot (`set_meeting_dot`, `rest_overlay`) |
| `src-tauri/src/main.rs` | `AppState.meetings`, `HotkeyAction::Meeting`, commands, `meeting_event`, tray item, quit question, exit, `summarize_text` on `condense` |
| `src/overlay.html` | red dot, `meeting-notice` |
| `src/meetings.ts` | the Meetings tab |
| `index.html`, `src/main.ts`, `src/hotkey-capture.ts`, `src/i18n.ts`, `src/style.css` | tab, hotkey row, quit dialog, wiring, owner name, EN/DE, styles |
| `README.md`, `README.de.md`, `CHANGELOG.md` | docs |

All Rust in Tasks 1–6 and the TypeScript in Task 7 were compiled and the tests run in a scratch copy of the crate while this plan was written (`--lib` and `--bins`, clippy clean for the new code, `tsc --noEmit` clean); `src/overlay.html` and the live-check scripts were not.

---

### Task 1: Storage: `meeting.json` and the WAV tracks

**Files:**
- Create: `src-tauri/src/meeting/mod.rs`, `src-tauri/src/meeting/wav.rs`, `src-tauri/src/meeting/store.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `wav.rs`, `store.rs` (`mod tests`)

**Interfaces:**
- Consumes: `soundboard::library::new_id(prefix: &str) -> String`, `replacements::Moment { year: u16, month: u8, day: u8, hour: u8, minute: u8, weekday: u8 }`, `startup_log::log(&str)`.
- Produces (`rudariflow_lib::meeting::wav`):
  - `pub const RATE: u32 = 16_000`
  - `pub struct TrackFile`: `TrackFile::create(path: &Path) -> Result<TrackFile, String>`, `samples(&self) -> u64`, `append(&mut self, samples: &[f32]) -> Result<(), String>`, `finish(&mut self) -> Result<(), String>`
  - `pub fn sample_count(path: &Path) -> u64`, `pub fn repair(path: &Path) -> Result<u64, String>`, `pub fn read_range(path: &Path, from: u64, to: u64) -> Result<Vec<f32>, String>`
- Produces (`rudariflow_lib::meeting::store`):
  - `pub const FILE: &str = "meeting.json"`, `YOU_WAV = "you.wav"`, `OTHERS_WAV = "others.wav"`, `KEEP_AUDIO_MS: u64` (30 days)
  - `pub enum Track { You, Others }` (serde `"you"`/`"others"`, `Copy`, `Hash`), `Track::index(self) -> usize` (0/1), `Track::wav(self) -> &'static str`
  - `pub enum State { Recording, Finishing, Finished, Interrupted }` (serde lowercase)
  - `pub struct Line { start_ms: u64, end_ms: u64, track: Track, speaker: Option<u8>, text: String }`
  - `pub struct ActionItem { text: String, done: bool }`, `pub struct Notes { summary: String, decisions: Vec<String>, action_items: Vec<ActionItem> }`
  - `pub struct Meeting { version, id, title, started_at: u64, utc_offset_min: i32, length_ms: u64, whisper_model, language, state: State, lines: Vec<Line>, you_done_ms: u64, others_done_ms: u64, speaker_names: Vec<String>, notes: Option<Notes>, speakers_error: Option<String>, notes_error: Option<String>, audio_deleted: bool }` (all `pub`, serde camelCase); `Meeting::new(id, title, started_at, utc_offset_min, whisper_model, language) -> Meeting` (state `Recording`), `dir(&self, root: &Path) -> PathBuf`, `ended_at(&self) -> u64`, `save(&self, root: &Path) -> Result<(), String>`
  - `pub fn root(app_dir: &Path) -> PathBuf`, `new_id() -> String`, `valid_id(id: &str) -> bool`, `load(root, id) -> Result<Meeting, String>` (`"no_meeting"`), `list(root) -> Vec<Meeting>` (newest first), `matches(meeting, query) -> bool`, `delete(root, id) -> Result<(), String>`, `delete_old_audio(root, now_ms: u64) -> usize`, `recover(root) -> Vec<String>`, `now_ms() -> u64`, `utc_offset_min(local: &Moment, utc_ms: u64) -> i32`, `default_title(german: bool, at: &Moment) -> String`
  - `pub struct Summary { id, title, started_at, utc_offset_min, length_ms, state, audio_deleted }` (serde camelCase), `impl From<&Meeting> for Summary`

- [ ] **Step 1: Module skeleton and failing tests**

Create `src-tauri/src/meeting/mod.rs`:

```rust
//! Meeting mode: an online call on this PC recorded as two tracks, the
//! microphone ("You") and what the PC plays ("Others"), transcribed live,
//! with the others told apart and AI notes after Stop. See
//! docs/superpowers/specs/2026-10-03-meeting-mode-design.md.

pub mod store;
pub mod wav;
```

In `src-tauri/src/lib.rs`, add `pub mod meeting;` after `pub mod soundboard;`.

Create `src-tauri/src/meeting/wav.rs` with only its tests for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rudariflow_meeting_wav_{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ramp(n: usize) -> Vec<f32> {
        (0..n).map(|i| (i % 100) as f32 / 200.0).collect()
    }

    #[test]
    fn a_finished_track_is_a_wav_any_player_reads() {
        let path = temp("finished").join("you.wav");
        let mut track = TrackFile::create(&path).unwrap();
        track.append(&ramp(16_000)).unwrap();
        track.append(&[2.0, -2.0]).unwrap();
        track.finish().unwrap();
        assert_eq!(track.samples(), 16_002);
        let reader = hound::WavReader::open(&path).unwrap();
        let spec = reader.spec();
        assert_eq!((spec.channels, spec.sample_rate, spec.bits_per_sample), (1, 16_000, 16));
        assert_eq!(reader.duration(), 16_002);
        let samples: Vec<i16> = reader.into_samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(samples[16_000..], [i16::MAX, -i16::MAX], "clipped");
        assert_eq!(sample_count(&path), 16_002);
    }

    #[test]
    fn a_track_a_crash_left_open_is_repaired() {
        let path = temp("crash").join("others.wav");
        let mut track = TrackFile::create(&path).unwrap();
        track.append(&ramp(8_000)).unwrap();
        drop(track); // no finish(): the header still says 0 samples
        // A half-written last sample.
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(&[7]).unwrap();
        assert_eq!(repair(&path).unwrap(), 8_000);
        let reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.duration(), 8_000);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 44 + 16_000);
    }

    #[test]
    fn ranges_are_read_while_the_track_grows() {
        let path = temp("range").join("you.wav");
        let mut track = TrackFile::create(&path).unwrap();
        let audio = ramp(1_000);
        track.append(&audio).unwrap();
        let got = read_range(&path, 100, 200).unwrap();
        assert_eq!(got.len(), 100);
        for (g, want) in got.iter().zip(&audio[100..200]) {
            assert!((g - want).abs() < 1e-4, "{} vs {}", g, want);
        }
        assert_eq!(read_range(&path, 900, 5_000).unwrap().len(), 100, "clipped at the end");
        assert!(read_range(&path, 2_000, 3_000).unwrap().is_empty(), "past the end");
        assert!(read_range(&path, 10, 10).unwrap().is_empty());
        track.append(&audio).unwrap();
        assert_eq!(read_range(&path, 900, 1_100).unwrap().len(), 200, "the new part");
    }
}
```

Create `src-tauri/src/meeting/store.rs` with only its tests for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rudariflow_meeting_store_{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn line(start_ms: u64, track: Track, text: &str) -> Line {
        Line { start_ms, end_ms: start_ms + 2_000, track, speaker: None, text: text.to_string() }
    }

    fn meeting(id: &str, started_at: u64) -> Meeting {
        Meeting::new(id, "Weekly", started_at, 120, "large-v3-turbo", "auto")
    }

    #[test]
    fn a_meeting_survives_a_save_and_a_load() {
        let root = temp("roundtrip");
        let mut m = meeting("m-0123456789ab", 1_000);
        m.lines.push(line(0, Track::You, "Hello."));
        m.lines.push(Line { speaker: Some(1), ..line(2_000, Track::Others, "Hi there.") });
        m.speaker_names = vec!["Anna".into()];
        m.notes = Some(Notes {
            summary: "We met.".into(),
            decisions: vec!["Ship it".into()],
            action_items: vec![ActionItem { text: "Saad sends the slides".into(), done: true }],
        });
        m.speakers_error = Some("none_found".into());
        m.save(&root).unwrap();
        assert!(!m.dir(&root).join("meeting.json.tmp").exists(), "written through a temp file");
        assert_eq!(load(&root, &m.id).unwrap(), m);
        let json = std::fs::read_to_string(m.dir(&root).join(FILE)).unwrap();
        for key in ["\"startedAt\"", "\"utcOffsetMin\"", "\"lengthMs\"", "\"speakerNames\"", "\"actionItems\"", "\"audioDeleted\"", "\"track\": \"others\"", "\"state\": \"recording\""] {
            assert!(json.contains(key), "{} in {}", key, json);
        }
        assert!(!json.contains("notesError"), "an unset reason is left out");
    }

    #[test]
    fn ids_are_random_and_only_they_name_a_folder() {
        let (a, b) = (new_id(), new_id());
        assert_ne!(a, b);
        assert!(valid_id(&a) && valid_id(&b), "{} {}", a, b);
        for bad in ["", "m-", "m-0123456789aZ", "m-0123456789abc", "..\\x", "m-../../../../x", "s-0123456789ab"] {
            assert!(!valid_id(bad), "{}", bad);
        }
        let root = temp("ids");
        assert_eq!(load(&root, "..\\..\\config"), Err("no_meeting".into()));
        assert_eq!(delete(&root, "..\\.."), Err("no_meeting".into()));
    }

    #[test]
    fn the_list_is_newest_first_and_skips_damaged_files() {
        let root = temp("list");
        meeting("m-000000000001", 1_000).save(&root).unwrap();
        meeting("m-000000000002", 3_000).save(&root).unwrap();
        meeting("m-000000000003", 2_000).save(&root).unwrap();
        std::fs::create_dir_all(root.join("m-00000000000f")).unwrap();
        std::fs::write(root.join("m-00000000000f").join(FILE), "{ not json").unwrap();
        std::fs::create_dir_all(root.join("not-a-meeting")).unwrap();
        let ids: Vec<String> = list(&root).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["m-000000000002", "m-000000000003", "m-000000000001"]);
        assert!(root.join("m-00000000000f").join(FILE).exists(), "kept");
        delete(&root, "m-000000000003").unwrap();
        assert_eq!(list(&root).len(), 2);
        assert!(list(&temp("none")).is_empty());
    }

    #[test]
    fn the_search_looks_at_titles_and_transcripts() {
        let mut m = meeting("m-000000000001", 0);
        m.title = "Budget review".into();
        m.lines.push(line(0, Track::Others, "The Prodega order is late."));
        assert!(matches(&m, ""));
        assert!(matches(&m, "  BUDGET "));
        assert!(matches(&m, "prodega"));
        assert!(!matches(&m, "holiday"));
    }

    #[test]
    fn audio_goes_thirty_days_after_the_meeting_ended() {
        let root = temp("cleanup");
        let day = 24 * 3600 * 1000;
        let now = 100 * day;
        let mut old = meeting("m-000000000001", now - 31 * day);
        old.length_ms = 3_600_000;
        old.state = State::Finished;
        let mut recent = meeting("m-000000000002", now - 29 * day);
        recent.state = State::Finished;
        let mut live = meeting("m-000000000003", now - 40 * day);
        live.state = State::Finishing;
        let mut stopped = meeting("m-000000000004", now - 40 * day);
        stopped.state = State::Interrupted;
        for m in [&old, &recent, &live, &stopped] {
            m.save(&root).unwrap();
            std::fs::write(m.dir(&root).join(YOU_WAV), b"x").unwrap();
            std::fs::write(m.dir(&root).join(OTHERS_WAV), b"x").unwrap();
        }
        assert_eq!(delete_old_audio(&root, now), 2);
        for (m, gone) in [(&old, true), (&recent, false), (&live, false), (&stopped, true)] {
            assert_eq!(!m.dir(&root).join(YOU_WAV).exists(), gone, "{}", m.id);
            assert_eq!(!m.dir(&root).join(OTHERS_WAV).exists(), gone, "{}", m.id);
            let loaded = load(&root, &m.id).unwrap();
            assert_eq!(loaded.audio_deleted, gone, "{}", m.id);
            assert_eq!(loaded.lines, m.lines, "the text stays");
        }
        assert_eq!(delete_old_audio(&root, now), 0, "once");
    }

    #[test]
    fn a_meeting_cut_off_while_recording_or_finishing_becomes_interrupted() {
        let root = temp("recover");
        let recording = meeting("m-000000000001", 0);
        recording.save(&root).unwrap();
        let mut track = wav::TrackFile::create(&recording.dir(&root).join(YOU_WAV)).unwrap();
        track.append(&vec![0.1; 32_000]).unwrap();
        drop(track); // the crash: no header sizes
        let mut finishing = meeting("m-000000000002", 0);
        finishing.state = State::Finishing;
        finishing.length_ms = 5_000;
        finishing.save(&root).unwrap();
        let mut done = meeting("m-000000000003", 0);
        done.state = State::Finished;
        done.save(&root).unwrap();
        let mut ids = recover(&root);
        ids.sort();
        assert_eq!(ids, ["m-000000000001", "m-000000000002"]);
        let r = load(&root, "m-000000000001").unwrap();
        assert_eq!((r.state, r.length_ms), (State::Interrupted, 2_000), "the length comes from the audio");
        assert_eq!(hound::WavReader::open(r.dir(&root).join(YOU_WAV)).unwrap().duration(), 32_000);
        let f = load(&root, "m-000000000002").unwrap();
        assert_eq!((f.state, f.length_ms), (State::Interrupted, 5_000), "no audio: the saved length stays");
        assert_eq!(load(&root, "m-000000000003").unwrap().state, State::Finished);
        assert!(recover(&root).is_empty(), "once");
    }

    #[test]
    fn titles_and_offsets_follow_the_local_clock() {
        let at = Moment { year: 2026, month: 10, day: 3, hour: 14, minute: 0, weekday: 6 };
        assert_eq!(default_title(false, &at), "Meeting 3 Oct 2026, 14:00");
        assert_eq!(default_title(true, &at), "Meeting 3. Okt. 2026, 14:00");
        let march = Moment { month: 3, hour: 9, minute: 5, ..at };
        assert_eq!(default_title(true, &march), "Meeting 3. März 2026, 09:05");
        // 2026-10-03 12:00:20 UTC is 14:00 in Zurich (summer time).
        let utc = days_from_civil(2026, 10, 3) as u64 * 86_400_000 + 12 * 3_600_000 + 20_000;
        assert_eq!(utc_offset_min(&at, utc), 120);
        let new_york = Moment { hour: 8, ..at };
        assert_eq!(utc_offset_min(&new_york, utc), -240);
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
    }
}
```

- [ ] **Step 2: Run the tests to see them fail**

```bash
source /e/claude/RudariFlow/.superpowers/tools/env13.sh
cd /e/claude/RudariFlow/src-tauri
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib meeting::
```

Expected: compile errors (`TrackFile`, `Meeting`, `Track`, `FILE`, … not found).

- [ ] **Step 3: The WAV tracks**

Put this above the tests in `wav.rs`:

```rust
//! A meeting's tracks: 16 kHz mono 16-bit WAV files that grow every second
//! while the meeting records. The header's sizes are written when a track
//! is closed, and repaired from the file's length after a crash.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

pub const RATE: u32 = 16_000;
/// The canonical PCM header: RIFF, fmt (16 bytes), data.
const HEADER: u64 = 44;

/// A track being written.
pub struct TrackFile {
    file: File,
    samples: u64,
    bytes: Vec<u8>,
}

/// The 44-byte header of a file with `samples` samples.
fn header(samples: u64) -> [u8; 44] {
    let data = (samples * 2).min(u32::MAX as u64 - 36) as u32;
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
    h[24..28].copy_from_slice(&RATE.to_le_bytes());
    h[28..32].copy_from_slice(&(RATE * 2).to_le_bytes()); // bytes per second
    h[32..34].copy_from_slice(&2u16.to_le_bytes()); // block align
    h[34..36].copy_from_slice(&16u16.to_le_bytes()); // bits per sample
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data.to_le_bytes());
    h
}

impl TrackFile {
    /// A new, empty track at `path` (an existing file is replaced).
    pub fn create(path: &Path) -> Result<TrackFile, String> {
        let mut file = File::create(path).map_err(|e| format!("{}: {}", path.display(), e))?;
        file.write_all(&header(0)).map_err(|e| e.to_string())?;
        Ok(TrackFile { file, samples: 0, bytes: Vec::new() })
    }

    pub fn samples(&self) -> u64 {
        self.samples
    }

    /// Append samples (-1.0 … 1.0, clipped) as 16-bit PCM.
    pub fn append(&mut self, samples: &[f32]) -> Result<(), String> {
        self.bytes.clear();
        for &s in samples {
            let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            self.bytes.extend_from_slice(&v.to_le_bytes());
        }
        self.file.write_all(&self.bytes).map_err(|e| e.to_string())?;
        self.samples += samples.len() as u64;
        Ok(())
    }

    /// Write the sizes into the header (on stop).
    pub fn finish(&mut self) -> Result<(), String> {
        self.file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        self.file.write_all(&header(self.samples)).map_err(|e| e.to_string())?;
        self.file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
        self.file.flush().map_err(|e| e.to_string())
    }
}

/// How many samples the file holds, from its length (not its header).
pub fn sample_count(path: &Path) -> u64 {
    std::fs::metadata(path).map_or(0, |m| m.len().saturating_sub(HEADER) / 2)
}

/// Write the sizes into the header of a track a crash left open, and drop
/// an odd last byte. Returns the samples.
pub fn repair(path: &Path) -> Result<u64, String> {
    let samples = sample_count(path);
    let mut file = OpenOptions::new().write(true).open(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    file.set_len(HEADER + samples * 2).map_err(|e| e.to_string())?;
    file.write_all(&header(samples)).map_err(|e| e.to_string())?;
    Ok(samples)
}

/// Samples `from..to` of a track (fewer at its end; none past it).
pub fn read_range(path: &Path, from: u64, to: u64) -> Result<Vec<f32>, String> {
    if to <= from {
        return Ok(Vec::new());
    }
    let mut file = File::open(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    file.seek(SeekFrom::Start(HEADER + from * 2)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(((to - from) * 2) as usize);
    file.take((to - from) * 2).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b) as f32 / i16::MAX as f32).collect())
}
```

- [ ] **Step 4: The store**

Put this above the tests in `store.rs`:

```rust
//! Meetings on disk: `<app data>\meetings\<id>\meeting.json` (title,
//! times, lines, speakers, notes) next to `you.wav` and `others.wav`.
//! `meeting.json` is written through a temp file and a rename after every
//! change, so a crash never leaves half a file.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::wav;
use crate::replacements::Moment;
use crate::startup_log;

pub const FILE: &str = "meeting.json";
pub const YOU_WAV: &str = "you.wav";
pub const OTHERS_WAV: &str = "others.wav";
/// The audio is deleted this long after a meeting ended; the text stays.
pub const KEEP_AUDIO_MS: u64 = 30 * 24 * 3600 * 1000;

fn version() -> u32 {
    1
}

/// Which recording a line comes from: the microphone or what the PC plays.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Track {
    You,
    Others,
}

impl Track {
    pub fn index(self) -> usize {
        match self {
            Track::You => 0,
            Track::Others => 1,
        }
    }

    pub fn wav(self) -> &'static str {
        match self {
            Track::You => YOU_WAV,
            Track::Others => OTHERS_WAV,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Recording,
    Finishing,
    Finished,
    Interrupted,
}

/// One Whisper segment of a track; times in ms from the meeting's start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub start_ms: u64,
    pub end_ms: u64,
    pub track: Track,
    /// Others after the speakers were told apart: 0 = Speaker 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<u8>,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionItem {
    pub text: String,
    #[serde(default)]
    pub done: bool,
}

/// The AI's notes; a section with nothing in it is empty.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notes {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub action_items: Vec<ActionItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    #[serde(default = "version")]
    pub version: u32,
    pub id: String,
    pub title: String,
    /// UTC, ms since 1970.
    pub started_at: u64,
    /// Local time minus UTC at the start, in minutes (120 in Swiss summer).
    #[serde(default)]
    pub utc_offset_min: i32,
    #[serde(default)]
    pub length_ms: u64,
    #[serde(default)]
    pub whisper_model: String,
    /// Whisper language code; "auto" until the first piece detected it.
    #[serde(default)]
    pub language: String,
    pub state: State,
    #[serde(default)]
    pub lines: Vec<Line>,
    /// How far each track is transcribed (ms); Finish goes on from here.
    #[serde(default)]
    pub you_done_ms: u64,
    #[serde(default)]
    pub others_done_ms: u64,
    /// Speaker n's name; "" or missing = "Speaker n+1".
    #[serde(default)]
    pub speaker_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<Notes>,
    /// Why the Others have no speakers: "no_model", "no_runtime",
    /// "none_found" or an error text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speakers_error: Option<String>,
    /// Why there are no notes: "ai_off", "no_ai_model", "gpu_freed" or an
    /// error text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes_error: Option<String>,
    #[serde(default)]
    pub audio_deleted: bool,
}

impl Meeting {
    pub fn new(id: &str, title: &str, started_at: u64, utc_offset_min: i32, whisper_model: &str, language: &str) -> Meeting {
        Meeting {
            version: 1,
            id: id.to_string(),
            title: title.to_string(),
            started_at,
            utc_offset_min,
            length_ms: 0,
            whisper_model: whisper_model.to_string(),
            language: language.to_string(),
            state: State::Recording,
            lines: Vec::new(),
            you_done_ms: 0,
            others_done_ms: 0,
            speaker_names: Vec::new(),
            notes: None,
            speakers_error: None,
            notes_error: None,
            audio_deleted: false,
        }
    }

    /// This meeting's folder under `root` (`<app data>\meetings`).
    pub fn dir(&self, root: &Path) -> PathBuf {
        root.join(&self.id)
    }

    pub fn ended_at(&self) -> u64 {
        self.started_at + self.length_ms
    }

    pub fn save(&self, root: &Path) -> Result<(), String> {
        let dir = self.dir(root);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!("{}.tmp", FILE));
        std::fs::write(&tmp, json)
            .and_then(|_| std::fs::rename(&tmp, dir.join(FILE)))
            .map_err(|e| e.to_string())
    }
}

/// `<app data>\meetings`.
pub fn root(app_dir: &Path) -> PathBuf {
    app_dir.join("meetings")
}

/// "m-" and 12 hex characters, like the soundboard's ids.
pub fn new_id() -> String {
    crate::soundboard::library::new_id("m")
}

/// Only ids `new_id` makes name a folder: a command's id never reaches
/// outside `meetings\`.
pub fn valid_id(id: &str) -> bool {
    id.len() == 14 && id.starts_with("m-") && id[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn load(root: &Path, id: &str) -> Result<Meeting, String> {
    if !valid_id(id) {
        return Err("no_meeting".to_string());
    }
    let text = std::fs::read_to_string(root.join(id).join(FILE)).map_err(|_| "no_meeting".to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("{} is damaged: {}", FILE, e))
}

/// Every meeting, newest first. A damaged `meeting.json` is skipped (and
/// logged), never deleted.
pub fn list(root: &Path) -> Vec<Meeting> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<Meeting> = entries
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|id| valid_id(id))
        .filter_map(|id| match load(root, &id) {
            Ok(m) => Some(m),
            Err(e) => {
                startup_log::log(&format!("[meeting] {} skipped: {}", id, e));
                None
            }
        })
        .collect();
    out.sort_by_key(|m| std::cmp::Reverse(m.started_at));
    out
}

/// Whether a meeting's title or transcript contains `query` (any case).
pub fn matches(meeting: &Meeting, query: &str) -> bool {
    let query = query.trim().to_lowercase();
    query.is_empty()
        || meeting.title.to_lowercase().contains(&query)
        || meeting.lines.iter().any(|l| l.text.to_lowercase().contains(&query))
}

pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("no_meeting".to_string());
    }
    std::fs::remove_dir_all(root.join(id)).map_err(|e| e.to_string())
}

/// Delete the audio of meetings that ended `KEEP_AUDIO_MS` or longer ago.
/// Returns how many lost their audio.
pub fn delete_old_audio(root: &Path, now_ms: u64) -> usize {
    let mut deleted = 0;
    for mut m in list(root) {
        let ended = matches!(m.state, State::Finished | State::Interrupted);
        if !ended || m.audio_deleted || m.ended_at() + KEEP_AUDIO_MS > now_ms {
            continue;
        }
        for track in [Track::You, Track::Others] {
            let _ = std::fs::remove_file(m.dir(root).join(track.wav()));
        }
        m.audio_deleted = true;
        match m.save(root) {
            Ok(()) => deleted += 1,
            Err(e) => startup_log::log(&format!("[meeting] {}: audio deleted, not saved: {}", m.id, e)),
        }
    }
    deleted
}

/// At start: a meeting still recording or finishing was cut off by a quit
/// or a crash. Its WAV headers are repaired, its length taken from the
/// audio, and it becomes interrupted. Returns the ids.
pub fn recover(root: &Path) -> Vec<String> {
    let mut recovered = Vec::new();
    for mut m in list(root) {
        if !matches!(m.state, State::Recording | State::Finishing) {
            continue;
        }
        let mut samples = 0;
        for track in [Track::You, Track::Others] {
            let path = m.dir(root).join(track.wav());
            if path.exists() {
                match wav::repair(&path) {
                    Ok(n) => samples = samples.max(n),
                    Err(e) => startup_log::log(&format!("[meeting] {}: {} not repaired: {}", m.id, track.wav(), e)),
                }
            }
        }
        m.length_ms = m.length_ms.max(samples / (wav::RATE as u64 / 1000));
        m.state = State::Interrupted;
        match m.save(root) {
            Ok(()) => recovered.push(m.id.clone()),
            Err(e) => startup_log::log(&format!("[meeting] {} not recovered: {}", m.id, e)),
        }
    }
    recovered
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Days from 1970-01-01 to a date (proleptic Gregorian).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Local time minus UTC in minutes, from the local clock `local` read at
/// UTC `utc_ms`, rounded to a quarter hour.
pub fn utc_offset_min(local: &Moment, utc_ms: u64) -> i32 {
    let local_ms = days_from_civil(local.year as i64, local.month as i64, local.day as i64) * 86_400_000
        + local.hour as i64 * 3_600_000
        + local.minute as i64 * 60_000;
    let minutes = (local_ms - utc_ms as i64) as f64 / 60_000.0;
    ((minutes / 15.0).round() * 15.0) as i32
}

const MONTHS_EN: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_DE: [&str; 12] = ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."];

/// "Meeting 3 Oct 2026, 14:00" / "Meeting 3. Okt. 2026, 14:00".
pub fn default_title(german: bool, at: &Moment) -> String {
    let month = (at.month.clamp(1, 12) - 1) as usize;
    let date = if german {
        format!("{}. {} {}", at.day, MONTHS_DE[month], at.year)
    } else {
        format!("{} {} {}", at.day, MONTHS_EN[month], at.year)
    };
    format!("Meeting {}, {:02}:{:02}", date, at.hour, at.minute)
}

/// What the library list shows of a meeting.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub started_at: u64,
    pub utc_offset_min: i32,
    pub length_ms: u64,
    pub state: State,
    pub audio_deleted: bool,
}

impl From<&Meeting> for Summary {
    fn from(m: &Meeting) -> Summary {
        Summary {
            id: m.id.clone(),
            title: m.title.clone(),
            started_at: m.started_at,
            utc_offset_min: m.utc_offset_min,
            length_ms: m.length_ms,
            state: m.state,
            audio_deleted: m.audio_deleted,
        }
    }
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib meeting::` (from `src-tauri`).
Expected: 10 tests pass (`meeting::wav` 3, `meeting::store` 7).

- [ ] **Step 6: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/lib.rs src-tauri/src/meeting/mod.rs src-tauri/src/meeting/wav.rs src-tauri/src/meeting/store.rs
git commit -F - <<'EOF'
feat: meetings are stored as meeting.json with two WAV tracks, recovered after a crash

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: The text logic: pieces, echoes, speakers, paragraphs, notes

**Files:**
- Create: `src-tauri/src/meeting/lines.rs`, `src-tauri/src/meeting/notes.rs`
- Modify: `src-tauri/src/meeting/mod.rs`, `src-tauri/src/file_transcribe.rs` (`written_in` becomes `pub(crate)`)
- Test: `lines.rs`, `notes.rs` (`mod tests`)

**Interfaces:**
- Consumes: `store::{Line, Track, Notes, ActionItem}` (Task 1); `audio::quiet_cut(audio: &[f32], from_s: f32, to_s: f32) -> usize`; `file_transcribe::{paragraphs, format, speaker_name, NONE_FOUND, Paragraph}`; `speakers::{assign, Turn}`; `whisper_engine::Segment { start_ms, end_ms, text, speaker: Option<u8> }`.
- Produces (`rudariflow_lib::meeting::lines`):
  - `pub const PIECE_MIN_SECS: f32 = 15.0`, `PIECE_MAX_SECS: f32 = 30.0`, `ECHO_SHARE: f32 = 0.7`
  - `pub fn next_piece(pending: &[f32], last: bool) -> Option<usize>`
  - `pub fn is_echo(you: &Line, lines: &[Line]) -> bool`, `pub fn add_lines(lines: &mut Vec<Line>, new: Vec<Line>) -> usize` (echoes dropped)
  - `pub fn label_others(lines: &mut [Line], turns: &[Turn]) -> Result<u8, String>` (`NONE_FOUND` without turns)
  - `pub fn who(line: &Line) -> u8` (0 You, 1 Others, 2 + n Speaker n+1), `pub fn segments(lines: &[Line]) -> Vec<Segment>`
  - `pub struct ParagraphView { start_ms: u64, track: Track, speaker: Option<u8>, text: String }` (serde camelCase), `pub fn paragraphs(lines: &[Line]) -> Vec<ParagraphView>`, `pub fn changed_from(old: &[ParagraphView], new: &[ParagraphView]) -> usize`
  - `pub fn transcript(lines: &[Line], speaker_names: &[String]) -> String` ("[4:05] You: …")
- Produces (`rudariflow_lib::meeting::notes`): `pub fn meeting_prompt(language: Option<&str>) -> String`, `pub fn parse(answer: &str) -> Notes`
- Produces (`file_transcribe`): `pub(crate) fn written_in(language: Option<&str>) -> String`

- [ ] **Step 1: Failing tests**

In `src-tauri/src/meeting/mod.rs`, replace the module list with:

```rust
pub mod lines;
pub mod notes;
pub mod store;
pub mod wav;
```

Create `src-tauri/src/meeting/lines.rs` with only its tests for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn line(start_s: f32, end_s: f32, track: Track, text: &str) -> Line {
        Line { start_ms: (start_s * 1000.0) as u64, end_ms: (end_s * 1000.0) as u64, track, speaker: None, text: text.to_string() }
    }

    fn sound(secs: f32) -> Vec<f32> {
        vec![0.3; (secs * RATE) as usize]
    }

    fn with_pause(at_secs: f32) -> Vec<f32> {
        let mut audio = sound(40.0);
        let at = (at_secs * RATE) as usize;
        audio[at..at + 8_000].iter_mut().for_each(|s| *s = 0.0);
        audio
    }

    #[test]
    fn a_piece_waits_for_15_seconds_and_a_pause() {
        let audio = with_pause(17.0);
        assert_eq!(next_piece(&audio[..14 * 16_000], false), None, "under 15 s");
        assert_eq!(next_piece(&audio[..16 * 16_000], false), None, "no pause yet");
        let cut = next_piece(&audio[..20 * 16_000], false).unwrap();
        assert!((17 * 16_000..17 * 16_000 + 8_000).contains(&cut), "in the pause: {}", cut);
        // A pause before 15 s does not count.
        assert_eq!(next_piece(&with_pause(5.0)[..20 * 16_000], false), None);
    }

    #[test]
    fn without_a_pause_a_piece_ends_at_30_seconds() {
        let audio = sound(40.0);
        assert_eq!(next_piece(&audio[..29 * 16_000], false), None);
        let cut = next_piece(&audio, false).unwrap();
        assert!((15 * 16_000..=30 * 16_000).contains(&cut), "{}", cut);
    }

    #[test]
    fn at_the_end_the_rest_goes_whole() {
        let audio = sound(40.0);
        assert_eq!(next_piece(&audio[..5 * 16_000], true), Some(5 * 16_000));
        assert_eq!(next_piece(&audio[..25 * 16_000], true), Some(25 * 16_000));
        let cut = next_piece(&audio, true).unwrap();
        assert!(cut <= 30 * 16_000, "over 30 s it is still cut: {}", cut);
        assert_eq!(next_piece(&[], true), None);
    }

    #[test]
    fn a_you_line_that_repeats_the_others_is_an_echo() {
        let others = line(10.0, 14.0, Track::Others, "We ship version ten on Friday, right?");
        let echo = line(10.3, 14.2, Track::You, "ship version ten on Friday");
        let answer = line(14.5, 16.0, Track::You, "Yes, Friday works for me.");
        let later = line(30.0, 33.0, Track::You, "We ship version ten on Friday.");
        let all = vec![others.clone(), echo.clone(), answer.clone(), later.clone()];
        assert!(is_echo(&echo, &all));
        assert!(!is_echo(&answer, &all), "1 of 5 words");
        assert!(!is_echo(&later, &all), "not the same moment");
        assert!(!is_echo(&others, &all), "only You lines");
        // 70 % exactly: 7 of 10 words.
        let o = line(0.0, 5.0, Track::Others, "one two three four five six seven");
        let y = line(0.0, 5.0, Track::You, "one two three four five six seven eight nine ten");
        assert!(is_echo(&y, &[o.clone(), y.clone()]));
        let y6 = line(0.0, 5.0, Track::You, "one two three four five six eight nine ten eleven");
        assert!(!is_echo(&y6, &[o, y6.clone()]), "60 %");
    }

    #[test]
    fn lines_are_kept_in_time_order_without_echoes() {
        let mut lines = vec![line(0.0, 3.0, Track::You, "Hello everyone.")];
        // The Others track's piece arrives after a later You piece.
        let dropped = add_lines(&mut lines, vec![line(20.0, 22.0, Track::You, "Shall we start?")]);
        assert_eq!(dropped, 0);
        let dropped = add_lines(
            &mut lines,
            vec![line(1.0, 4.0, Track::Others, "Hi, good morning."), line(20.0, 22.5, Track::Others, "Shall we start?")],
        );
        assert_eq!(dropped, 1, "the You line that echoes");
        let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts, ["Hello everyone.", "Hi, good morning.", "Shall we start?"]);
        assert_eq!(lines[2].track, Track::Others);
    }

    #[test]
    fn the_others_get_speakers_by_overlap() {
        let mut lines = vec![
            line(0.0, 2.0, Track::Others, "Welcome."),
            line(2.0, 3.0, Track::You, "Thanks."),
            line(4.0, 6.0, Track::Others, "Version ten is out."),
            line(7.0, 9.0, Track::Others, "Great news."),
        ];
        assert_eq!(label_others(&mut lines, &[]), Err(NONE_FOUND.to_string()));
        assert!(lines.iter().all(|l| l.speaker.is_none()));
        let turns = [
            Turn { start_ms: 0, end_ms: 2_500, speaker: 5 },
            Turn { start_ms: 3_500, end_ms: 6_500, speaker: 2 },
            Turn { start_ms: 6_500, end_ms: 9_000, speaker: 5 },
        ];
        assert_eq!(label_others(&mut lines, &turns), Ok(2));
        let speakers: Vec<Option<u8>> = lines.iter().map(|l| l.speaker).collect();
        assert_eq!(speakers, [Some(0), None, Some(1), Some(0)], "You keeps none");
        // One voice: everyone is Speaker 1.
        let mut one = vec![line(0.0, 2.0, Track::Others, "Hi.")];
        assert_eq!(label_others(&mut one, &[Turn { start_ms: 0, end_ms: 9_000, speaker: 3 }]), Ok(1));
        assert_eq!(one[0].speaker, Some(0));
    }

    #[test]
    fn paragraphs_change_with_the_track_and_the_speaker() {
        let mut lines = vec![
            line(0.0, 2.0, Track::You, "hello everyone."),
            line(2.1, 4.0, Track::You, "Let's start."),
            line(4.2, 6.0, Track::Others, "Hi."),
            line(6.1, 8.0, Track::Others, "Version ten is out."),
            line(8.1, 9.0, Track::You, "Great."),
        ];
        let p = paragraphs(&lines);
        assert_eq!(p.len(), 3);
        assert_eq!((p[0].track, p[0].speaker, p[0].text.as_str()), (Track::You, None, "Hello everyone. Let's start."));
        assert_eq!((p[1].track, p[1].speaker, p[1].start_ms), (Track::Others, None, 4_200));
        lines[3].speaker = Some(1);
        lines[2].speaker = Some(0);
        let p = paragraphs(&lines);
        assert_eq!(p.len(), 4, "two speakers in the Others' paragraph");
        assert_eq!((p[1].speaker, p[2].speaker), (Some(0), Some(1)));
        assert!(paragraphs(&[]).is_empty());
    }

    #[test]
    fn only_changed_paragraphs_are_sent_again() {
        let lines = vec![line(0.0, 2.0, Track::You, "One."), line(5.0, 6.0, Track::Others, "Two.")];
        let old = paragraphs(&lines);
        let mut more = lines.clone();
        more.push(line(6.1, 7.0, Track::Others, "Three."));
        more.push(line(12.0, 13.0, Track::You, "Four."));
        let new = paragraphs(&more);
        assert_eq!(changed_from(&old, &new), 1, "the Others' paragraph grew");
        assert_eq!(changed_from(&new, &new), new.len());
        assert_eq!(changed_from(&[], &new), 0);
    }

    #[test]
    fn the_notes_get_times_and_names() {
        let lines = vec![
            line(0.0, 2.0, Track::You, "Welcome."),
            Line { speaker: Some(1), ..line(65.0, 67.0, Track::Others, "Thanks for having me.") },
            Line { speaker: Some(0), ..line(70.0, 72.0, Track::Others, "Hi.") },
            line(80.0, 81.0, Track::Others, "Bye."),
        ];
        let names = vec!["Anna".to_string()];
        assert_eq!(
            transcript(&lines, &names),
            "[0:00] You: Welcome.\n\n[1:05] Speaker 2: Thanks for having me.\n\n[1:10] Anna: Hi.\n\n[1:20] Others: Bye."
        );
    }
}
```

Create `src-tauri/src/meeting/notes.rs` with only its tests for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_asks_for_three_fixed_headings_in_the_meetings_language() {
        let p = meeting_prompt(Some("German"));
        for h in ["## Summary", "## Decisions", "## Action items", "Write in German"] {
            assert!(p.contains(h), "{} in {}", h, p);
        }
        assert!(meeting_prompt(None).contains("the language of the transcript"));
    }

    #[test]
    fn three_sections_become_notes() {
        let notes = parse(
            "## Summary\nThe team planned the release.\nVersion ten ships Friday.\n\n## Decisions\n- Ship on Friday\n- Drop the beta\n\n## Action items\n- Saad writes the release notes by Thursday\n* Anna tests the installer",
        );
        assert_eq!(notes.summary, "The team planned the release.\nVersion ten ships Friday.");
        assert_eq!(notes.decisions, ["Ship on Friday", "Drop the beta"]);
        let actions: Vec<(&str, bool)> = notes.action_items.iter().map(|a| (a.text.as_str(), a.done)).collect();
        assert_eq!(actions, [("Saad writes the release notes by Thursday", false), ("Anna tests the installer", false)]);
    }

    #[test]
    fn markdown_variations_are_read_too() {
        let notes = parse("**Summary:**\nKurzes Treffen.\n**Decisions:**\n1. Freitag\n2) Ohne Beta\n**Action Items:**\nSaad schreibt die Notizen");
        assert_eq!(notes.summary, "Kurzes Treffen.");
        assert_eq!(notes.decisions, ["Freitag", "Ohne Beta"]);
        assert_eq!(notes.action_items[0].text, "Saad schreibt die Notizen", "a line without a dash");
    }

    #[test]
    fn missing_and_empty_sections_stay_empty() {
        let notes = parse("## Summary\nA short call.\n## Decisions\n- None.\n## Action items\n");
        assert_eq!(notes.summary, "A short call.");
        assert!(notes.decisions.is_empty() && notes.action_items.is_empty());
        let notes = parse("## Summary\nA short call.\n## Action items\n- Keine");
        assert!(notes.decisions.is_empty(), "no Decisions heading");
        assert!(notes.action_items.is_empty());
        let notes = parse("## Summary\nNone mentioned.\n## Decisions\n- Ship it");
        assert_eq!(notes.summary, "");
        assert_eq!(notes.decisions, ["Ship it"]);
        assert_eq!(parse(""), Notes::default());
    }

    #[test]
    fn an_answer_without_headings_becomes_the_summary() {
        let notes = parse("The team met.\n- They chose Friday.");
        assert_eq!(notes.summary, "The team met.\n- They chose Friday.");
        assert!(notes.decisions.is_empty() && notes.action_items.is_empty());
    }
}
```

Run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib meeting::` (from `src-tauri`). Expected: compile errors (`next_piece`, `add_lines`, `parse`, `meeting_prompt`, … not found).

- [ ] **Step 2: `written_in` for the notes prompt**

In `src-tauri/src/file_transcribe.rs`, replace

```rust
fn written_in(language: Option<&str>) -> String {
```

with

```rust
pub(crate) fn written_in(language: Option<&str>) -> String {
```

- [ ] **Step 3: The lines**

Put this above the tests in `lines.rs`:

```rust
//! A meeting's text: where the live worker cuts a growing track, the echo
//! rule, lines in time order, the speakers of the Others track, paragraphs,
//! and the transcript the AI writes the notes from.

use std::collections::HashSet;

use serde::Serialize;

use super::store::{Line, Track};
use crate::audio::quiet_cut;
use crate::file_transcribe::{self, NONE_FOUND};
use crate::speakers::{assign, Turn};
use crate::whisper_engine::Segment;

/// A piece of a track is at least this long...
pub const PIECE_MIN_SECS: f32 = 15.0;
/// ...and at most this long; it ends in the quietest spot in between.
pub const PIECE_MAX_SECS: f32 = 30.0;
/// Before 30 s, a piece ends only in a pause: the 300 ms around the cut
/// this quiet (RMS), the level `audio::speech_spans` calls silence.
const PAUSE_RMS: f32 = 0.005;
/// A "You" line is an echo when this share of its words is in the Others
/// lines of the same moment.
pub const ECHO_SHARE: f32 = 0.7;
/// The two tracks' times this close count as the same moment (Whisper's
/// times are rough, and the echo comes a little later).
const ECHO_SLACK_MS: u64 = 1_000;

const RATE: f32 = 16_000.0;

/// How much of `pending` (16 kHz mono: a track's audio not transcribed
/// yet) the next piece takes, or `None` to wait for more. A piece runs 15
/// to 30 s and ends in a pause; once 30 s are there it ends in the
/// quietest spot. `last` (the recording ended) takes a rest under 30 s
/// whole.
pub fn next_piece(pending: &[f32], last: bool) -> Option<usize> {
    let min = (PIECE_MIN_SECS * RATE) as usize;
    let max = (PIECE_MAX_SECS * RATE) as usize;
    if pending.is_empty() {
        return None;
    }
    if pending.len() <= max && last {
        return Some(pending.len());
    }
    if pending.len() < min {
        return None;
    }
    let to_secs = pending.len().min(max) as f32 / RATE;
    let cut = quiet_cut(pending, PIECE_MIN_SECS, to_secs);
    (pending.len() >= max || is_pause(pending, cut)).then_some(cut)
}

/// Whether the 300 ms around `at` are silent.
fn is_pause(audio: &[f32], at: usize) -> bool {
    const HALF: usize = 2_400;
    if at < HALF || at + HALF > audio.len() {
        return false;
    }
    let window = &audio[at - HALF..at + HALF];
    (window.iter().map(|s| s * s).sum::<f32>() / window.len() as f32).sqrt() < PAUSE_RMS
}

/// The words of a line in lower case, without punctuation.
fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).collect()
}

fn same_moment(a: &Line, b: &Line) -> bool {
    a.start_ms < b.end_ms + ECHO_SLACK_MS && b.start_ms < a.end_ms + ECHO_SLACK_MS
}

/// A "You" line whose words largely repeat what the others said at the same
/// moment: the microphone picked up the PC's speakers.
pub fn is_echo(you: &Line, lines: &[Line]) -> bool {
    if you.track != Track::You {
        return false;
    }
    let heard: HashSet<String> = lines
        .iter()
        .filter(|o| o.track == Track::Others && same_moment(you, o))
        .flat_map(|o| words(&o.text))
        .collect();
    let mine = words(&you.text);
    if mine.is_empty() || heard.is_empty() {
        return false;
    }
    let repeated = mine.iter().filter(|w| heard.contains(*w)).count();
    repeated as f32 >= ECHO_SHARE * mine.len() as f32
}

/// Add `new` lines in time order and drop "You" lines that are echoes.
/// Returns how many echoes were dropped.
pub fn add_lines(lines: &mut Vec<Line>, new: Vec<Line>) -> usize {
    lines.extend(new);
    lines.sort_by_key(|l| (l.start_ms, l.end_ms));
    let echo: Vec<bool> = lines.iter().map(|l| is_echo(l, lines)).collect();
    let before = lines.len();
    let mut i = 0;
    lines.retain(|_| {
        i += 1;
        !echo[i - 1]
    });
    before - lines.len()
}

/// Give the Others lines the speakers of a separation of `others.wav` (see
/// `speakers::assign`) and return how many there are; `NONE_FOUND` when it
/// found no voices (the lines stay "Others").
pub fn label_others(lines: &mut [Line], turns: &[Turn]) -> Result<u8, String> {
    if turns.is_empty() {
        return Err(NONE_FOUND.to_string());
    }
    let others: Vec<usize> = (0..lines.len()).filter(|&i| lines[i].track == Track::Others).collect();
    let spans: Vec<(u64, u64)> = others.iter().map(|&i| (lines[i].start_ms, lines[i].end_ms)).collect();
    for (&i, speaker) in others.iter().zip(assign(&spans, turns)) {
        lines[i].speaker = speaker;
    }
    Ok(lines.iter().filter_map(|l| l.speaker).max().map_or(0, |m| m + 1))
}

/// Who says a line, as a number `file_transcribe::paragraphs` tells apart:
/// 0 You, 1 the others before the speakers are known, 2 + n Speaker n+1.
pub fn who(line: &Line) -> u8 {
    match (line.track, line.speaker) {
        (Track::You, _) => 0,
        (Track::Others, None) => 1,
        (Track::Others, Some(n)) => n.saturating_add(2),
    }
}

/// The lines as Whisper segments with `who` as the speaker.
pub fn segments(lines: &[Line]) -> Vec<Segment> {
    lines
        .iter()
        .map(|l| Segment { start_ms: l.start_ms, end_ms: l.end_ms, text: l.text.clone(), speaker: Some(who(l)) })
        .collect()
}

/// A paragraph of the meeting view.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParagraphView {
    pub start_ms: u64,
    pub track: Track,
    /// Others after the separation: 0 = Speaker 1.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<u8>,
    pub text: String,
}

/// The lines in paragraphs as in the Files tab: a new one after a pause, at
/// a change of track or speaker, or at a sentence end once it is long.
pub fn paragraphs(lines: &[Line]) -> Vec<ParagraphView> {
    file_transcribe::paragraphs(&segments(lines))
        .into_iter()
        .map(|p| {
            let who = p.speaker.unwrap_or(0);
            ParagraphView {
                start_ms: p.start_ms,
                track: if who == 0 { Track::You } else { Track::Others },
                speaker: who.checked_sub(2),
                text: p.text,
            }
        })
        .collect()
}

/// The first paragraph of `new` that the view showing `old` has to redraw.
pub fn changed_from(old: &[ParagraphView], new: &[ParagraphView]) -> usize {
    old.iter().zip(new).take_while(|(a, b)| a == b).count()
}

/// The transcript for the AI: "[4:05] You: …" paragraphs, the others as
/// "Others" or by their speaker names.
pub fn transcript(lines: &[Line], speaker_names: &[String]) -> String {
    let speakers = lines.iter().filter_map(|l| l.speaker).max().map_or(0, |m| m as usize + 1);
    let mut names = vec!["You".to_string(), "Others".to_string()];
    names.extend((0..speakers).map(|n| file_transcribe::speaker_name(speaker_names, n as u8)));
    file_transcribe::format(&segments(lines), &names, true)
}
```

- [ ] **Step 4: The notes prompt and parser**

Put this above the tests in `notes.rs`:

```rust
//! The AI's notes on a meeting: Summary, Decisions and Action items. The
//! model answers under three fixed English headings, in the meeting's
//! language; `parse` reads them back, tolerant of Markdown variations.

use super::store::{ActionItem, Notes};
use crate::file_transcribe::written_in;

/// Instructions for the notes of a meeting (or of notes on its parts).
pub fn meeting_prompt(language: Option<&str>) -> String {
    format!(
        "You write the notes of a meeting from its transcript. \"You\" is the person who recorded it; \
         the others are \"Others\" or \"Speaker 1\", \"Speaker 2\" and so on, or their names. {} \
         Answer with exactly these three sections, each starting with its heading on a line of its \
         own, the headings in English exactly as written here:\n\
         ## Summary\n\
         Two to four sentences on what the meeting was about and what came out of it.\n\
         ## Decisions\n\
         What was decided, one per line, starting with \"- \".\n\
         ## Action items\n\
         Who does what by when, one per line, starting with \"- \", as far as the transcript says.\n\
         Leave a section empty when the transcript has nothing for it. Use only what the transcript \
         says, never invent anything. No other headings, no introduction, no closing remarks.",
        written_in(language)
    )
}

#[derive(Clone, Copy, PartialEq)]
enum Section {
    Before,
    Summary,
    Decisions,
    Actions,
}

/// The section a line names: "## Summary", "**Decisions:**", "Action items".
fn heading(line: &str) -> Option<Section> {
    let name = line.trim_start_matches(['#', '*', ' ']).trim_end_matches(['*', ':', ' ']).trim().to_lowercase();
    match name.as_str() {
        "summary" => Some(Section::Summary),
        "decisions" | "decision" => Some(Section::Decisions),
        "action items" | "action item" | "actions" => Some(Section::Actions),
        _ => None,
    }
}

/// What models write for an empty section.
fn is_nothing(text: &str) -> bool {
    let t = text.trim().trim_end_matches('.').trim().to_lowercase();
    matches!(t.as_str(), "" | "none" | "none mentioned" | "nothing" | "n/a" | "-" | "keine" | "nichts" | "keine erwähnt")
}

/// A list line without its "- ", "* ", "• " or "1. " in front; `None` when
/// it says there is nothing.
fn item(line: &str) -> Option<String> {
    let mut text = line.trim();
    if let Some(rest) = text.strip_prefix(['-', '*', '•']) {
        text = rest;
    } else {
        let digits = text.chars().take_while(char::is_ascii_digit).count();
        if digits > 0 && text[digits..].starts_with(['.', ')']) {
            text = &text[digits + 1..];
        }
    }
    let text = text.trim();
    (!is_nothing(text)).then(|| text.to_string())
}

/// The model's answer as notes. A missing or empty section stays empty; an
/// answer without any heading becomes the summary.
pub fn parse(answer: &str) -> Notes {
    let mut section = Section::Before;
    let mut summary: Vec<&str> = Vec::new();
    let mut before: Vec<&str> = Vec::new();
    let mut notes = Notes::default();
    for line in answer.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if let Some(s) = heading(line) {
            section = s;
            continue;
        }
        match section {
            Section::Before => before.push(line),
            Section::Summary => summary.push(line),
            Section::Decisions => notes.decisions.extend(item(line)),
            Section::Actions => notes.action_items.extend(item(line).map(|text| ActionItem { text, done: false })),
        }
    }
    if section == Section::Before {
        summary = before;
    }
    let summary = summary.join("\n");
    notes.summary = if is_nothing(&summary) { String::new() } else { summary };
    notes
}
```

- [ ] **Step 5: Run the tests to see them pass**

```bash
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib meeting::
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib file_transcribe::
```

Expected: 24 `meeting::` tests pass (14 new: `lines` 9, `notes` 5); the 10 `file_transcribe::` tests still pass.

- [ ] **Step 6: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/meeting/mod.rs src-tauri/src/meeting/lines.rs src-tauri/src/meeting/notes.rs src-tauri/src/file_transcribe.rs
git commit -F - <<'EOF'
feat: meeting pieces, the echo rule, Others speakers, paragraphs and the notes parser

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: Audio in and out: the capture and ▶ playback

**Files:**
- Create: `src-tauri/src/meeting/capture.rs`, `src-tauri/src/meeting/playback.rs`
- Modify: `src-tauri/src/meeting/mod.rs`, `src-tauri/src/soundboard/engine.rs` (three items become `pub(crate)`)
- Test: `capture.rs`, `playback.rs` (`mod tests`); the devices themselves in the live checks

**Interfaces:**
- Consumes: `wav::{TrackFile, RATE, read_range}`, `store::{Track, YOU_WAV, OTHERS_WAV}` (Task 1); `audio::lock`; `soundboard::engine::{boost_this_thread, find_device, MmcssGuard}` (made `pub(crate)` here).
- Produces (`rudariflow_lib::meeting::capture`):
  - `pub const RETRY: Duration` (3 s), `pub const NO_PC_SOUND_AFTER: Duration` (30 s)
  - `pub enum Warning { MicLost, PcLost, NoPcSound }` (serde camelCase: `"micLost"`, `"pcLost"`, `"noPcSound"`)
  - `pub struct Resampler`: `Resampler::new(from: u32, to: u32)`, `push(&mut self, input: &[f32], out: &mut Vec<f32>)`
  - `pub fn to_append(new: &mut Vec<f32>, written: u64, expected: u64, max: u64) -> Vec<f32>`
  - `pub fn loopback_override() -> Option<String>`, `pub fn override_from(test_commands: Option<&str>, device: Option<&str>) -> Option<String>`
  - `pub struct Written` with `get(&self, track: Track) -> u64`
  - `pub struct Setup { microphone: String, loopback: Option<String>, you: PathBuf, others: PathBuf, max_samples: u64 }`, `pub type Report = Box<dyn Fn(Warning, bool) + Send>`
  - `pub struct Capture { pub written: Arc<Written>, .. }`: `Capture::start(setup: Setup, report: Report, on_limit: Box<dyn FnOnce() + Send>) -> Result<Capture, String>`, `stop(self) -> u64` (samples of the longer track)
- Produces (`rudariflow_lib::meeting::playback`):
  - `pub type Source = Box<dyn FnMut(usize) -> Option<Vec<f32>> + Send>`
  - `pub fn mix(a: &[f32], b: &[f32]) -> Vec<f32>`, `pub fn meeting_source(dir: &Path, from_ms: u64) -> Source`, `pub fn samples_source(samples: Vec<f32>) -> Source`
  - `pub struct Player`: `Player::start(source: Source, device: Option<String>, ended: Box<dyn FnOnce() + Send>) -> Result<Player, String>`, `is_finished(&self) -> bool`, `stop(self)`

- [ ] **Step 1: Failing tests**

In `src-tauri/src/meeting/mod.rs`, replace the module list with:

```rust
pub mod capture;
pub mod lines;
pub mod notes;
pub mod playback;
pub mod store;
pub mod wav;
```

Create `src-tauri/src/meeting/capture.rs` with only its tests for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn whole(input: &[f32], from: u32, to: u32) -> Vec<f32> {
        let mut out = Vec::new();
        Resampler::new(from, to).push(input, &mut out);
        out
    }

    #[test]
    fn a_track_resampled_in_seconds_is_the_track_resampled_at_once() {
        let input: Vec<f32> = (0..48_000 * 3).map(|i| ((i as f32) * 0.01).sin()).collect();
        let at_once = whole(&input, 48_000, 16_000);
        assert_eq!(at_once.len(), 48_000);
        let mut chunked = Vec::new();
        let mut r = Resampler::new(48_000, 16_000);
        // Uneven chunks, as the callbacks deliver them.
        for chunk in input.chunks(47_917) {
            r.push(chunk, &mut chunked);
        }
        assert_eq!(chunked.len(), at_once.len());
        for (a, b) in chunked.iter().zip(&at_once) {
            assert!((a - b).abs() < 1e-5, "{} vs {}", a, b);
        }
        // 44.1 kHz: 3 s become 3 s.
        let mut out = Vec::new();
        let mut r = Resampler::new(44_100, 16_000);
        for chunk in vec![0.5f32; 44_100 * 3].chunks(4_410) {
            r.push(chunk, &mut out);
        }
        assert!((out.len() as i64 - 48_000).abs() <= 1, "{}", out.len());
        assert!(out.iter().all(|&s| (s - 0.5).abs() < 1e-6), "a level stays");
        assert_eq!(whole(&[0.1, 0.2, 0.3], 16_000, 16_000), [0.1, 0.2, 0.3], "same rate");
    }

    #[test]
    fn a_track_behind_the_clock_gets_silence_and_none_past_the_limit() {
        // On time (a little behind is normal): only the new audio.
        let mut new = vec![0.2; 16_000];
        assert_eq!(to_append(&mut new, 16_000, 32_100, 1_000_000).len(), 16_000);
        assert!(new.is_empty(), "taken");
        // The loopback sent nothing for 2 s: silence up to the clock.
        let mut new = Vec::new();
        let out = to_append(&mut new, 16_000, 48_000, 1_000_000);
        assert_eq!(out.len(), 32_000);
        assert!(out.iter().all(|&s| s == 0.0));
        // Half a second of sound, then the rest silent.
        let mut new = vec![0.2; 8_000];
        let out = to_append(&mut new, 0, 32_000, 1_000_000);
        assert_eq!((out.len(), out[7_999], out[8_000]), (32_000, 0.2, 0.0));
        // Ahead of the clock: nothing is cut.
        let mut new = vec![0.2; 16_000];
        assert_eq!(to_append(&mut new, 40_000, 48_000, 1_000_000).len(), 16_000);
        // At 4 hours the track ends.
        let mut new = vec![0.2; 16_000];
        assert_eq!(to_append(&mut new, 990_000, 1_006_000, 1_000_000).len(), 10_000);
        let mut new = vec![0.2; 16_000];
        assert!(to_append(&mut new, 1_000_000, 1_016_000, 1_000_000).is_empty());
    }

    #[test]
    fn the_loopback_override_is_for_test_instances_only() {
        let cable = Some("CABLE Input (VB-Audio Virtual Cable)");
        assert_eq!(override_from(Some("1"), cable).as_deref(), cable);
        assert_eq!(override_from(None, cable), None, "a normal start ignores it");
        assert_eq!(override_from(Some("0"), cable), None);
        assert_eq!(override_from(Some("1"), Some("  ")), None);
        assert_eq!(override_from(Some("1"), None), None);
    }

    #[test]
    fn lost_devices_name_their_track() {
        assert_eq!(lost_warning(Track::You), Warning::MicLost);
        assert_eq!(lost_warning(Track::Others), Warning::PcLost);
        assert_eq!(serde_json::to_string(&Warning::NoPcSound).unwrap(), "\"noPcSound\"");
    }
}
```

Create `src-tauri/src/meeting/playback.rs` with only its tests for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::wav::TrackFile;

    #[test]
    fn both_tracks_play_together_from_a_paragraph() {
        assert_eq!(mix(&[0.5, 0.5, 0.5], &[0.25, 0.75]), [0.75, 1.0, 0.5], "clipped, the shorter ends in silence");
        let dir = std::env::temp_dir().join("rudariflow_meeting_play");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut you = TrackFile::create(&dir.join(YOU_WAV)).unwrap();
        you.append(&vec![0.25; 32_000]).unwrap();
        you.finish().unwrap();
        let mut others = TrackFile::create(&dir.join(OTHERS_WAV)).unwrap();
        others.append(&vec![0.0; 16_000]).unwrap();
        others.append(&vec![0.5; 16_000]).unwrap();
        others.finish().unwrap();
        // From 1.5 s: half a second of both, then the end.
        let mut source = meeting_source(&dir, 1_500);
        let chunk = source(16_000).unwrap();
        assert_eq!(chunk.len(), 8_000);
        assert!(chunk.iter().all(|s| (s - 0.75).abs() < 1e-3), "{}", chunk[0]);
        assert_eq!(source(16_000), None);
    }

    #[test]
    fn samples_play_in_chunks_to_their_end() {
        let mut source = samples_source(vec![0.1; 10]);
        assert_eq!(source(4).unwrap().len(), 4);
        assert_eq!(source(4).unwrap().len(), 4);
        assert_eq!(source(4).unwrap().len(), 2);
        assert_eq!(source(4), None);
    }
}
```

Run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib meeting::` (from `src-tauri`). Expected: compile errors (`Resampler`, `to_append`, `override_from`, `meeting_source`, … not found).

- [ ] **Step 2: Share the soundboard's MMCSS boost and device lookup**

In `src-tauri/src/soundboard/engine.rs` (no other change):

1. Both `struct MmcssGuard` definitions (the `#[cfg(windows)]` one, `struct MmcssGuard(windows_sys::Win32::Foundation::HANDLE);`, and the `#[cfg(not(windows))]` one, `struct MmcssGuard;`) become `pub(crate) struct MmcssGuard…`.
2. Both `fn boost_this_thread() -> (u8, Option<MmcssGuard>)` definitions become `pub(crate) fn boost_this_thread…`.
3. `fn find_device(host: &cpal::Host, name: &str, input: bool) -> Option<cpal::Device>` becomes `pub(crate) fn find_device…`.

- [ ] **Step 3: The capture**

Put this above the tests in `capture.rs`:

```rust
//! Recording a meeting: the microphone and WASAPI loopback of Windows'
//! default output (what the PC plays), each its own shared-mode cpal
//! stream. The callbacks only copy into a buffer; the "rf-meeting-capture"
//! thread converts both to 16 kHz mono and appends them to `you.wav` and
//! `others.wav` every second, fills silence where a track fell behind the
//! clock (the loopback sends nothing while the PC is quiet), moves the
//! loopback to a new default output, and reopens a lost device every 3 s.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

use super::store::Track;
use super::wav::{TrackFile, RATE};
use crate::audio::lock;
use crate::soundboard::engine::{boost_this_thread, find_device, MmcssGuard};
use crate::startup_log;

const TICK: Duration = Duration::from_millis(250);
const WRITE_EVERY: Duration = Duration::from_secs(1);
/// A lost device is tried again this often, and the default output is
/// looked at as often.
pub const RETRY: Duration = Duration::from_secs(3);
/// The callbacks' buffer holds this much, so a slow write or a device that
/// takes long to open loses nothing.
const INBOX_SECS: u32 = 30;
/// A track further behind the clock than this gets silence.
const SLACK: u64 = RATE as u64 / 2;
/// No PC sound by then: the bar asks whether the call plays on this PC.
pub const NO_PC_SOUND_AFTER: Duration = Duration::from_secs(30);
/// Quieter than this is silence.
const HEARD: f32 = 0.001;

/// What the meeting bar warns about while it records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Warning {
    /// "Microphone lost — retrying"
    MicLost,
    /// "PC sound lost — retrying"
    PcLost,
    /// "No sound from the PC yet — is the call playing on this PC?"
    NoPcSound,
}

fn lost_warning(track: Track) -> Warning {
    match track {
        Track::You => Warning::MicLost,
        Track::Others => Warning::PcLost,
    }
}

/// Linear interpolation from one rate to another, in chunks: the position
/// carries over from one chunk to the next, so a track cut into seconds
/// comes out as long as it would in one go.
pub struct Resampler {
    ratio: f64,
    /// Where the next output sample lies, in input samples from the start
    /// of the next chunk (-1 … 0: between the last chunk's end and it).
    pos: f64,
    prev: f32,
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Resampler {
        Resampler { ratio: from as f64 / to as f64, pos: 0.0, prev: 0.0 }
    }

    /// Convert the next `input` and append it to `out`.
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        let last = (input.len() - 1) as f64;
        while self.pos <= last {
            let i = self.pos.floor();
            let frac = (self.pos - i) as f32;
            let a = if i < 0.0 { self.prev } else { input[i as usize] };
            let b = input.get((i + 1.0) as usize).copied().unwrap_or(a);
            out.push(a + (b - a) * frac);
            self.pos += self.ratio;
        }
        self.pos -= input.len() as f64;
        self.prev = input[input.len() - 1];
    }
}

/// What one write appends to a track: its new audio, then silence up to
/// the clock when it is more than `SLACK` behind, never past `max`.
pub fn to_append(new: &mut Vec<f32>, written: u64, expected: u64, max: u64) -> Vec<f32> {
    let mut out = std::mem::take(new);
    let have = written + out.len() as u64;
    if expected > have + SLACK {
        out.resize(out.len() + (expected - have) as usize, 0.0);
    }
    out.truncate(max.saturating_sub(written) as usize);
    out
}

/// The test-only stand-in for "what the PC plays": the output device
/// `RUDARIFLOW_MEETING_LOOPBACK` names, honoured only with
/// RUDARIFLOW_TEST_COMMANDS=1. The live checks point it at the virtual
/// cable, so their test audio never plays on the user's speakers.
pub fn loopback_override() -> Option<String> {
    override_from(
        std::env::var("RUDARIFLOW_TEST_COMMANDS").ok().as_deref(),
        std::env::var("RUDARIFLOW_MEETING_LOOPBACK").ok().as_deref(),
    )
}

pub fn override_from(test_commands: Option<&str>, device: Option<&str>) -> Option<String> {
    let device = device.map(str::trim).filter(|d| !d.is_empty())?;
    (test_commands == Some("1")).then(|| device.to_string())
}

/// How many samples of each track are on disk.
#[derive(Debug, Default)]
pub struct Written([AtomicU64; 2]);

impl Written {
    pub fn get(&self, track: Track) -> u64 {
        self.0[track.index()].load(SeqCst)
    }

    fn set(&self, track: Track, samples: u64) {
        self.0[track.index()].store(samples, SeqCst);
    }
}

/// What to record where.
pub struct Setup {
    /// The Recording setting's microphone ("default" = Windows' default).
    pub microphone: String,
    /// `loopback_override()`; `None` = Windows' default output.
    pub loopback: Option<String>,
    pub you: PathBuf,
    pub others: PathBuf,
    /// The meeting stops at this many samples (4 hours).
    pub max_samples: u64,
}

/// A warning comes (`true`) or goes (`false`).
pub type Report = Box<dyn Fn(Warning, bool) + Send>;

pub struct Capture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<u64>>,
    pub written: Arc<Written>,
}

impl Capture {
    /// Create both WAV files and start recording. A device that does not
    /// open is reported and tried again; the other track records anyway.
    /// `on_limit` is called once `max_samples` are recorded.
    pub fn start(setup: Setup, report: Report, on_limit: Box<dyn FnOnce() + Send>) -> Result<Capture, String> {
        let files = [TrackFile::create(&setup.you)?, TrackFile::create(&setup.others)?];
        let stop = Arc::new(AtomicBool::new(false));
        let written = Arc::new(Written::default());
        let (s, w) = (stop.clone(), written.clone());
        let thread = std::thread::Builder::new()
            .name("rf-meeting-capture".into())
            .spawn(move || run(setup, files, s, w, report, on_limit))
            .map_err(|e| e.to_string())?;
        Ok(Capture { stop, thread: Some(thread), written })
    }

    /// Stop, write what is left and the WAV headers. Returns the samples of
    /// the longer track.
    pub fn stop(mut self) -> u64 {
        self.stop.store(true, SeqCst);
        self.thread.take().map_or(0, |t| t.join().unwrap_or(0))
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// The callbacks' side: mono samples at the device's rate.
struct Inbox {
    samples: Mutex<Vec<f32>>,
    failed: AtomicBool,
}

/// An open stream of one track.
struct Input {
    _stream: cpal::Stream,
    inbox: Arc<Inbox>,
    /// Swapped with the inbox's buffer, so neither side allocates.
    spare: Vec<f32>,
    resampler: Resampler,
    device: String,
}

impl Input {
    /// Move what the callbacks collected to `out` at 16 kHz.
    fn drain(&mut self, out: &mut Vec<f32>) {
        std::mem::swap(&mut *lock(&self.inbox.samples), &mut self.spare);
        self.resampler.push(&self.spare, out);
        self.spare.clear();
    }
}

fn mic_device(host: &cpal::Host, name: &str) -> Result<cpal::Device, String> {
    let device = if name.is_empty() || name == "default" { host.default_input_device() } else { find_device(host, name, true) };
    device.ok_or_else(|| format!("microphone '{}' not found", name))
}

fn pc_device(host: &cpal::Host, name: Option<&str>) -> Result<cpal::Device, String> {
    match name {
        Some(name) => find_device(host, name, false).ok_or_else(|| format!("output '{}' not found", name)),
        None => host.default_output_device().ok_or_else(|| "no default output".to_string()),
    }
}

fn default_output_name(host: &cpal::Host) -> Option<String> {
    host.default_output_device().and_then(|d| d.name().ok())
}

/// Open a track's stream: the microphone, or loopback of the output.
fn open(host: &cpal::Host, track: Track, setup: &Setup) -> Result<Input, String> {
    let (device, loopback) = match track {
        Track::You => (mic_device(host, &setup.microphone)?, false),
        Track::Others => (pc_device(host, setup.loopback.as_deref())?, true),
    };
    let name = device.name().unwrap_or_default();
    let config = if loopback { device.default_output_config() } else { device.default_input_config() }
        .map_err(|e| format!("{}: {}", name, e))?;
    if config.sample_format() != cpal::SampleFormat::F32 {
        return Err(format!("{}: unsupported sample format {:?}", name, config.sample_format()));
    }
    let channels = config.channels().max(1) as usize;
    let rate = config.sample_rate().0;
    let capacity = (rate * INBOX_SECS) as usize;
    let inbox = Arc::new(Inbox { samples: Mutex::new(Vec::with_capacity(capacity)), failed: AtomicBool::new(false) });
    let (data, errors) = (inbox.clone(), inbox.clone());
    let mut boost: Option<Option<MmcssGuard>> = None;
    let stream = device
        .build_input_stream(
            &config.config(),
            move |input: &[f32], _: &cpal::InputCallbackInfo| {
                // Real time: no allocation (the buffer has its capacity), no
                // logging, no file I/O; a full buffer drops the rest.
                if boost.is_none() {
                    boost = Some(boost_this_thread().1);
                }
                let mut buf = lock(&data.samples);
                let room = buf.capacity() - buf.len();
                for frame in input.chunks_exact(channels).take(room) {
                    buf.push(frame.iter().sum::<f32>() / channels as f32);
                }
            },
            move |_| errors.failed.store(true, SeqCst),
            None,
        )
        .map_err(|e| format!("{}: {}", name, e))?;
    stream.play().map_err(|e| format!("{}: {}", name, e))?;
    Ok(Input { _stream: stream, inbox, spare: Vec::with_capacity(capacity), resampler: Resampler::new(rate, RATE), device: name })
}

fn run(
    setup: Setup,
    mut files: [TrackFile; 2],
    stop: Arc<AtomicBool>,
    written: Arc<Written>,
    report: Report,
    on_limit: Box<dyn FnOnce() + Send>,
) -> u64 {
    let host = cpal::default_host();
    let started = Instant::now();
    let mut inputs: [Option<Input>; 2] = [None, None];
    let mut retry_at = [started; 2];
    let mut lost = [false; 2];
    let mut new: [Vec<f32>; 2] = [Vec::new(), Vec::new()];
    let mut next_write = started + WRITE_EVERY;
    let mut next_default_check = started + RETRY;
    let mut heard_pc = false;
    let mut no_pc_shown = false;
    let mut write_failed = false;
    let mut on_limit = Some(on_limit);
    let tracks = [Track::You, Track::Others];
    loop {
        let stopping = stop.load(SeqCst);
        let now = Instant::now();
        if !stopping {
            let moved_to = if setup.loopback.is_none() && now >= next_default_check {
                next_default_check = now + RETRY;
                default_output_name(&host)
            } else {
                None
            };
            for track in tracks {
                let i = track.index();
                let failed = inputs[i].as_ref().is_some_and(|input| input.inbox.failed.load(SeqCst));
                let moved = track == Track::Others
                    && moved_to.as_ref().is_some_and(|name| inputs[i].as_ref().is_some_and(|input| &input.device != name));
                if failed || moved {
                    if let Some(mut input) = inputs[i].take() {
                        input.drain(&mut new[i]);
                        startup_log::log(&format!(
                            "[meeting] {} {}",
                            input.device,
                            if failed { "failed" } else { "is no longer the default output" }
                        ));
                    }
                    if failed {
                        retry_at[i] = now + RETRY;
                        if !lost[i] {
                            lost[i] = true;
                            report(lost_warning(track), true);
                        }
                    } else {
                        retry_at[i] = now;
                    }
                }
                if inputs[i].is_none() && now >= retry_at[i] {
                    match open(&host, track, &setup) {
                        Ok(input) => {
                            startup_log::log(&format!("[meeting] {:?} track: {}", track, input.device));
                            inputs[i] = Some(input);
                            if lost[i] {
                                lost[i] = false;
                                report(lost_warning(track), false);
                            }
                        }
                        Err(e) => {
                            retry_at[i] = now + RETRY;
                            if !lost[i] {
                                lost[i] = true;
                                startup_log::log(&format!("[meeting] {:?} track not open: {}", track, e));
                                report(lost_warning(track), true);
                            }
                        }
                    }
                }
            }
        }
        if stopping || now >= next_write {
            next_write = now + WRITE_EVERY;
            let expected = ((now - started).as_millis() as u64 * RATE as u64 / 1000).min(setup.max_samples);
            for track in tracks {
                let i = track.index();
                if let Some(input) = inputs[i].as_mut() {
                    input.drain(&mut new[i]);
                }
                if track == Track::Others && !heard_pc {
                    heard_pc = new[i].iter().any(|s| s.abs() > HEARD);
                }
                let append = to_append(&mut new[i], files[i].samples(), expected, setup.max_samples);
                if let Err(e) = files[i].append(&append) {
                    if !write_failed {
                        write_failed = true;
                        startup_log::log(&format!("[meeting] writing {:?} failed: {}", track, e));
                    }
                }
                written.set(track, files[i].samples());
            }
            let silent_too_long = !heard_pc && now - started >= NO_PC_SOUND_AFTER;
            if silent_too_long != no_pc_shown {
                no_pc_shown = silent_too_long;
                report(Warning::NoPcSound, silent_too_long);
            }
            if expected >= setup.max_samples {
                if let Some(limit) = on_limit.take() {
                    startup_log::log("[meeting] 4 hours recorded: stopping");
                    limit();
                }
            }
        }
        if stopping {
            break;
        }
        std::thread::sleep(TICK);
    }
    drop(inputs);
    let mut longest = 0;
    for (track, file) in tracks.iter().zip(files.iter_mut()) {
        if let Err(e) = file.finish() {
            startup_log::log(&format!("[meeting] {:?} header not written: {}", track, e));
        }
        longest = longest.max(file.samples());
    }
    longest
}
```

Notes for the implementer:
- `Inbox.samples` gets its capacity (30 s at the device rate) before the stream starts; the callback pushes only while there is room, so it never allocates. `Input::drain` swaps the inbox's buffer with `spare` (same capacity) under the lock, so the writer never allocates under it either.
- The loopback sends nothing while the PC is silent; `to_append` fills the track with silence up to the clock (more than 0.5 s behind), so `you.wav` and `others.wav` stay in step and both track the meeting's real time.

- [ ] **Step 4: ▶ playback**

Put this above the tests in `playback.rs`:

```rust
//! ▶ in a meeting: both tracks mixed, from a paragraph on, on Windows'
//! default output (in the live checks on the test override's device). A
//! reader thread keeps about a second ready; the callback only copies.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::capture::Resampler;
use super::store::{OTHERS_WAV, YOU_WAV};
use super::wav::{self, RATE};
use crate::audio::lock;
use crate::soundboard::engine::{boost_this_thread, find_device, MmcssGuard};

/// 16 kHz mono audio, `n` samples at a time; `None` at the end.
pub type Source = Box<dyn FnMut(usize) -> Option<Vec<f32>> + Send>;

/// A quarter second per read.
const CHUNK: usize = RATE as usize / 4;

/// Two tracks played together (the shorter one ends in silence).
pub fn mix(a: &[f32], b: &[f32]) -> Vec<f32> {
    (0..a.len().max(b.len()))
        .map(|i| (a.get(i).copied().unwrap_or(0.0) + b.get(i).copied().unwrap_or(0.0)).clamp(-1.0, 1.0))
        .collect()
}

/// Both tracks of the meeting in `dir`, mixed, from `from_ms` on.
pub fn meeting_source(dir: &Path, from_ms: u64) -> Source {
    let (you, others) = (dir.join(YOU_WAV), dir.join(OTHERS_WAV));
    let mut at = from_ms * (RATE as u64 / 1000);
    Box::new(move |n| {
        let a = wav::read_range(&you, at, at + n as u64).unwrap_or_default();
        let b = wav::read_range(&others, at, at + n as u64).unwrap_or_default();
        if a.is_empty() && b.is_empty() {
            return None;
        }
        at += n as u64;
        Some(mix(&a, &b))
    })
}

/// Samples in memory (the test command plays a file this way).
pub fn samples_source(samples: Vec<f32>) -> Source {
    let mut at = 0;
    Box::new(move |n| {
        if at >= samples.len() {
            return None;
        }
        let end = (at + n).min(samples.len());
        let chunk = samples[at..end].to_vec();
        at = end;
        Some(chunk)
    })
}

pub struct Player {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Player {
    /// Play `source` on the output `device` (`None`: Windows' default).
    /// `ended` is called once it played to the end, not after `stop`.
    pub fn start(source: Source, device: Option<String>, ended: Box<dyn FnOnce() + Send>) -> Result<Player, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let (opened, wait) = mpsc::channel();
        let s = stop.clone();
        let thread = std::thread::Builder::new()
            .name("rf-meeting-play".into())
            .spawn(move || play(source, device, s, opened, ended))
            .map_err(|e| e.to_string())?;
        match wait.recv() {
            Ok(Ok(())) => Ok(Player { stop, thread: Some(thread) }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => Err("playback stopped".to_string()),
        }
    }

    pub fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(|t| t.is_finished())
    }

    pub fn stop(mut self) {
        self.halt();
    }

    fn halt(&mut self) {
        self.stop.store(true, SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.halt();
    }
}

fn play(
    mut source: Source,
    device: Option<String>,
    stop: Arc<AtomicBool>,
    opened: mpsc::Sender<Result<(), String>>,
    ended: Box<dyn FnOnce() + Send>,
) {
    let host = cpal::default_host();
    let dev = match &device {
        Some(name) => find_device(&host, name, false),
        None => host.default_output_device(),
    };
    let Some(dev) = dev else {
        let _ = opened.send(Err(format!("output '{}' not found", device.unwrap_or_default())));
        return;
    };
    let config = match dev.default_output_config() {
        Ok(c) if c.sample_format() == cpal::SampleFormat::F32 => c,
        Ok(c) => {
            let _ = opened.send(Err(format!("unsupported sample format {:?}", c.sample_format())));
            return;
        }
        Err(e) => {
            let _ = opened.send(Err(e.to_string()));
            return;
        }
    };
    let channels = config.channels().max(1) as usize;
    let rate = config.sample_rate().0;
    let queue = Arc::new(Mutex::new(VecDeque::<f32>::with_capacity(rate as usize * 2)));
    let q = queue.clone();
    let mut boost: Option<Option<MmcssGuard>> = None;
    let stream = dev.build_output_stream(
        &config.config(),
        move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
            // Real time: only copies from the queue the reader fills.
            if boost.is_none() {
                boost = Some(boost_this_thread().1);
            }
            let mut q = lock(&q);
            for frame in data.chunks_exact_mut(channels) {
                frame.fill(q.pop_front().unwrap_or(0.0));
            }
        },
        |_| {},
        None,
    );
    let stream = match stream.map_err(|e| e.to_string()).and_then(|s| s.play().map(|_| s).map_err(|e| e.to_string())) {
        Ok(s) => s,
        Err(e) => {
            let _ = opened.send(Err(e));
            return;
        }
    };
    let _ = opened.send(Ok(()));
    let mut resampler = Resampler::new(RATE, rate);
    let mut out = Vec::new();
    let mut input_done = false;
    while !stop.load(SeqCst) {
        let queued = lock(&queue).len();
        if !input_done && queued < rate as usize {
            match source(CHUNK) {
                Some(chunk) => {
                    out.clear();
                    resampler.push(&chunk, &mut out);
                    lock(&queue).extend(out.iter().copied());
                }
                None => input_done = true,
            }
            continue;
        }
        if input_done && queued == 0 {
            drop(stream);
            ended();
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
```

- [ ] **Step 5: Run the tests to see them pass**

```bash
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib meeting::
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib soundboard::
```

Expected: 30 `meeting::` tests pass (6 new: `capture` 4, `playback` 2); the `soundboard::` tests still pass.

- [ ] **Step 6: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/meeting/mod.rs src-tauri/src/meeting/capture.rs src-tauri/src/meeting/playback.rs src-tauri/src/soundboard/engine.rs
git commit -F - <<'EOF'
feat: meeting capture of the microphone and the PC sound, and playback of both tracks

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: The Whisper priority gate and the live meeting worker

**Files:**
- Create: `src-tauri/src/whisper_gate.rs`, `src-tauri/src/meeting/worker.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/whisper_engine.rs`, `src-tauri/src/file_transcribe.rs`, `src-tauri/src/meeting/mod.rs`
- Test: `whisper_gate.rs`, `worker.rs`, `whisper_engine.rs` (`mod tests`)

**Interfaces:**
- Consumes: `lines::{next_piece, PIECE_MAX_SECS}` (Task 2); `capture::Written` (Task 3); `wav::{sample_count, read_range, RATE}`, `store::{Line, Track}` (Task 1); `whisper_engine::{WhisperEngine, FileRun, Segment, NO_MODEL}`; `audio::{lock, speech_spans}`.
- Produces (`rudariflow_lib::whisper_gate`): `pub enum Priority { Dictation = 0, Meeting = 1, File = 2 }`, `pub struct Gate`: `Gate::new()`, `enter(&self, priority: Priority) -> Pass<'_>` (Whisper is yours until the `Pass` drops), `waiting(&self) -> usize`.
- Produces (`whisper_engine`): `WhisperEngine.gate: Gate` (private); `transcribe` enters as `Dictation`, `file_block` as the run's priority; `FileRun.priority` (private); `pub fn start_meeting(&self, language: &str) -> Result<FileRun, String>` (`NO_MODEL` without a loaded model).
- Produces (`file_transcribe`): `pub fn transcribe_stretch(engine: &WhisperEngine, run: &mut FileRun, audio: &[f32], offset: usize, dictionary: &str, before: &[Segment], spelling: &dyn Fn(&str) -> String) -> Result<Vec<Segment>, String>` (`transcribe` now uses it per block).
- Produces (`rudariflow_lib::meeting::worker`):
  - `pub const PAUSED: &str = "paused"`
  - `pub trait Source { fn available(&self, track: Track) -> u64; fn read(&self, track: Track, from: u64, to: u64) -> Result<Vec<f32>, String>; }`
  - `pub trait Transcriber { fn ready(&mut self) -> bool; fn transcribe(&mut self, audio: &[f32], offset: u64, before: &[Segment]) -> Result<Vec<Segment>, String>; fn language(&self) -> String; }`
  - `pub struct Piece { track: Track, lines: Vec<Line>, done_ms: u64, language: String }`
  - `pub struct Worker`: `Worker::new(you_done_ms: u64, others_done_ms: u64, lines: &[Line])`, `done(&self, track) -> u64` (samples), `step(&mut self, source: &dyn Source, whisper: &mut dyn Transcriber, last: bool) -> Result<Option<Piece>, String>`
  - `pub struct Tracks`: `Tracks::recording(dir: PathBuf, written: Arc<Written>)`, `Tracks::saved(dir: PathBuf)` (implements `Source`)
  - `pub struct Whisper`: `Whisper::new(engine: Arc<WhisperEngine>, language: &str, dictionary: String, spelling: Box<dyn Fn(&str) -> String + Send>)` (implements `Transcriber`; drops its run when the engine is unloaded)

- [ ] **Step 1: Failing tests**

In `src-tauri/src/lib.rs`, add `pub mod whisper_gate;` after `pub mod whisper_engine;`.

Create `src-tauri/src/whisper_gate.rs` with only its tests for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Start a thread that enters with `priority` and notes when it got in;
    /// return once it waits.
    fn queue(gate: &Arc<Gate>, order: &Arc<Mutex<Vec<Priority>>>, priority: Priority) -> std::thread::JoinHandle<()> {
        let before = gate.waiting();
        let (g, o) = (gate.clone(), order.clone());
        let handle = std::thread::spawn(move || {
            let _pass = g.enter(priority);
            o.lock().unwrap().push(priority);
        });
        while gate.waiting() == before {
            std::thread::yield_now();
        }
        handle
    }

    #[test]
    fn a_dictation_goes_first_then_a_meeting_then_a_file() {
        let gate = Arc::new(Gate::new());
        let order = Arc::new(Mutex::new(Vec::new()));
        // A file block is running; a file, a meeting and a dictation arrive.
        let running = gate.enter(Priority::File);
        let handles = [
            queue(&gate, &order, Priority::File),
            queue(&gate, &order, Priority::Meeting),
            queue(&gate, &order, Priority::Dictation),
        ];
        assert!(order.lock().unwrap().is_empty(), "nobody passes the running block");
        drop(running);
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(*order.lock().unwrap(), [Priority::Dictation, Priority::Meeting, Priority::File]);
    }

    #[test]
    fn a_dictation_waits_only_for_the_piece_that_runs() {
        let gate = Arc::new(Gate::new());
        let order = Arc::new(Mutex::new(Vec::new()));
        let piece = gate.enter(Priority::Meeting);
        let next_piece = queue(&gate, &order, Priority::Meeting);
        let dictation = queue(&gate, &order, Priority::Dictation);
        drop(piece);
        dictation.join().unwrap();
        next_piece.join().unwrap();
        assert_eq!(*order.lock().unwrap(), [Priority::Dictation, Priority::Meeting]);
        // A free gate lets anyone in at once.
        drop(gate.enter(Priority::File));
        assert_eq!(gate.waiting(), 0);
    }
}
```

In `src-tauri/src/meeting/mod.rs`, add `pub mod worker;` after `pub mod wav;`, and create `src-tauri/src/meeting/worker.rs` with only its tests for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// Two tracks in memory, as far as `available` says.
    struct Fake {
        audio: [Vec<f32>; 2],
        available: [Cell<u64>; 2],
    }

    impl Fake {
        fn new(you: Vec<f32>, others: Vec<f32>) -> Fake {
            Fake { audio: [you, others], available: [Cell::new(0), Cell::new(0)] }
        }

        fn up_to(&self, you_secs: f32, others_secs: f32) {
            self.available[0].set((you_secs * 16_000.0) as u64);
            self.available[1].set((others_secs * 16_000.0) as u64);
        }
    }

    impl Source for Fake {
        fn available(&self, track: Track) -> u64 {
            self.available[track.index()].get().min(self.audio[track.index()].len() as u64)
        }

        fn read(&self, track: Track, from: u64, to: u64) -> Result<Vec<f32>, String> {
            Ok(self.audio[track.index()][from as usize..to as usize].to_vec())
        }
    }

    /// One segment per piece, named by its offset; remembers the prompts.
    #[derive(Default)]
    struct Whisperer {
        unloaded: bool,
        fail: bool,
        calls: Vec<(u64, usize, Vec<String>)>,
    }

    impl Transcriber for Whisperer {
        fn ready(&mut self) -> bool {
            !self.unloaded
        }

        fn transcribe(&mut self, audio: &[f32], offset: u64, before: &[Segment]) -> Result<Vec<Segment>, String> {
            self.calls.push((offset, audio.len(), before.iter().map(|s| s.text.clone()).collect()));
            if self.fail {
                return Err("whisper full() failed".to_string());
            }
            let start_ms = offset / 16;
            Ok(vec![Segment { start_ms, end_ms: start_ms + 1_000, text: format!("at {}", start_ms), speaker: None }])
        }

        fn language(&self) -> String {
            "de".to_string()
        }
    }

    fn talk(secs: f32, pauses_at: &[f32]) -> Vec<f32> {
        let mut audio = vec![0.3; (secs * 16_000.0) as usize];
        for &p in pauses_at {
            let at = (p * 16_000.0) as usize;
            audio[at..at + 8_000].iter_mut().for_each(|s| *s = 0.0);
        }
        audio
    }

    #[test]
    fn pieces_end_in_pauses_and_carry_the_tracks_text() {
        let source = Fake::new(talk(60.0, &[17.0, 36.0]), Vec::new());
        let mut whisper = Whisperer::default();
        let mut worker = Worker::new(0, 0, &[]);
        source.up_to(14.0, 0.0);
        assert_eq!(worker.step(&source, &mut whisper, false), Ok(None), "under 15 s");
        source.up_to(25.0, 0.0);
        let piece = worker.step(&source, &mut whisper, false).unwrap().unwrap();
        assert_eq!(piece.track, Track::You);
        assert_eq!(piece.lines[0].text, "at 0");
        assert_eq!(piece.language, "de");
        let first = worker.done(Track::You);
        assert!((17 * 16_000..17 * 16_000 + 8_000).contains(&first), "{}", first);
        assert_eq!(piece.done_ms, first / 16);
        assert_eq!(worker.step(&source, &mut whisper, false), Ok(None), "8 s left");
        source.up_to(60.0, 0.0);
        let piece = worker.step(&source, &mut whisper, false).unwrap().unwrap();
        assert_eq!(piece.lines[0].start_ms, first / 16, "times from the meeting's start");
        assert_eq!(whisper.calls[1].2, ["at 0"], "the track's text so far in the prompt");
        // The rest (under 30 s) waits for a pause, or for the end.
        assert_eq!(worker.step(&source, &mut whisper, false), Ok(None));
        let last = worker.step(&source, &mut whisper, true).unwrap().unwrap();
        assert_eq!(worker.done(Track::You), 60 * 16_000);
        assert_eq!(last.done_ms, 60_000);
        assert_eq!(worker.step(&source, &mut whisper, true), Ok(None), "all done");
    }

    #[test]
    fn the_track_further_behind_goes_first() {
        let source = Fake::new(talk(40.0, &[]), talk(40.0, &[]));
        let mut whisper = Whisperer::default();
        let mut worker = Worker::new(5_000, 0, &[]);
        source.up_to(40.0, 40.0);
        let first = worker.step(&source, &mut whisper, false).unwrap().unwrap();
        assert_eq!(first.track, Track::Others);
        assert_eq!(whisper.calls[0].0, 0);
        let second = worker.step(&source, &mut whisper, false).unwrap().unwrap();
        assert_eq!(second.track, Track::You);
        assert_eq!(whisper.calls[1].0, 5_000 * 16, "goes on where it was");
    }

    #[test]
    fn without_a_model_it_waits_and_catches_up() {
        let source = Fake::new(talk(40.0, &[]), Vec::new());
        let mut whisper = Whisperer { unloaded: true, ..Default::default() };
        let mut worker = Worker::new(0, 0, &[]);
        source.up_to(40.0, 0.0);
        assert_eq!(worker.step(&source, &mut whisper, false), Err(PAUSED.to_string()));
        assert_eq!(worker.done(Track::You), 0, "nothing taken");
        assert!(whisper.calls.is_empty());
        whisper.unloaded = false;
        assert!(worker.step(&source, &mut whisper, false).unwrap().is_some());
        assert!(worker.done(Track::You) > 0);
    }

    #[test]
    fn a_piece_whisper_fails_on_is_skipped() {
        let source = Fake::new(talk(40.0, &[]), Vec::new());
        let mut whisper = Whisperer { fail: true, ..Default::default() };
        let mut worker = Worker::new(0, 0, &[]);
        source.up_to(40.0, 0.0);
        assert_eq!(worker.step(&source, &mut whisper, false), Err("whisper full() failed".to_string()));
        assert!(worker.done(Track::You) >= 15 * 16_000, "not tried forever");
    }

    #[test]
    fn a_resumed_meeting_prompts_with_its_last_lines() {
        let lines: Vec<Line> = (0..30)
            .map(|i| Line { start_ms: i * 1_000, end_ms: i * 1_000 + 900, track: Track::You, speaker: None, text: format!("line {}", i) })
            .chain(std::iter::once(Line { start_ms: 0, end_ms: 900, track: Track::Others, speaker: None, text: "hello".into() }))
            .collect();
        let source = Fake::new(talk(60.0, &[]), Vec::new());
        let mut whisper = Whisperer::default();
        let mut worker = Worker::new(30_000, 0, &lines);
        source.up_to(60.0, 0.0);
        worker.step(&source, &mut whisper, true).unwrap().unwrap();
        let prompt = &whisper.calls[0].2;
        assert_eq!(prompt.len(), TAIL);
        assert_eq!((prompt[0].as_str(), prompt[TAIL - 1].as_str()), ("line 10", "line 29"), "only the You track's");
    }
}
```

In `src-tauri/src/whisper_engine.rs`, in `mod tests`, add before `fn language_names_and_codes_round_trip`:

```rust
    #[test]
    fn a_meeting_needs_a_loaded_model() {
        let engine = WhisperEngine::new();
        assert_eq!(engine.start_meeting("auto").err().as_deref(), Some(NO_MODEL));
    }

```

Run:

```bash
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib whisper_gate::
```

Expected: compile errors (`Gate`, `Priority`, `start_meeting`, `Worker`, … not found).

- [ ] **Step 2: The gate**

Put this above the tests in `whisper_gate.rs`:

```rust
//! Whisper does one job at a time. When several wait, this gate lets a
//! dictation go first, then a meeting piece, then a block of a file in the
//! Files tab. Nothing is interrupted: a dictation waits for the piece or
//! block that is running, and no longer.

use std::sync::{Condvar, Mutex};

use crate::audio::lock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    Dictation = 0,
    Meeting = 1,
    File = 2,
}

#[derive(Default)]
struct Waiting {
    busy: bool,
    /// Callers waiting, by priority.
    count: [usize; 3],
}

#[derive(Default)]
pub struct Gate {
    state: Mutex<Waiting>,
    turn: Condvar,
}

/// Whisper is yours until this is dropped.
pub struct Pass<'a> {
    gate: &'a Gate,
}

impl Gate {
    pub fn new() -> Gate {
        Gate::default()
    }

    /// Wait until Whisper is free and nobody of a higher priority waits.
    pub fn enter(&self, priority: Priority) -> Pass<'_> {
        let p = priority as usize;
        let mut state = lock(&self.state);
        state.count[p] += 1;
        while state.busy || state.count[..p].iter().any(|&n| n > 0) {
            state = self.turn.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        state.count[p] -= 1;
        state.busy = true;
        Pass { gate: self }
    }

    /// How many wait now (for tests).
    pub fn waiting(&self) -> usize {
        lock(&self.state).count.iter().sum()
    }
}

impl Drop for Pass<'_> {
    fn drop(&mut self) {
        lock(&self.gate.state).busy = false;
        self.gate.turn.notify_all();
    }
}
```

- [ ] **Step 3: Whisper goes through the gate**

In `src-tauri/src/whisper_engine.rs`:

1. Below the `use whisper_rs::{ … };` block add:

```rust

use crate::whisper_gate::{Gate, Priority};
```

2. In `pub struct WhisperEngine`, after `released: AtomicBool,` add:

```rust
    /// Who runs next when a dictation, a meeting and a file wait.
    gate: Gate,
```

and in `WhisperEngine::new`, after `released: AtomicBool::new(false),` add `gate: Gate::new(),`.

3. In `pub fn transcribe(…)`, replace the first line of the body, `let mut state = self.lock();`, with:

```rust
        // A dictation goes before waiting meeting pieces and file blocks.
        let _turn = self.gate.enter(Priority::Dictation);
        let mut state = self.lock();
```

4. In `pub struct FileRun`, after `pub language: String,` add:

```rust
    /// A file in the Files tab, or a meeting (see `whisper_gate`).
    priority: Priority,
```

5. Replace `start_file` with:

```rust
    /// Start transcribing a file with the loaded model.
    pub fn start_file(&self, language: &str) -> Result<FileRun, String> {
        self.start_run(language, Priority::File)
    }

    /// Start transcribing a meeting with the loaded model: its pieces go
    /// before file blocks, after dictations.
    pub fn start_meeting(&self, language: &str) -> Result<FileRun, String> {
        self.start_run(language, Priority::Meeting)
    }

    fn start_run(&self, language: &str, priority: Priority) -> Result<FileRun, String> {
        let engine = self.lock();
        let loaded = engine.loaded.as_ref().ok_or_else(|| NO_MODEL.to_string())?;
        Ok(FileRun { state: new_state(&loaded.ctx)?, language: language.to_string(), priority })
    }
```

6. Replace the doc comment of `file_block` and its first body line `let _gpu = self.lock();` so it reads:

```rust
    /// Transcribe one block of a file (or a stretch of a meeting's track)
    /// that starts `offset_ms` into it. `prompt` carries the dictionary and
    /// the text before the block. Whisper is taken for this block only, and
    /// a dictation waiting goes next (`whisper_gate`), so it waits for one
    /// block at most.
    pub fn file_block(&self, run: &mut FileRun, samples: &[f32], offset_ms: u64, prompt: &str) -> Result<Vec<Segment>, String> {
        let _turn = self.gate.enter(run.priority);
        let _gpu = self.lock();
```

The lock order is the gate, then the engine's mutex, everywhere both are taken; `ensure_loaded`, `release` and `invalidate` take only the mutex.

- [ ] **Step 4: One stretch of a recording, for files and meetings**

In `src-tauri/src/file_transcribe.rs`, in `transcribe`, replace

```rust
        let block = &audio[start..end];
        let mut new = Vec::new();
        for (from, to) in speech_spans(block, 16_000, SKIP_PAUSE_SECS) {
            let prompt = block_prompt(dictionary, segments.iter().chain(&new));
            let mut found = engine.file_block(&mut run, &block[from..to], (start + from) as u64 / 16, &prompt)?;
            for segment in &mut found {
                segment.text = spelling(&segment.text);
            }
            new.extend(found);
        }
        progress(Progress { done_ms: end as u64 / 16, total_ms, segments: &new });
```

with

```rust
        let new = transcribe_stretch(engine, &mut run, &audio[start..end], start, dictionary, &segments, &spelling)?;
        progress(Progress { done_ms: end as u64 / 16, total_ms, segments: &new });
```

and add above `/// Whisper's prompt for the next stretch: the dictionary, then the end of`:

```rust
/// Whisper on one stretch of a recording (16 kHz mono) that starts at
/// sample `offset`: silences of `SKIP_PAUSE_SECS` and more are left out,
/// each stretch of speech gets the dictionary and the end of the text
/// before it (`before`, then what this call found) in its prompt, and
/// `spelling` fixes every segment. A file's block or a meeting's piece.
pub fn transcribe_stretch(
    engine: &WhisperEngine,
    run: &mut FileRun,
    audio: &[f32],
    offset: usize,
    dictionary: &str,
    before: &[Segment],
    spelling: &dyn Fn(&str) -> String,
) -> Result<Vec<Segment>, String> {
    let mut new: Vec<Segment> = Vec::new();
    for (from, to) in speech_spans(audio, 16_000, SKIP_PAUSE_SECS) {
        let prompt = block_prompt(dictionary, before.iter().chain(&new));
        let mut found = engine.file_block(run, &audio[from..to], (offset + from) as u64 / 16, &prompt)?;
        for segment in &mut found {
            segment.text = spelling(&segment.text);
        }
        new.extend(found);
    }
    Ok(new)
}

```

(The offsets stay in samples until the division, so a file's segment times are exactly what they were.)

- [ ] **Step 5: The worker**

Put this above the tests in `worker.rs`:

```rust
//! The live transcription of a meeting: each track is cut into pieces of
//! 15–30 s that end in a pause (`lines::next_piece`), and the pieces go to
//! Whisper one by one, the track that is further behind first. While the
//! models are unloaded (Free GPU, battery) it waits, and catches up once
//! something loads them again.

use std::path::PathBuf;
use std::sync::Arc;

use super::capture::Written;
use super::lines::{next_piece, PIECE_MAX_SECS};
use super::store::{Line, Track};
use super::wav::{self, RATE};
use crate::file_transcribe;
use crate::startup_log;
use crate::whisper_engine::{FileRun, Segment, WhisperEngine, NO_MODEL};

/// Not transcribing: no model is loaded.
pub const PAUSED: &str = "paused";
/// The end of a track's text that goes into the next prompt.
const TAIL: usize = 20;

/// A meeting's audio as the worker reads it.
pub trait Source {
    /// Samples of `track` there so far.
    fn available(&self, track: Track) -> u64;
    fn read(&self, track: Track, from: u64, to: u64) -> Result<Vec<f32>, String>;
}

/// Whisper as the worker uses it.
pub trait Transcriber {
    /// Whether a model is loaded; false lets go of the run's memory too.
    fn ready(&mut self) -> bool;
    /// The segments of `audio`, which starts at sample `offset` of its
    /// track; `before` is the end of that track's text.
    fn transcribe(&mut self, audio: &[f32], offset: u64, before: &[Segment]) -> Result<Vec<Segment>, String>;
    /// The language code in use ("auto" until detected).
    fn language(&self) -> String;
}

/// What one step transcribed.
#[derive(Debug, Clone, PartialEq)]
pub struct Piece {
    pub track: Track,
    pub lines: Vec<Line>,
    /// How far this track is transcribed now.
    pub done_ms: u64,
    pub language: String,
}

pub struct Worker {
    /// Samples transcribed, per track.
    done: [u64; 2],
    tail: [Vec<Segment>; 2],
}

impl Worker {
    /// A worker that goes on where the tracks were transcribed to (0 for a
    /// new meeting), with the end of their `lines` for the prompts.
    pub fn new(you_done_ms: u64, others_done_ms: u64, lines: &[Line]) -> Worker {
        let per_ms = RATE as u64 / 1000;
        let tail = |track: Track| -> Vec<Segment> {
            let mine: Vec<&Line> = lines.iter().filter(|l| l.track == track).collect();
            mine[mine.len().saturating_sub(TAIL)..]
                .iter()
                .map(|l| Segment { start_ms: l.start_ms, end_ms: l.end_ms, text: l.text.clone(), speaker: None })
                .collect()
        };
        Worker { done: [you_done_ms * per_ms, others_done_ms * per_ms], tail: [tail(Track::You), tail(Track::Others)] }
    }

    pub fn done(&self, track: Track) -> u64 {
        self.done[track.index()]
    }

    /// Transcribe the next piece if one is ready; `last` (the recording
    /// ended) takes what is left. `Ok(None)`: nothing to do now.
    /// `Err(PAUSED)`: no model; nothing was taken. Any other error skips
    /// the piece (it is logged by the caller).
    pub fn step(&mut self, source: &dyn Source, whisper: &mut dyn Transcriber, last: bool) -> Result<Option<Piece>, String> {
        let max = (PIECE_MAX_SECS * RATE as f32) as u64;
        let mut tracks = [Track::You, Track::Others];
        tracks.sort_by_key(|t| self.done[t.index()]);
        for track in tracks {
            let i = track.index();
            let from = self.done[i];
            let available = source.available(track);
            if available <= from {
                continue;
            }
            let to = available.min(from + max);
            let pending = source.read(track, from, to)?;
            let Some(len) = next_piece(&pending, last && to == available) else {
                continue;
            };
            if !whisper.ready() {
                return Err(PAUSED.to_string());
            }
            let segments = match whisper.transcribe(&pending[..len], from, &self.tail[i]) {
                Ok(segments) => segments,
                Err(e) if e == NO_MODEL || e == PAUSED => return Err(PAUSED.to_string()),
                Err(e) => {
                    self.done[i] = from + len as u64;
                    return Err(e);
                }
            };
            self.done[i] = from + len as u64;
            self.tail[i].extend(segments.iter().cloned());
            let excess = self.tail[i].len().saturating_sub(TAIL);
            self.tail[i].drain(..excess);
            let lines = segments
                .into_iter()
                .map(|s| Line { start_ms: s.start_ms, end_ms: s.end_ms, track, speaker: None, text: s.text })
                .collect();
            return Ok(Some(Piece { track, lines, done_ms: self.done[i] / (RATE as u64 / 1000), language: whisper.language() }));
        }
        Ok(None)
    }
}

/// The meeting's WAV files: while it records, as far as the capture wrote
/// them; afterwards (Finish), as long as they are.
pub struct Tracks {
    dir: PathBuf,
    written: Option<Arc<Written>>,
}

impl Tracks {
    pub fn recording(dir: PathBuf, written: Arc<Written>) -> Tracks {
        Tracks { dir, written: Some(written) }
    }

    pub fn saved(dir: PathBuf) -> Tracks {
        Tracks { dir, written: None }
    }
}

impl Source for Tracks {
    fn available(&self, track: Track) -> u64 {
        match &self.written {
            Some(written) => written.get(track),
            None => wav::sample_count(&self.dir.join(track.wav())),
        }
    }

    fn read(&self, track: Track, from: u64, to: u64) -> Result<Vec<f32>, String> {
        wav::read_range(&self.dir.join(track.wav()), from, to)
    }
}

/// The user's Whisper model, language and dictionary, with a run of its
/// own at meeting priority (`WhisperEngine::start_meeting`).
pub struct Whisper {
    engine: Arc<WhisperEngine>,
    run: Option<FileRun>,
    language: String,
    dictionary: String,
    spelling: Box<dyn Fn(&str) -> String + Send>,
}

impl Whisper {
    pub fn new(engine: Arc<WhisperEngine>, language: &str, dictionary: String, spelling: Box<dyn Fn(&str) -> String + Send>) -> Whisper {
        Whisper { engine, run: None, language: language.to_string(), dictionary, spelling }
    }
}

impl Transcriber for Whisper {
    fn ready(&mut self) -> bool {
        if self.engine.is_loaded() {
            return true;
        }
        // Free GPU or battery: the run would keep the model's memory.
        if self.run.take().is_some() {
            startup_log::log("[meeting] Whisper unloaded: transcription paused");
        }
        false
    }

    fn transcribe(&mut self, audio: &[f32], offset: u64, before: &[Segment]) -> Result<Vec<Segment>, String> {
        if self.run.is_none() {
            self.run = Some(self.engine.start_meeting(&self.language)?);
        }
        let run = self.run.as_mut().expect("started above");
        let found =
            file_transcribe::transcribe_stretch(&self.engine, run, audio, offset as usize, &self.dictionary, before, &*self.spelling);
        self.language = run.language.clone();
        found
    }

    fn language(&self) -> String {
        self.language.clone()
    }
}
```

- [ ] **Step 6: Run the tests to see them pass**

```bash
for f in whisper_gate:: meeting:: whisper_engine:: file_transcribe::; do CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib "$f" || break; done
```

Expected: `whisper_gate::` 2 pass; `meeting::` 35 pass (5 new in `worker`); `whisper_engine::` 15 pass, 1 ignored (as before, plus `a_meeting_needs_a_loaded_model`); `file_transcribe::` 10 pass (unchanged behaviour).

- [ ] **Step 7: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/lib.rs src-tauri/src/whisper_gate.rs src-tauri/src/whisper_engine.rs src-tauri/src/file_transcribe.rs src-tauri/src/meeting/mod.rs src-tauri/src/meeting/worker.rs
git commit -F - <<'EOF'
feat: dictations go before meeting pieces, meeting pieces before file blocks; the live meeting worker

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: The `Meetings` object and the end steps

**Files:**
- Create: `src-tauri/src/meeting/finish.rs`
- Modify: `src-tauri/src/meeting/mod.rs` (the `Meetings` object), `src-tauri/src/meeting/notes.rs` (`write`), `src-tauri/src/file_transcribe.rs` (`condense`, `AI_TIMEOUT`), `src-tauri/src/main.rs` (`summarize_text` uses `condense`)
- Test: `finish.rs`, `mod.rs` (`mod tests`); `main.rs` `--bins summary`

**Interfaces:**
- Consumes: everything from Tasks 1–4; `speakers::{separate, models_ready, runtime_available, SpeakerCount, Turn}`; `llm_server::{LlmServer, Endpoint, STOPPED}` (`wait_ready(self: &Arc<Self>, model: &Path, gpu_backend: Option<String>, wait: Duration) -> Result<Endpoint, String>`, `released()`); `ai_cleanup::{complete_in, LONG_SLOT, detect_language}`; `whisper_engine::{language_name, WhisperEngine}` (`ensure_loaded`, `released`, `invalidate`); `dictionary::{apply_spelling, swiss_spelling}`; `replacements::Moment::now()`.
- Produces (`file_transcribe`): `pub const AI_TIMEOUT: Duration` (300 s), `pub async fn condense(endpoint: &Endpoint, text: &str, language: Option<&str>, progress: &mut (dyn FnMut(usize, usize) + Send)) -> Result<(String, usize), String>`
- Produces (`meeting::notes`): `pub async fn write(endpoint: &Endpoint, transcript: &str, language: Option<&str>) -> Result<Notes, String>`
- Produces (`rudariflow_lib::meeting::finish`):
  - `pub enum Step { Transcribing, Speakers, Notes }` (serde camelCase)
  - `pub fn apply_piece(meeting: &mut Meeting, piece: Piece)`
  - `pub fn run(root: &Path, meeting: &Mutex<Meeting>, worker: Worker, whisper: Option<&mut dyn Transcriber>, source: &dyn Source, speakers: impl FnOnce(&[f32]) -> Result<Vec<Turn>, String>, notes: impl FnOnce(&str, &str) -> Result<Notes, String>, on_step: &mut dyn FnMut(Step), on_lines: &mut dyn FnMut(&Meeting))`
- Produces (`rudariflow_lib::meeting`):
  - `pub const MIN_FREE_BYTES: u64` (1 GiB), `pub const MAX_MS: u64` (4 h)
  - `pub struct Recording { id, title, started_at: u64, warnings: Vec<Warning>, paused: bool }`, `pub struct Finishing { id, step: Step }`, `pub struct Status { recording: Option<Recording>, finishing: Vec<Finishing> }` (serde camelCase; `Status: Default`)
  - `pub struct MeetingView { meeting: Meeting, paragraphs: Vec<ParagraphView> }`, `pub struct Current { status: Status, meeting: Option<MeetingView> }`, `pub struct LinesChanged { id, from: usize, paragraphs: Vec<ParagraphView> }`, `pub struct Playing { id, from_ms: u64 }`
  - `pub enum Event { Status(Status), Lines(LinesChanged), Changed, Playing(Option<Playing>), Limit }`
  - `pub struct Config { microphone, whisper_model, model_path: PathBuf, gpu_backend, language, dictionary, terms: Vec<String>, swiss_spelling: bool, ai_model: Result<PathBuf, String>, german: bool, unload_after: bool }` (`Clone`, `Debug`)
  - `pub struct Meetings`: `Meetings::new(app_dir: &Path, engine: Arc<WhisperEngine>, llm: Arc<LlmServer>, events: Box<dyn Fn(Event) + Send + Sync>) -> Arc<Meetings>`, `status(&self) -> Status`, `is_recording(&self) -> bool`, `start(&self, title: Option<String>, config: Config) -> Result<String, String>`, `stop(&self) -> Result<(), String>`, `state(&self) -> Current`, `get(&self, id: &str) -> Result<MeetingView, String>`, `list(&self, query: &str) -> Vec<Summary>`, `rename(&self, id, title) -> Result<(), String>`, `rename_speaker(&self, id, speaker: u8, name) -> Result<(), String>`, `set_action_done(&self, id, index: usize, done: bool) -> Result<(), String>`, `delete(&self, id) -> Result<(), String>`, `finish(&self, id, config: Config) -> Result<(), String>`, `write_notes(&self, id, model: PathBuf, gpu_backend: String) -> Result<(), String>`, `play(&self, id, from_ms: u64) -> Result<(), String>`, `test_play(&self, samples: Vec<f32>) -> Result<(), String>`, `stop_playing(&self)`, `shutdown(&self)`
  - error codes: `"already_recording"`, `"no_model"`, `"disk_full"`, `"not_recording"`, `"no_meeting"`, `"busy"`, `"not_interrupted"`, `"recording"`, `"no_audio"`, `"no_test_device"`, `"empty_name"`, `"no_item"`; reasons kept in meeting.json: `speakersError` `"no_model"`/`"no_runtime"`/`"none_found"`/text, `notesError` `"ai_off"`/`"no_ai_model"`/`"gpu_freed"`/`"empty"`/text
  - `pub fn free_bytes(path: &Path) -> Option<u64>`

- [ ] **Step 1: Failing tests**

Create `src-tauri/src/meeting/finish.rs` with only its tests for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::store::{self, ActionItem, Line, OTHERS_WAV, YOU_WAV};
    use crate::meeting::wav::TrackFile;
    use crate::meeting::worker::Tracks;
    use crate::whisper_engine::Segment;
    use std::path::PathBuf;

    /// One segment per call, said by "you" or "others" by the audio level.
    struct Fake {
        unloaded: bool,
    }

    impl Transcriber for Fake {
        fn ready(&mut self) -> bool {
            !self.unloaded
        }

        fn transcribe(&mut self, audio: &[f32], offset: u64, _: &[Segment]) -> Result<Vec<Segment>, String> {
            let who = if audio[0] > 0.35 { "Others talk" } else { "You talk" };
            let start_ms = offset / 16;
            Ok(vec![Segment { start_ms, end_ms: start_ms + audio.len() as u64 / 16, text: who.to_string(), speaker: None }])
        }

        fn language(&self) -> String {
            "en".to_string()
        }
    }

    fn recorded(name: &str) -> (PathBuf, Mutex<Meeting>) {
        let root = std::env::temp_dir().join(format!("rudariflow_meeting_finish_{}", name));
        let _ = std::fs::remove_dir_all(&root);
        let mut m = Meeting::new("m-00000000000a", "Call", 0, 0, "small", "auto");
        m.state = State::Finishing;
        m.lines.push(Line { start_ms: 0, end_ms: 1_000, track: Track::You, speaker: None, text: "Live line.".into() });
        m.you_done_ms = 1_000;
        m.save(&root).unwrap();
        for (file, level) in [(YOU_WAV, 0.3), (OTHERS_WAV, 0.4)] {
            let mut track = TrackFile::create(&m.dir(&root).join(file)).unwrap();
            track.append(&vec![level; 20 * 16_000]).unwrap();
            track.finish().unwrap();
        }
        (root, Mutex::new(m))
    }

    #[test]
    fn stop_transcribes_the_rest_tells_the_speakers_apart_and_writes_notes() {
        let (root, meeting) = recorded("all");
        let source = Tracks::saved(meeting.lock().unwrap().dir(&root));
        let worker = { let m = meeting.lock().unwrap(); Worker::new(m.you_done_ms, m.others_done_ms, &m.lines) };
        let mut whisper = Fake { unloaded: false };
        let mut steps = Vec::new();
        let mut redraws = 0;
        let mut heard = 0;
        run(
            &root,
            &meeting,
            worker,
            Some(&mut whisper),
            &source,
            |audio| {
                heard = audio.len();
                Ok(vec![Turn { start_ms: 0, end_ms: 20_000, speaker: 4 }])
            },
            |transcript, language| {
                assert!(transcript.contains("Speaker 1: Others talk"), "{}", transcript);
                assert!(transcript.starts_with("[0:00] You: Live line."), "{}", transcript);
                assert_eq!(language, "en", "detected while finishing");
                Ok(Notes { summary: "A call.".into(), decisions: vec![], action_items: vec![ActionItem { text: "Write it".into(), done: false }] })
            },
            &mut |s| steps.push(s),
            &mut |_| redraws += 1,
        );
        assert_eq!(steps, [Step::Transcribing, Step::Speakers, Step::Notes]);
        assert_eq!(heard, 20 * 16_000, "the whole Others track");
        assert_eq!(redraws, 3, "two pieces and the speakers");
        let saved = store::load(&root, "m-00000000000a").unwrap();
        assert_eq!(saved, *meeting.lock().unwrap());
        assert_eq!(saved.state, State::Finished);
        assert_eq!((saved.you_done_ms, saved.others_done_ms), (20_000, 20_000));
        assert_eq!(saved.language, "en");
        let others: Vec<Option<u8>> = saved.lines.iter().filter(|l| l.track == Track::Others).map(|l| l.speaker).collect();
        assert_eq!(others, [Some(0)], "one voice: Speaker 1");
        assert_eq!(saved.notes.unwrap().summary, "A call.");
        assert!(saved.speakers_error.is_none() && saved.notes_error.is_none());
    }

    #[test]
    fn without_speaker_models_or_ai_the_meeting_still_finishes() {
        let (root, meeting) = recorded("reasons");
        let source = Tracks::saved(meeting.lock().unwrap().dir(&root));
        let worker = Worker::new(1_000, 0, &[]);
        run(
            &root,
            &meeting,
            worker,
            Some(&mut Fake { unloaded: false }),
            &source,
            |_| Err("no_model".to_string()),
            |_, _| Err("ai_off".to_string()),
            &mut |_| {},
            &mut |_| {},
        );
        let saved = store::load(&root, "m-00000000000a").unwrap();
        assert_eq!(saved.state, State::Finished);
        assert_eq!(saved.speakers_error.as_deref(), Some("no_model"));
        assert_eq!(saved.notes_error.as_deref(), Some("ai_off"));
        assert!(saved.notes.is_none());
        assert!(saved.lines.iter().filter(|l| l.track == Track::Others).all(|l| l.speaker.is_none()), "they stay Others");
    }

    #[test]
    fn models_freed_while_finishing_leave_it_interrupted() {
        let (root, meeting) = recorded("freed");
        let source = Tracks::saved(meeting.lock().unwrap().dir(&root));
        let mut steps = Vec::new();
        run(
            &root,
            &meeting,
            Worker::new(1_000, 0, &[]),
            Some(&mut Fake { unloaded: true }),
            &source,
            |_| panic!("no speakers before the transcript is done"),
            |_, _| panic!("no notes either"),
            &mut |s| steps.push(s),
            &mut |_| {},
        );
        assert_eq!(steps, [Step::Transcribing]);
        assert_eq!(store::load(&root, "m-00000000000a").unwrap().state, State::Interrupted);
    }

    #[test]
    fn a_meeting_without_audio_or_words_gets_no_speakers_and_no_notes() {
        let (root, meeting) = recorded("empty");
        {
            let mut m = meeting.lock().unwrap();
            m.lines.clear();
            m.audio_deleted = true;
        }
        let source = Tracks::saved(meeting.lock().unwrap().dir(&root));
        run(
            &root,
            &meeting,
            Worker::new(0, 0, &[]),
            None,
            &source,
            |_| panic!("the audio is gone"),
            |_, _| panic!("nothing to write notes on"),
            &mut |_| {},
            &mut |_| {},
        );
        let saved = store::load(&root, "m-00000000000a").unwrap();
        assert_eq!((saved.state, saved.notes_error.as_deref()), (State::Finished, Some("empty")));
    }
}
```

Replace `src-tauri/src/meeting/mod.rs` with the module list and the tests (the code above them follows in Step 5):

```rust
pub mod capture;
pub mod finish;
pub mod lines;
pub mod notes;
pub mod playback;
pub mod store;
pub mod wav;
pub mod worker;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::store::{ActionItem, Line, Track};

    fn setup(name: &str) -> (PathBuf, Arc<Meetings>, Arc<Mutex<Vec<Event>>>) {
        let app_dir = std::env::temp_dir().join(format!("rudariflow_meetings_{}", name));
        let _ = std::fs::remove_dir_all(&app_dir);
        std::fs::create_dir_all(&app_dir).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let llm = Arc::new(LlmServer::new(app_dir.join("llama"), app_dir.join("llm-server.log"), Box::new(|_| {})));
        let meetings = Meetings::new(&app_dir, Arc::new(WhisperEngine::new()), llm, Box::new(move |e| seen.lock().unwrap().push(e)));
        (app_dir, meetings, events)
    }

    fn config(app_dir: &Path) -> Config {
        Config {
            microphone: "default".into(),
            whisper_model: "small".into(),
            model_path: app_dir.join("ggml-small.bin"),
            gpu_backend: "cpu".into(),
            language: "auto".into(),
            dictionary: String::new(),
            terms: Vec::new(),
            swiss_spelling: false,
            ai_model: Err("ai_off".into()),
            german: false,
            unload_after: false,
        }
    }

    fn saved(app_dir: &Path, id: &str, state: State) -> Meeting {
        let mut m = Meeting::new(id, "Weekly", 1_000, 0, "small", "en");
        m.state = state;
        m.lines.push(Line { start_ms: 0, end_ms: 2_000, track: Track::Others, speaker: Some(0), text: "Hello there.".into() });
        m.notes = Some(Notes { summary: "Hi.".into(), decisions: vec![], action_items: vec![ActionItem { text: "Call back".into(), done: false }] });
        m.save(&store::root(app_dir)).unwrap();
        m
    }

    #[test]
    fn a_meeting_cut_off_last_time_is_interrupted_at_start() {
        let app_dir = std::env::temp_dir().join("rudariflow_meetings_recover");
        let _ = std::fs::remove_dir_all(&app_dir);
        saved(&app_dir, "m-000000000001", State::Recording);
        let llm = Arc::new(LlmServer::new(app_dir.join("llama"), app_dir.join("llm-server.log"), Box::new(|_| {})));
        let meetings = Meetings::new(&app_dir, Arc::new(WhisperEngine::new()), llm, Box::new(|_| {}));
        assert_eq!(meetings.get("m-000000000001").unwrap().meeting.state, State::Interrupted);
        assert_eq!(meetings.status(), Status::default());
    }

    #[test]
    fn meetings_are_renamed_ticked_and_deleted() {
        let (app_dir, meetings, events) = setup("edit");
        saved(&app_dir, "m-000000000001", State::Finished);
        meetings.rename("m-000000000001", "  Budget  ").unwrap();
        assert_eq!(meetings.rename("m-000000000001", " "), Err("empty_name".into()));
        meetings.rename_speaker("m-000000000001", 2, "Anna").unwrap();
        meetings.set_action_done("m-000000000001", 0, true).unwrap();
        assert_eq!(meetings.set_action_done("m-000000000001", 5, true), Err("no_item".into()));
        let view = meetings.get("m-000000000001").unwrap();
        assert_eq!(view.meeting.title, "Budget");
        assert_eq!(view.meeting.speaker_names, ["", "", "Anna"]);
        assert!(view.meeting.notes.unwrap().action_items[0].done);
        assert_eq!(view.paragraphs.len(), 1);
        assert_eq!(view.paragraphs[0].speaker, Some(0));
        assert_eq!(events.lock().unwrap().iter().filter(|e| **e == Event::Changed).count(), 3);
        meetings.delete("m-000000000001").unwrap();
        assert_eq!(meetings.get("m-000000000001").err().as_deref(), Some("no_meeting"));
        assert_eq!(meetings.rename("m-000000000001", "x"), Err("no_meeting".into()));
    }

    #[test]
    fn the_library_searches_titles_and_transcripts() {
        let (app_dir, meetings, _) = setup("list");
        saved(&app_dir, "m-000000000001", State::Finished);
        let mut other = saved(&app_dir, "m-000000000002", State::Interrupted);
        other.title = "Holiday plans".into();
        other.started_at = 5_000;
        other.save(&store::root(&app_dir)).unwrap();
        let all: Vec<String> = meetings.list("").into_iter().map(|s| s.id).collect();
        assert_eq!(all, ["m-000000000002", "m-000000000001"], "newest first");
        assert_eq!(meetings.list("holiday").len(), 1);
        assert_eq!(meetings.list("HELLO THERE").len(), 2, "transcript text");
        assert!(meetings.list("nothing like it").is_empty());
        assert_eq!(meetings.list("")[0].state, State::Interrupted);
    }

    #[test]
    fn start_stop_and_finish_refuse_what_cannot_be_done() {
        let (app_dir, meetings, _) = setup("refuse");
        assert_eq!(meetings.start(None, config(&app_dir)), Err("no_model".into()), "no Whisper model downloaded");
        assert!(!meetings.is_recording());
        assert_eq!(meetings.stop(), Err("not_recording".into()));
        saved(&app_dir, "m-000000000001", State::Finished);
        assert_eq!(meetings.finish("m-000000000001", config(&app_dir)), Err("not_interrupted".into()));
        assert_eq!(meetings.finish("m-0000000000ff", config(&app_dir)), Err("no_meeting".into()));
        let mut gone = saved(&app_dir, "m-000000000002", State::Finished);
        gone.audio_deleted = true;
        gone.save(&store::root(&app_dir)).unwrap();
        assert_eq!(meetings.play("m-000000000002", 0), Err("no_audio".into()));
        assert_eq!(meetings.test_play(vec![0.0; 10]), Err("no_test_device".into()), "never on a real output");
        assert_eq!(meetings.state().meeting, None);
    }

    #[test]
    fn the_drive_has_free_space() {
        let free = free_bytes(&std::env::temp_dir());
        #[cfg(windows)]
        assert!(free.is_some_and(|b| b > 0), "{:?}", free);
        let _ = free;
    }
}
```

Run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib meeting::` (from `src-tauri`). Expected: compile errors (`run`, `Step`, `Meetings`, `Config`, `Status`, `free_bytes`, … not found).

- [ ] **Step 2: `condense`: the Files tab's parts, shared with the notes**

In `src-tauri/src/file_transcribe.rs`:

1. Replace

```rust
use std::sync::atomic::{AtomicBool, Ordering};

use crate::audio::{quiet_cut, speech_spans};
```

with

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::ai_cleanup::{complete_in, LONG_SLOT};
use crate::audio::{quiet_cut, speech_spans};
use crate::llm_server::Endpoint;
```

2. Below `pub fn notes_prompt(…) { … }` add:

```rust

/// How long one AI request of a summary or of meeting notes may take.
pub const AI_TIMEOUT: Duration = Duration::from_secs(300);

/// A transcript made short enough for one last AI request: a long one is
/// cut into parts (`chunks`), each part becomes notes (`notes_prompt`), up
/// to three rounds, so hours of text fit. Returns the material and the
/// requests it took; `progress(done, total)` comes before each request.
pub async fn condense(
    endpoint: &Endpoint,
    text: &str,
    language: Option<&str>,
    progress: &mut (dyn FnMut(usize, usize) + Send),
) -> Result<(String, usize), String> {
    let mut material = text.trim().to_string();
    let chunk_chars = summary_chunk_chars(&material);
    let mut requests = 0;
    for _ in 0..3 {
        let parts = chunks(&material, chunk_chars);
        if parts.len() <= 1 {
            break;
        }
        let mut notes = Vec::new();
        for part in &parts {
            progress(requests, requests + parts.len() - notes.len() + 1);
            let answer = complete_in(endpoint, LONG_SLOT, &notes_prompt(language), part, 0.2, 700, AI_TIMEOUT).await?;
            notes.push(answer.text.trim().to_string());
            requests += 1;
        }
        material = notes.join("\n");
    }
    Ok((material, requests))
}
```

3. In `src-tauri/src/main.rs`, `summarize_text`: delete the line `const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);`, replace

```rust
    let started = std::time::Instant::now();
    let mut material = text.trim().to_string();
    let chunk_chars = file_transcribe::summary_chunk_chars(&material);
    let mut requests = 0;
    // Each round turns parts into notes; three rounds cover hours of text.
    for _ in 0..3 {
        let parts = file_transcribe::chunks(&material, chunk_chars);
        if parts.len() <= 1 {
            break;
        }
        let mut notes = Vec::new();
        for part in &parts {
            let _ = app.emit("summary-progress", (requests, requests + parts.len() - notes.len() + 1));
            let answer = ai_cleanup::complete_in(
                &endpoint,
                ai_cleanup::LONG_SLOT,
                &file_transcribe::notes_prompt(language),
                part,
                0.2,
                700,
                TIMEOUT,
            )
            .await
            .map_err(|e| summary_error(&state.llm, e))?;
            notes.push(answer.text.trim().to_string());
            requests += 1;
        }
        material = notes.join("\n");
    }
    let _ = app.emit("summary-progress", (requests, requests + 1));
```

with

```rust
    let started = std::time::Instant::now();
    let (material, requests) = file_transcribe::condense(&endpoint, &text, language, &mut |done, total| {
        let _ = app.emit("summary-progress", (done, total));
    })
    .await
    .map_err(|e| summary_error(&state.llm, e))?;
    let _ = app.emit("summary-progress", (requests, requests + 1));
```

and in the final `complete_in` call of `summarize_text` replace `TIMEOUT,` with `file_transcribe::AI_TIMEOUT,`. (Same requests, same progress events, same errors as before.)

- [ ] **Step 3: The notes by the AI**

In `src-tauri/src/meeting/notes.rs`, replace

```rust
use super::store::{ActionItem, Notes};
use crate::file_transcribe::written_in;
```

with

```rust
use super::store::{ActionItem, Notes};
use crate::ai_cleanup::{complete_in, LONG_SLOT};
use crate::file_transcribe::{condense, written_in, AI_TIMEOUT};
use crate::llm_server::Endpoint;
```

and add above `#[cfg(test)]`:

```rust
/// The notes of `transcript` (see `lines::transcript`) by the AI at
/// `endpoint`. A long meeting is condensed in parts first, as in the Files
/// tab.
pub async fn write(endpoint: &Endpoint, transcript: &str, language: Option<&str>) -> Result<Notes, String> {
    let (material, _) = condense(endpoint, transcript, language, &mut |_, _| {}).await?;
    let answer = complete_in(endpoint, LONG_SLOT, &meeting_prompt(language), &material, 0.2, 900, AI_TIMEOUT).await?;
    Ok(parse(&answer.text))
}
```

- [ ] **Step 4: The end steps**

Put this above the tests in `finish.rs`:

```rust
//! A meeting's end steps, after Stop or for Finish: the rest of both
//! tracks is transcribed, the others are told apart (Speaker 1, 2, …), the
//! AI writes the notes, and the meeting is saved as finished.

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;

use super::lines;
use super::store::{Meeting, Notes, State, Track};
use super::worker::{Piece, Source, Transcriber, Worker, PAUSED};
use crate::audio::lock;
use crate::speakers::Turn;
use crate::startup_log;

/// What "Finishing…" says it does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Step {
    /// "Transcribing the last minute"
    Transcribing,
    /// "Telling the speakers apart"
    Speakers,
    /// "Writing the notes"
    Notes,
}

/// Add a transcribed piece to the meeting: its lines (without echoes), how
/// far its track is done, and the language once Whisper detected it.
pub fn apply_piece(meeting: &mut Meeting, piece: Piece) {
    lines::add_lines(&mut meeting.lines, piece.lines);
    match piece.track {
        Track::You => meeting.you_done_ms = piece.done_ms,
        Track::Others => meeting.others_done_ms = piece.done_ms,
    }
    if (meeting.language.is_empty() || meeting.language == "auto") && piece.language != "auto" {
        meeting.language = piece.language;
    }
}

/// Run the end steps on `meeting` and save it (`root` is
/// `<app data>\meetings`). `whisper` is `None` when Whisper could not load
/// or the audio is gone: what is transcribed stays. `speakers` separates
/// the Others track (an error such as "no_model" is kept as the reason),
/// `notes` writes the notes from the transcript and the language code.
/// Unloaded models while the rest is transcribed (the Free GPU hotkey)
/// leave the meeting interrupted, for Finish later.
#[allow(clippy::too_many_arguments)]
pub fn run(
    root: &Path,
    meeting: &Mutex<Meeting>,
    mut worker: Worker,
    whisper: Option<&mut dyn Transcriber>,
    source: &dyn Source,
    speakers: impl FnOnce(&[f32]) -> Result<Vec<Turn>, String>,
    notes: impl FnOnce(&str, &str) -> Result<Notes, String>,
    on_step: &mut dyn FnMut(Step),
    on_lines: &mut dyn FnMut(&Meeting),
) {
    let id = lock(meeting).id.clone();
    let audio = !lock(meeting).audio_deleted;
    on_step(Step::Transcribing);
    if let (true, Some(whisper)) = (audio, whisper) {
        loop {
            match worker.step(source, whisper, true) {
                Ok(Some(piece)) => {
                    let mut m = lock(meeting);
                    apply_piece(&mut m, piece);
                    save(root, &m);
                    on_lines(&m);
                }
                Ok(None) => break,
                Err(e) if e == PAUSED => {
                    startup_log::log(&format!("[meeting] {}: Whisper was unloaded while finishing; Finish goes on later", id));
                    let mut m = lock(meeting);
                    m.state = State::Interrupted;
                    save(root, &m);
                    return;
                }
                Err(e) => startup_log::log(&format!("[meeting] {}: a piece was skipped: {}", id, e)),
            }
        }
    }

    on_step(Step::Speakers);
    let has_others = lock(meeting).lines.iter().any(|l| l.track == Track::Others);
    if audio && has_others {
        let others = source.available(Track::Others);
        let result = source.read(Track::Others, 0, others).and_then(|audio| speakers(&audio));
        let mut m = lock(meeting);
        m.speakers_error = match result.and_then(|turns| lines::label_others(&mut m.lines, &turns)) {
            Ok(n) => {
                startup_log::log(&format!("[meeting] {}: {} speakers", id, n));
                None
            }
            Err(e) => {
                startup_log::log(&format!("[meeting] {}: no speakers: {}", id, e));
                Some(e)
            }
        };
        save(root, &m);
        on_lines(&m);
    }

    on_step(Step::Notes);
    let (transcript, language) = {
        let m = lock(meeting);
        (lines::transcript(&m.lines, &m.speaker_names), m.language.clone())
    };
    let written = if transcript.trim().is_empty() { Err("empty".to_string()) } else { notes(&transcript, &language) };
    let mut m = lock(meeting);
    match written {
        Ok(n) => {
            m.notes = Some(n);
            m.notes_error = None;
        }
        Err(e) => {
            startup_log::log(&format!("[meeting] {}: no notes: {}", id, e));
            m.notes_error = Some(e);
        }
    }
    m.state = State::Finished;
    save(root, &m);
}

fn save(root: &Path, meeting: &Meeting) {
    if let Err(e) = meeting.save(root) {
        startup_log::log(&format!("[meeting] {} not saved: {}", meeting.id, e));
    }
}
```

- [ ] **Step 5: The `Meetings` object**

In `src-tauri/src/meeting/mod.rs`, replace everything above `#[cfg(test)]` with:

```rust
//! Meeting mode: an online call on this PC recorded as two tracks, the
//! microphone ("You") and what the PC plays ("Others"), transcribed live,
//! with the others told apart and AI notes after Stop. See
//! docs/superpowers/specs/2026-10-03-meeting-mode-design.md.
//!
//! `Meetings` holds the meeting that records, the ones whose end steps
//! run, and the player, and reports every change as an `Event`. The Tauri
//! commands, the tray items and the hotkey are in main.rs.

pub mod capture;
pub mod finish;
pub mod lines;
pub mod notes;
pub mod playback;
pub mod store;
pub mod wav;
pub mod worker;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{Arc, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;

use self::capture::{Capture, Report, Setup, Warning};
use self::finish::Step;
use self::lines::ParagraphView;
use self::playback::Player;
use self::store::{Meeting, Notes, State, Summary, OTHERS_WAV, YOU_WAV};
use self::worker::{Tracks, Transcriber, Whisper, Worker, PAUSED};
use crate::audio::lock;
use crate::llm_server::{LlmServer, STOPPED};
use crate::replacements::Moment;
use crate::speakers::{self, SpeakerCount, Turn};
use crate::startup_log;
use crate::whisper_engine::WhisperEngine;
use crate::{ai_cleanup, dictionary, file_transcribe, whisper_engine};

/// Starting needs this much free space; an hour is about 230 MB of audio.
pub const MIN_FREE_BYTES: u64 = 1 << 30;
/// A meeting stops itself after 4 hours.
pub const MAX_MS: u64 = 4 * 3600 * 1000;
const TICK: Duration = Duration::from_millis(500);
const CLEANUP_EVERY: Duration = Duration::from_secs(24 * 3600);

/// The meeting that records, as the bar shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub id: String,
    pub title: String,
    pub started_at: u64,
    pub warnings: Vec<Warning>,
    /// The models are unloaded (Free GPU, battery): the transcript waits.
    pub paused: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finishing {
    pub id: String,
    pub step: Step,
}

/// "meeting-status": what records and what finishes.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub recording: Option<Recording>,
    pub finishing: Vec<Finishing>,
}

/// A meeting with its paragraphs, as the tab shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingView {
    pub meeting: Meeting,
    pub paragraphs: Vec<ParagraphView>,
}

/// `meeting_state`: the status and the meeting that records, if any.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Current {
    pub status: Status,
    pub meeting: Option<MeetingView>,
}

/// "meeting-lines": the paragraphs from `from` on are new or changed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinesChanged {
    pub id: String,
    pub from: usize,
    pub paragraphs: Vec<ParagraphView>,
}

/// "meeting-playing": what ▶ plays; `None` when it stopped or ended.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playing {
    pub id: String,
    pub from_ms: u64,
}

/// What the views need to hear about; main.rs turns them into events.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Status(Status),
    Lines(LinesChanged),
    /// A meeting was added, changed or deleted ("meetings-changed").
    Changed,
    Playing(Option<Playing>),
    /// The meeting stopped itself at 4 hours (a notice in the pill).
    Limit,
}

/// What a meeting is recorded and transcribed with: the settings at Start.
#[derive(Debug, Clone)]
pub struct Config {
    pub microphone: String,
    pub whisper_model: String,
    pub model_path: PathBuf,
    pub gpu_backend: String,
    /// Whisper language code or "auto".
    pub language: String,
    /// The dictionary's Whisper prompt.
    pub dictionary: String,
    /// The dictionary's terms, for the spelling of every line.
    pub terms: Vec<String>,
    pub swiss_spelling: bool,
    /// The AI model for the notes, or why there are none ("ai_off",
    /// "no_ai_model").
    pub ai_model: Result<PathBuf, String>,
    /// German default titles.
    pub german: bool,
    /// The engine is not "local": Whisper is unloaded again afterwards.
    pub unload_after: bool,
}

impl Config {
    fn spelling(&self) -> Box<dyn Fn(&str) -> String + Send> {
        let (terms, swiss) = (self.terms.clone(), self.swiss_spelling);
        Box::new(move |text: &str| {
            let text = dictionary::apply_spelling(&file_transcribe::tidy_segment(text), &terms);
            if swiss {
                dictionary::swiss_spelling(&text)
            } else {
                text
            }
        })
    }

    fn whisper(&self, engine: &Arc<WhisperEngine>, language: &str) -> Whisper {
        Whisper::new(engine.clone(), language, self.dictionary.clone(), self.spelling())
    }
}

/// The meeting that records.
struct Live {
    meeting: Arc<Mutex<Meeting>>,
    capture: Capture,
    stop: Arc<AtomicBool>,
    worker: JoinHandle<(Worker, Whisper)>,
    config: Config,
}

pub struct Meetings {
    /// `<app data>\meetings`.
    root: PathBuf,
    app_dir: PathBuf,
    engine: Arc<WhisperEngine>,
    llm: Arc<LlmServer>,
    recording: Mutex<Option<Live>>,
    /// Meetings in memory while they record or finish: edits go through
    /// these, so a step that saves later does not undo them.
    open: Mutex<HashMap<String, Arc<Mutex<Meeting>>>>,
    /// The paragraphs each view has, for "meeting-lines".
    shown: Mutex<HashMap<String, Vec<ParagraphView>>>,
    status: Mutex<Status>,
    player: Mutex<Option<Player>>,
    events: Box<dyn Fn(Event) + Send + Sync>,
    this: Weak<Meetings>,
}

impl Meetings {
    /// The meetings in `<app_dir>\meetings`. Meetings a quit or crash cut
    /// off become interrupted now; old audio is deleted now and once a day.
    pub fn new(
        app_dir: &Path,
        engine: Arc<WhisperEngine>,
        llm: Arc<LlmServer>,
        events: Box<dyn Fn(Event) + Send + Sync>,
    ) -> Arc<Meetings> {
        let root = store::root(app_dir);
        for id in store::recover(&root) {
            startup_log::log(&format!("[meeting] {} was cut off: interrupted", id));
        }
        let cleanup_root = root.clone();
        let _ = std::thread::Builder::new().name("rf-meeting-cleanup".into()).spawn(move || loop {
            let deleted = store::delete_old_audio(&cleanup_root, store::now_ms());
            if deleted > 0 {
                startup_log::log(&format!("[meeting] audio of {} meetings deleted (30 days)", deleted));
            }
            std::thread::sleep(CLEANUP_EVERY);
        });
        Arc::new_cyclic(|this| Meetings {
            root,
            app_dir: app_dir.to_path_buf(),
            engine,
            llm,
            recording: Mutex::new(None),
            open: Mutex::new(HashMap::new()),
            shown: Mutex::new(HashMap::new()),
            status: Mutex::new(Status::default()),
            player: Mutex::new(None),
            events,
            this: this.clone(),
        })
    }

    pub fn status(&self) -> Status {
        lock(&self.status).clone()
    }

    pub fn is_recording(&self) -> bool {
        lock(&self.recording).is_some()
    }

    fn emit(&self, event: Event) {
        (self.events)(event);
    }

    fn change_status(&self, change: impl FnOnce(&mut Status)) {
        let status = {
            let mut status = lock(&self.status);
            change(&mut status);
            status.clone()
        };
        self.emit(Event::Status(status));
    }

    fn warning(&self, warning: Warning, on: bool) {
        self.change_status(|s| {
            if let Some(r) = s.recording.as_mut() {
                r.warnings.retain(|w| *w != warning);
                if on {
                    r.warnings.push(warning);
                }
            }
        });
    }

    fn set_paused(&self, paused: bool) {
        self.change_status(|s| {
            if let Some(r) = s.recording.as_mut() {
                r.paused = paused;
            }
        });
    }

    fn set_step(&self, id: &str, step: Step) {
        self.change_status(|s| {
            s.finishing.retain(|f| f.id != id);
            s.finishing.push(Finishing { id: id.to_string(), step });
        });
    }

    fn end_step(&self, id: &str) {
        lock(&self.open).remove(id);
        lock(&self.shown).remove(id);
        self.change_status(|s| s.finishing.retain(|f| f.id != id));
        self.emit(Event::Changed);
    }

    /// Send the paragraphs that changed since the last time.
    fn emit_lines(&self, meeting: &Meeting) {
        let paragraphs = lines::paragraphs(&meeting.lines);
        let mut shown = lock(&self.shown);
        let old = shown.entry(meeting.id.clone()).or_default();
        let from = lines::changed_from(old, &paragraphs);
        self.emit(Event::Lines(LinesChanged { id: meeting.id.clone(), from, paragraphs: paragraphs[from..].to_vec() }));
        *old = paragraphs;
    }

    /// Start recording a meeting; returns its id. Errors: "already_recording",
    /// "no_model" (no Whisper model downloaded), "disk_full" (under 1 GB
    /// free), or why a file could not be created.
    pub fn start(&self, title: Option<String>, config: Config) -> Result<String, String> {
        let mut recording = lock(&self.recording);
        if recording.is_some() {
            return Err("already_recording".to_string());
        }
        if !config.model_path.exists() {
            return Err("no_model".to_string());
        }
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        if free_bytes(&self.root).is_some_and(|free| free < MIN_FREE_BYTES) {
            return Err("disk_full".to_string());
        }
        let (now, local) = (store::now_ms(), Moment::now());
        let title = title
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| store::default_title(config.german, &local));
        let id = store::new_id();
        let meeting =
            Meeting::new(&id, &title, now, store::utc_offset_min(&local, now), &config.whisper_model, &config.language);
        meeting.save(&self.root)?;
        let dir = meeting.dir(&self.root);
        let this = self.this.clone();
        let report: Report = Box::new(move |warning, on| {
            if let Some(m) = this.upgrade() {
                m.warning(warning, on);
            }
        });
        let this = self.this.clone();
        let on_limit = Box::new(move || {
            if let Some(m) = this.upgrade() {
                // Not on the capture thread: stopping joins it.
                std::thread::spawn(move || {
                    m.emit(Event::Limit);
                    let _ = m.stop();
                });
            }
        });
        let setup = Setup {
            microphone: config.microphone.clone(),
            loopback: capture::loopback_override(),
            you: dir.join(YOU_WAV),
            others: dir.join(OTHERS_WAV),
            max_samples: MAX_MS * (wav::RATE as u64 / 1000),
        };
        let capture = match Capture::start(setup, report, on_limit) {
            Ok(capture) => capture,
            Err(e) => {
                let _ = store::delete(&self.root, &id);
                return Err(e);
            }
        };
        // Whisper loads now, unless the Free GPU hotkey keeps it unloaded:
        // then the transcript waits for the next dictation or Stop.
        let (engine, model, backend) = (self.engine.clone(), config.model_path.clone(), config.gpu_backend.clone());
        std::thread::spawn(move || {
            if !engine.released() {
                if let Err(e) = engine.ensure_loaded(&model, &backend) {
                    startup_log::log(&format!("[meeting] Whisper did not load: {}", e));
                }
            }
        });
        let meeting = Arc::new(Mutex::new(meeting));
        lock(&self.open).insert(id.clone(), meeting.clone());
        let stop = Arc::new(AtomicBool::new(false));
        let whisper = config.whisper(&self.engine, &config.language);
        let source = Tracks::recording(dir, capture.written.clone());
        let (this, m, s) = (self.this.clone(), meeting.clone(), stop.clone());
        let worker = std::thread::Builder::new()
            .name("rf-meeting-worker".into())
            .spawn(move || live(this, m, source, whisper, s))
            .map_err(|e| e.to_string())?;
        *recording = Some(Live { meeting, capture, stop, worker, config });
        drop(recording);
        self.change_status(|s| {
            s.recording = Some(Recording { id: id.clone(), title: title.clone(), started_at: now, warnings: Vec::new(), paused: false })
        });
        self.emit(Event::Changed);
        startup_log::log(&format!("[meeting] {} started", id));
        Ok(id)
    }

    /// Stop recording; the end steps run in the background ("meeting-status"
    /// shows them). Error "not_recording".
    pub fn stop(&self) -> Result<(), String> {
        let live = lock(&self.recording).take().ok_or_else(|| "not_recording".to_string())?;
        let Live { meeting, capture, stop, worker, config } = live;
        let samples = capture.stop();
        stop.store(true, SeqCst);
        let (worker, whisper) = match worker.join() {
            Ok(both) => both,
            Err(_) => {
                let m = lock(&meeting);
                (Worker::new(m.you_done_ms, m.others_done_ms, &m.lines), config.whisper(&self.engine, &m.language))
            }
        };
        let (id, dir) = {
            let mut m = lock(&meeting);
            m.length_ms = samples / (wav::RATE as u64 / 1000);
            m.state = State::Finishing;
            if let Err(e) = m.save(&self.root) {
                startup_log::log(&format!("[meeting] {} not saved: {}", m.id, e));
            }
            (m.id.clone(), m.dir(&self.root))
        };
        startup_log::log(&format!("[meeting] {} stopped after {} s", id, samples / wav::RATE as u64));
        self.change_status(|s| {
            s.recording = None;
            s.finishing.push(Finishing { id: id.clone(), step: Step::Transcribing });
        });
        self.emit(Event::Changed);
        let this = self.this.upgrade().ok_or("shutting down")?;
        std::thread::Builder::new()
            .name("rf-meeting-finish".into())
            .spawn(move || this.end_steps(meeting, worker, whisper, Tracks::saved(dir), config))
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// The end steps of `meeting` (see `finish::run`) with the real Whisper,
    /// speaker models and AI.
    fn end_steps(&self, meeting: Arc<Mutex<Meeting>>, worker: Worker, mut whisper: Whisper, source: Tracks, config: Config) {
        let (id, audio) = {
            let m = lock(&meeting);
            (m.id.clone(), !m.audio_deleted)
        };
        // Stop loads Whisper, also after the Free GPU hotkey.
        let loaded = audio
            && self
                .engine
                .ensure_loaded(&config.model_path, &config.gpu_backend)
                .inspect_err(|e| startup_log::log(&format!("[meeting] {}: Whisper did not load: {}", id, e)))
                .is_ok();
        let app_dir = self.app_dir.clone();
        let separate = |audio: &[f32]| -> Result<Vec<Turn>, String> {
            if !speakers::models_ready(&app_dir) {
                return Err("no_model".to_string());
            }
            if !speakers::runtime_available() {
                return Err("no_runtime".to_string());
            }
            speakers::separate(audio, SpeakerCount::Auto, &app_dir, &mut |_, _| {})
        };
        let notes = |transcript: &str, language: &str| self.notes_now(&config.ai_model, &config.gpu_backend, transcript, language);
        finish::run(
            &self.root,
            &meeting,
            worker,
            if loaded { Some(&mut whisper as &mut dyn Transcriber) } else { None },
            &source,
            separate,
            notes,
            &mut |step| self.set_step(&id, step),
            &mut |m| self.emit_lines(m),
        );
        drop(whisper);
        if config.unload_after {
            self.engine.invalidate();
        }
        startup_log::log(&format!("[meeting] {} finished", id));
        self.end_step(&id);
    }

    /// Notes by the AI, waited for.
    fn notes_now(&self, model: &Result<PathBuf, String>, gpu_backend: &str, transcript: &str, language: &str) -> Result<Notes, String> {
        let model = model.clone()?;
        let language = whisper_engine::language_name(language).or_else(|| ai_cleanup::detect_language(transcript));
        let freed = |e: String| if self.llm.released() { "gpu_freed".to_string() } else { e };
        tauri::async_runtime::block_on(async {
            let endpoint = self
                .llm
                .wait_ready(&model, Some(gpu_backend.to_string()), Duration::from_secs(120))
                .await
                .map_err(|e| if e == STOPPED { freed(e) } else { e })?;
            notes::write(&endpoint, transcript, language.as_deref()).await.map_err(freed)
        })
    }

    /// The status and the meeting that records, with its lines so far.
    pub fn state(&self) -> Current {
        let id = lock(&self.recording).as_ref().map(|l| lock(&l.meeting).id.clone());
        Current { status: self.status(), meeting: id.and_then(|id| self.get(&id).ok()) }
    }

    fn open_meeting(&self, id: &str) -> Option<Arc<Mutex<Meeting>>> {
        lock(&self.open).get(id).cloned()
    }

    fn load(&self, id: &str) -> Result<Meeting, String> {
        match self.open_meeting(id) {
            Some(m) => Ok(lock(&m).clone()),
            None => store::load(&self.root, id),
        }
    }

    pub fn get(&self, id: &str) -> Result<MeetingView, String> {
        let meeting = self.load(id)?;
        let paragraphs = lines::paragraphs(&meeting.lines);
        Ok(MeetingView { meeting, paragraphs })
    }

    /// The library, newest first; `query` filters by title and transcript.
    pub fn list(&self, query: &str) -> Vec<Summary> {
        let open = lock(&self.open).clone();
        store::list(&self.root)
            .into_iter()
            .map(|m| open.get(&m.id).map_or(m, |o| lock(o).clone()))
            .filter(|m| store::matches(m, query))
            .map(|m| Summary::from(&m))
            .collect()
    }

    /// Change a meeting and save it, in memory while it records or finishes.
    fn edit(&self, id: &str, change: impl FnOnce(&mut Meeting) -> Result<(), String>) -> Result<(), String> {
        match self.open_meeting(id) {
            Some(meeting) => {
                let mut m = lock(&meeting);
                change(&mut m)?;
                m.save(&self.root)?;
            }
            None => {
                let mut m = store::load(&self.root, id)?;
                change(&mut m)?;
                m.save(&self.root)?;
            }
        }
        self.emit(Event::Changed);
        Ok(())
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<(), String> {
        let title = title.trim().to_string();
        if title.is_empty() {
            return Err("empty_name".to_string());
        }
        self.edit(id, |m| {
            m.title = title.clone();
            Ok(())
        })?;
        if lock(&self.status).recording.as_ref().is_some_and(|r| r.id == id) {
            self.change_status(|s| {
                if let Some(r) = s.recording.as_mut() {
                    r.title = title;
                }
            });
        }
        Ok(())
    }

    /// Name Speaker `speaker + 1` in this meeting ("" = "Speaker n" again).
    pub fn rename_speaker(&self, id: &str, speaker: u8, name: &str) -> Result<(), String> {
        let name = name.trim().to_string();
        self.edit(id, |m| {
            let at = speaker as usize;
            if m.speaker_names.len() <= at {
                m.speaker_names.resize(at + 1, String::new());
            }
            m.speaker_names[at] = name;
            Ok(())
        })
    }

    pub fn set_action_done(&self, id: &str, index: usize, done: bool) -> Result<(), String> {
        self.edit(id, |m| {
            let item = m.notes.as_mut().and_then(|n| n.action_items.get_mut(index)).ok_or_else(|| "no_item".to_string())?;
            item.done = done;
            Ok(())
        })
    }

    /// Delete a meeting with its audio; not while it records or finishes ("busy").
    pub fn delete(&self, id: &str) -> Result<(), String> {
        if self.open_meeting(id).is_some() {
            return Err("busy".to_string());
        }
        self.stop_playing();
        store::delete(&self.root, id)?;
        lock(&self.shown).remove(id);
        self.emit(Event::Changed);
        startup_log::log(&format!("[meeting] {} deleted", id));
        Ok(())
    }

    /// Run the end steps of an interrupted meeting on its saved audio,
    /// transcribing what its lines do not cover yet.
    pub fn finish(&self, id: &str, config: Config) -> Result<(), String> {
        if self.open_meeting(id).is_some() {
            return Err("busy".to_string());
        }
        let mut m = store::load(&self.root, id)?;
        if m.state != State::Interrupted {
            return Err("not_interrupted".to_string());
        }
        m.state = State::Finishing;
        m.save(&self.root)?;
        let language = if m.language.is_empty() { config.language.clone() } else { m.language.clone() };
        let worker = Worker::new(m.you_done_ms, m.others_done_ms, &m.lines);
        let whisper = config.whisper(&self.engine, &language);
        let source = Tracks::saved(m.dir(&self.root));
        let meeting = Arc::new(Mutex::new(m));
        lock(&self.open).insert(id.to_string(), meeting.clone());
        self.set_step(id, Step::Transcribing);
        self.emit(Event::Changed);
        let this = self.this.upgrade().ok_or("shutting down")?;
        std::thread::Builder::new()
            .name("rf-meeting-finish".into())
            .spawn(move || this.end_steps(meeting, worker, whisper, source, config))
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Write the notes again or for the first time (the "Write notes"
    /// button), with `model` even when AI cleanup is off.
    pub fn write_notes(&self, id: &str, model: PathBuf, gpu_backend: String) -> Result<(), String> {
        if self.open_meeting(id).is_some() {
            return Err("busy".to_string());
        }
        let meeting = Arc::new(Mutex::new(store::load(&self.root, id)?));
        lock(&self.open).insert(id.to_string(), meeting.clone());
        self.set_step(id, Step::Notes);
        let this = self.this.upgrade().ok_or("shutting down")?;
        let id = id.to_string();
        std::thread::spawn(move || {
            let (transcript, language) = {
                let m = lock(&meeting);
                (lines::transcript(&m.lines, &m.speaker_names), m.language.clone())
            };
            let written = if transcript.trim().is_empty() {
                Err("empty".to_string())
            } else {
                this.notes_now(&Ok(model), &gpu_backend, &transcript, &language)
            };
            {
                let mut m = lock(&meeting);
                match written {
                    Ok(n) => {
                        m.notes = Some(n);
                        m.notes_error = None;
                    }
                    Err(e) => m.notes_error = Some(e),
                }
                if let Err(e) = m.save(&this.root) {
                    startup_log::log(&format!("[meeting] {} not saved: {}", id, e));
                }
            }
            this.end_step(&id);
        });
        Ok(())
    }

    /// ▶: play the meeting from `from_ms`, both tracks mixed, on Windows'
    /// default output (the test override's device in the live checks).
    pub fn play(&self, id: &str, from_ms: u64) -> Result<(), String> {
        let m = self.load(id)?;
        if m.state == State::Recording {
            return Err("recording".to_string());
        }
        if m.audio_deleted {
            return Err("no_audio".to_string());
        }
        self.stop_playing();
        let source = playback::meeting_source(&m.dir(&self.root), from_ms);
        self.start_player(source, capture::loopback_override())?;
        self.emit(Event::Playing(Some(Playing { id: id.to_string(), from_ms })));
        Ok(())
    }

    /// Test only: play 16 kHz mono samples on the test override's device,
    /// never on a real output. Error "no_test_device" without one.
    pub fn test_play(&self, samples: Vec<f32>) -> Result<(), String> {
        let device = capture::loopback_override().ok_or_else(|| "no_test_device".to_string())?;
        self.stop_playing();
        self.start_player(playback::samples_source(samples), Some(device))
    }

    fn start_player(&self, source: playback::Source, device: Option<String>) -> Result<(), String> {
        let this = self.this.clone();
        let ended = Box::new(move || {
            if let Some(m) = this.upgrade() {
                m.emit(Event::Playing(None));
            }
        });
        *lock(&self.player) = Some(Player::start(source, device, ended)?);
        Ok(())
    }

    pub fn stop_playing(&self) {
        let player = lock(&self.player).take();
        if let Some(player) = player {
            let was_playing = !player.is_finished();
            player.stop();
            if was_playing {
                self.emit(Event::Playing(None));
            }
        }
    }

    /// Quit: a meeting that records stops at once and becomes interrupted
    /// (Finish runs its end steps later). Meetings finishing stay
    /// "finishing" on disk and are recovered at the next start.
    pub fn shutdown(&self) {
        self.stop_playing();
        let Some(live) = lock(&self.recording).take() else { return };
        let samples = live.capture.stop();
        live.stop.store(true, SeqCst);
        let _ = live.worker.join();
        let mut m = lock(&live.meeting);
        m.length_ms = samples / (wav::RATE as u64 / 1000);
        m.state = State::Interrupted;
        if let Err(e) = m.save(&self.root) {
            startup_log::log(&format!("[meeting] {} not saved at quit: {}", m.id, e));
        }
        startup_log::log(&format!("[meeting] {} interrupted by quit", m.id));
    }
}

/// The live transcription while a meeting records.
fn live(this: Weak<Meetings>, meeting: Arc<Mutex<Meeting>>, source: Tracks, mut whisper: Whisper, stop: Arc<AtomicBool>) -> (Worker, Whisper) {
    let mut worker = Worker::new(0, 0, &[]);
    let mut paused = false;
    while !stop.load(SeqCst) {
        let Some(meetings) = this.upgrade() else { break };
        match worker.step(&source, &mut whisper, false) {
            Ok(Some(piece)) => {
                if paused {
                    paused = false;
                    meetings.set_paused(false);
                }
                let mut m = lock(&meeting);
                finish::apply_piece(&mut m, piece);
                if let Err(e) = m.save(&meetings.root) {
                    startup_log::log(&format!("[meeting] {} not saved: {}", m.id, e));
                }
                meetings.emit_lines(&m);
                // Catching up: the next piece at once.
                continue;
            }
            Ok(None) => {}
            Err(e) if e == PAUSED => {
                if !paused {
                    paused = true;
                    meetings.set_paused(true);
                }
            }
            Err(e) => startup_log::log(&format!("[meeting] a piece was skipped: {}", e)),
        }
        drop(meetings);
        std::thread::sleep(TICK);
    }
    (worker, whisper)
}

/// Free bytes on the drive of `path`; `None` when Windows does not say.
#[cfg(windows)]
pub fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free = 0u64;
    // SAFETY: a NUL-terminated path and a valid out pointer; the other two
    // outputs may be null.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free)
}

#[cfg(not(windows))]
pub fn free_bytes(_path: &Path) -> Option<u64> {
    None
}
```

Notes for the implementer:
- Status events are sent with no lock held except where the event only carries data (`emit_lines` holds the meeting and `shown` locks while it emits; main.rs's handler for `Lines` only emits). main.rs updates the tray from `Status` events, which waits for the main thread, so `start`/`stop` must never run on the main thread (Task 6 calls them on blocking threads).
- `on_limit` runs on the capture thread; it stops the meeting on a thread of its own, because `stop` joins the capture thread.
- While the Free GPU hotkey keeps Whisper released, `start` does not load it (the loader thread checks `released()`), and `Whisper::ready` lets go of the run's model memory; `end_steps` loads it (Stop loads the models).
- The player's `ended` callback (it runs on the player's own thread) only emits `Playing(None)`: dropping the `Player` there would make the thread join itself. The next `play` or `stop_playing` drops the finished player.

- [ ] **Step 6: Run the tests to see them pass**

```bash
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib meeting::
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib file_transcribe::
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --bins summary
```

Expected: 44 `meeting::` tests pass (9 new: `finish` 4, `meeting::tests` 5); `file_transcribe::` 10 pass; `a_summary_says_gpu_freed_only_for_the_release` passes.

- [ ] **Step 7: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/meeting/mod.rs src-tauri/src/meeting/finish.rs src-tauri/src/meeting/notes.rs src-tauri/src/file_transcribe.rs src-tauri/src/main.rs
git commit -F - <<'EOF'
feat: meetings record, transcribe live and finish with speakers and AI notes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 6: The app: commands, events, tray item, hotkey, pill dot, quit

**Files:**
- Modify: `src-tauri/src/settings.rs`, `src-tauri/src/recorder.rs`, `src-tauri/src/main.rs`, `src/overlay.html`
- Test: `settings.rs`, `main.rs` (`mod tests`); live: the checks at the end of this plan

**Interfaces:**
- Consumes: `meeting::{Meetings, Config, Event, Current, MeetingView, store::Summary, store::default_title}` (Tasks 1–5); `Recorder`; `pill_notice(handle, event, kind)`; `ai_models::{find, model_path}`; `screen_context::whisper_prompt`; `dictionary::terms`; `media::decode_16k_mono`.
- Produces (`Settings`): `meeting_hotkey: String` (`"meetingHotkey"`, default `""`), `meeting_reminder_off: bool` (`"meetingReminderOff"`), `meeting_headphones_seen: bool` (`"meetingHeadphonesSeen"`).
- Produces (`Recorder`): `pub fn set_meeting_dot(&self, app: &AppHandle, on: bool)`; the pill stays on screen as a click-through red dot between dictations while a meeting records.
- Produces (main.rs):
  - `AppState.meetings: Arc<Meetings>`
  - `HotkeyAction::Meeting` (target `"meeting"`), `hotkeys(s) -> [(HotkeyAction, String); 5]`
  - `fn meeting_config_from(s: &Settings, app_dir: &Path) -> meeting::Config`, `fn meeting_config(state: &AppState) -> meeting::Config`
  - `fn tray_meeting_text(german: bool, recording: bool) -> &'static str`, `fn set_tray_meeting(app, recording)`, `static TRAY_MEETING: OnceLock<MenuItem<tauri::Wry>>`, `static MEETING_SHOWN: AtomicBool`
  - `fn meeting_event(event: meeting::Event)`, `fn toggle_meeting(app: &AppHandle)` (tray item and hotkey)
  - commands (all `async`, none runs on the main thread): `meeting_start(title: Option<String>) -> String`, `meeting_stop()`, `meeting_state() -> Current`, `meeting_list(query: Option<String>) -> Vec<Summary>`, `meeting_get(id) -> MeetingView`, `meeting_rename(id, title)`, `meeting_rename_speaker(id, speaker: u8, name)`, `meeting_set_action_done(id, index: usize, done: bool)`, `meeting_delete(id)`, `meeting_finish(id)`, `meeting_write_notes(id)`, `meeting_play(id, from_ms: u64)` (JS `fromMs`), `meeting_stop_playing()`, `meeting_default_title() -> String`, `meeting_quit()`; test-only `meeting_test_play(path)`
  - events: `meeting-status` (`Status`), `meeting-lines` (`LinesChanged`), `meetings-changed` (no payload), `meeting-playing` (`Playing | null`), `meeting-quit-asked` (no payload); pill: `meeting-notice` (`"limit"`, or a start error code)

- [ ] **Step 1: Failing tests**

In `src-tauri/src/settings.rs`, add at the end of `mod tests`:

```rust
    #[test]
    fn meeting_settings_are_off_by_default_and_kept() {
        let s = Settings::default();
        assert_eq!((s.meeting_hotkey.as_str(), s.meeting_reminder_off, s.meeting_headphones_seen), ("", false, false));
        let before_meetings = r#"{
            "microphone": "default",
            "engine": "local",
            "whisperModel": "small",
            "groqApiKey": "",
            "recordingMode": "toggle",
            "hotkey": "Mouse5"
        }"#;
        let s: Settings = serde_json::from_str(before_meetings).unwrap();
        assert_eq!((s.meeting_hotkey.as_str(), s.meeting_reminder_off), ("", false));

        let dir = temp_dir().join("typr_test_meeting_settings");
        let _ = fs::remove_dir_all(&dir);
        let settings = Settings {
            meeting_hotkey: "Ctrl+Alt+M".to_string(),
            meeting_reminder_off: true,
            meeting_headphones_seen: true,
            ..Settings::default()
        };
        settings.save(&dir).unwrap();
        let loaded = Settings::load(&dir);
        assert_eq!(
            (loaded.meeting_hotkey.as_str(), loaded.meeting_reminder_off, loaded.meeting_headphones_seen),
            ("Ctrl+Alt+M", true, true)
        );
        let json = fs::read_to_string(Settings::config_path(&dir)).unwrap();
        for key in ["\"meetingHotkey\"", "\"meetingReminderOff\"", "\"meetingHeadphonesSeen\""] {
            assert!(json.contains(key), "{}", key);
        }
        let _ = fs::remove_dir_all(&dir);
    }
```

In `src-tauri/src/main.rs`, `mod tests`:

1. In `sound_and_stop_hotkeys_join_the_conflict_check`, replace `assert_eq!(all.len(), 6);` with `assert_eq!(all.len(), 7, "the app's five and the board's two");`.
2. Add before `fn a_summary_says_gpu_freed_only_for_the_release`:

```rust
    #[test]
    fn the_meeting_hotkey_is_the_fifth_and_joins_the_conflict_check() {
        assert_eq!(HotkeyAction::from_target("meeting"), Ok(HotkeyAction::Meeting));
        assert_eq!(HotkeyAction::Meeting.target(), "meeting");
        let mut s = Settings::default();
        assert_eq!(hotkeys(&s)[4], (HotkeyAction::Meeting, String::new()), "off by default");
        s.meeting_hotkey = "Ctrl+Alt+M".to_string();
        let board = board_with("", &[("s-a", "airhorn", "F13")]);
        let all = all_hotkeys(&s, &board);
        assert_eq!(taken_by(&all, &HotkeyAction::FreeGpu, "ctrl+alt+m"), Some(HotkeyAction::Meeting));
        assert_eq!(taken_by(&all, &HotkeyAction::Meeting, "F13"), Some(HotkeyAction::Sound("s-a".into())));
        assert_eq!(owner_label(&HotkeyAction::Meeting, &board), "meeting");
        assert_eq!(app_hotkey_owner(&hotkeys(&s), "Ctrl+Alt+M"), Some(HotkeyAction::Meeting), "a board key never takes it");
    }

    #[test]
    fn the_tray_item_starts_or_stops_in_the_ui_language() {
        assert_eq!(tray_meeting_text(false, false), "Start meeting");
        assert_eq!(tray_meeting_text(false, true), "Stop meeting");
        assert_eq!(tray_meeting_text(true, false), "Meeting starten");
        assert_eq!(tray_meeting_text(true, true), "Meeting beenden");
    }

    #[test]
    fn a_meeting_records_with_the_settings_at_start() {
        let dir = std::env::temp_dir().join("rudariflow_meeting_config");
        let mut s = Settings {
            custom_prompt: "Prodega".to_string(),
            language: "de".to_string(),
            ui_language: "de".to_string(),
            engine: "cloud".to_string(),
            ..Settings::default()
        };
        let c = meeting_config_from(&s, &dir);
        assert_eq!(c.model_path, dir.join("ggml-small.bin"));
        assert_eq!((c.language.as_str(), c.german, c.unload_after), ("de", true, true));
        assert!(c.dictionary.contains("Prodega"), "{}", c.dictionary);
        assert_eq!(c.terms, ["Prodega"]);
        assert_eq!(c.ai_model, Err("ai_off".to_string()), "notes need AI cleanup on");
        s.ai_cleanup = true;
        assert_eq!(meeting_config_from(&s, &dir).ai_model, Err("no_ai_model".to_string()), "and the model downloaded");
    }
```

Run:

```bash
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib settings::
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --bins meeting
```

Expected: compile errors (`meeting_hotkey`, `HotkeyAction::Meeting`, `tray_meeting_text`, `meeting_config_from` not found).

- [ ] **Step 2: The settings**

In `src-tauri/src/settings.rs`:

1. In `pub struct Settings`, after the `file_speakers` field, add:

```rust
    /// Starts and stops a meeting (Meetings tab). Empty = off, the default.
    #[serde(rename = "meetingHotkey", default)]
    pub meeting_hotkey: String,
    /// The meeting bar's reminder to tell the others is dismissed for good.
    #[serde(rename = "meetingReminderOff", default)]
    pub meeting_reminder_off: bool,
    /// The headphones hint was shown in a meeting once.
    #[serde(rename = "meetingHeadphonesSeen", default)]
    pub meeting_headphones_seen: bool,
```

2. In `impl Default for Settings`, after `file_speakers: default_file_speakers(),` add:

```rust
            meeting_hotkey: String::new(),
            meeting_reminder_off: false,
            meeting_headphones_seen: false,
```

Run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib settings::`. Expected: 17 pass.

- [ ] **Step 3: The pill's red dot**

In `src-tauri/src/recorder.rs`:

1. Above `fn update_overlay(app: &AppHandle, state: &RecordingState) {` add:

```rust
/// While a meeting records, the pill stays on screen between dictations as
/// a small red dot that clicks go through (`Recorder::set_meeting_dot`).
static MEETING_DOT: AtomicBool = AtomicBool::new(false);

/// The pill when no dictation runs: hidden, or the meeting's red dot.
fn rest_overlay(overlay: &tauri::WebviewWindow) {
    if MEETING_DOT.load(Ordering::SeqCst) {
        let _ = overlay.set_ignore_cursor_events(true);
        let _ = overlay.eval("document.body.dataset.state = 'ready'; window.__meetingDot && window.__meetingDot(true);");
        let _ = overlay.set_always_on_top(false);
        let _ = overlay.set_always_on_top(true);
        let _ = overlay.show();
    } else if let Err(e) = overlay.hide() {
        startup_log::log(&format!("[overlay] hide() failed: {}", e));
    }
}

```

2. In `update_overlay`, replace

```rust
        RecordingState::Ready => {
            if let Err(e) = overlay.hide() {
                startup_log::log(&format!("[overlay] hide() failed: {}", e));
            }
        }
        RecordingState::Recording | RecordingState::Transcribing => {
```

with

```rust
        RecordingState::Ready => rest_overlay(&overlay),
        RecordingState::Recording | RecordingState::Transcribing => {
            // The meeting's dot lets clicks through; the pill's Cancel needs them.
            let _ = overlay.set_ignore_cursor_events(false);
```

3. In `show_notice_with`'s timer, replace

```rust
            if let Some(overlay) = app_clone.get_webview_window("overlay") {
                let _ = overlay.hide();
            }
```

with

```rust
            if let Some(overlay) = app_clone.get_webview_window("overlay") {
                rest_overlay(&overlay);
            }
```

4. In `impl Recorder`, above `/// Show a short notice in the pill, e.g. why "rewrite last" did not`, add:

```rust
    /// A meeting started (`on`) or ended: the pill shows a small red dot
    /// while it records, also between dictations and with the window hidden.
    pub fn set_meeting_dot(&self, app: &AppHandle, on: bool) {
        MEETING_DOT.store(on, Ordering::SeqCst);
        let Some(overlay) = app.get_webview_window("overlay") else { return };
        let _ = overlay.eval(format!("window.__meetingDot && window.__meetingDot({});", on));
        if self.get_state() == RecordingState::Ready {
            rest_overlay(&overlay);
        }
    }

```

- [ ] **Step 4: Commands, events, the tray item and the hotkey in main.rs**

In `src-tauri/src/main.rs`:

1. Below `use rudariflow_lib::soundboard::{self, engine, AddResult, BoardState, Soundboard, Status};` add `use rudariflow_lib::meeting::{self, Meetings};`.

2. In `struct AppState`, after `soundboard: Arc<Soundboard>,` add:

```rust
    /// Meeting mode: the meeting that records, the ones finishing, ▶.
    meetings: Arc<Meetings>,
```

3. `HotkeyAction`: after the `FreeGpu,` variant (and its doc line) add

```rust
    /// Start a meeting, or stop the one that records (Meetings tab).
    Meeting,
```

in `from_target` add `"meeting" => Ok(Self::Meeting),` after the `"freeGpu"` arm; in `target` add `Self::Meeting => "meeting".to_string(),` after the `FreeGpu` arm, and make its doc comment list `"meeting"` after `"freeGpu"`.

4. Replace `hotkeys` with:

```rust
fn hotkeys(s: &Settings) -> [(HotkeyAction, String); 5] {
    [
        (HotkeyAction::Dictation, s.hotkey.clone()),
        (HotkeyAction::PasteLast, s.paste_last_hotkey.clone()),
        (HotkeyAction::RewriteLast, s.rewrite_last_hotkey.clone()),
        (HotkeyAction::FreeGpu, s.free_gpu_hotkey.clone()),
        (HotkeyAction::Meeting, s.meeting_hotkey.clone()),
    ]
}
```

and update three doc comments: `/// Every hotkey: the app's four and the soundboard's.` → `the app's five`; `/// The app hotkey (dictation, paste last, rewrite last, Free GPU) that has` → `(dictation, paste last, rewrite last, Free GPU, meeting)`; in `SyncInputs`, `/// The app's own four, which a board key never takes over.` → `own five`.

5. `change_hotkey`: replace its whole doc comment (four lines) with

```rust
/// `target` is "dictation", "pasteLast", "rewriteLast", "freeGpu" or
/// "meeting"; each takes a keyboard chord or a mouse side button. An empty
/// `new_hotkey` turns all but dictation off; dictation always needs one. A key a
/// soundboard hotkey has is refused too, even while the board is off.
```

and in its `match action`, after `HotkeyAction::FreeGpu => settings.free_gpu_hotkey = new_hotkey,` add `HotkeyAction::Meeting => settings.meeting_hotkey = new_hotkey,`, changing the comment below to `// `from_target` names only the app's five.`.

6. `on_hotkey_event`: after `HotkeyAction::FreeGpu => {}` add:

```rust
        HotkeyAction::Meeting if pressed => toggle_meeting(handle),
        HotkeyAction::Meeting => {}
```

7. Above `/// Keyboard chords go through the global-shortcut plugin; mouse side buttons` add:

```rust
/// What a meeting records and transcribes with: the settings now.
fn meeting_config_from(s: &Settings, app_dir: &std::path::Path) -> meeting::Config {
    let ai_model = if !s.ai_cleanup {
        Err("ai_off".to_string())
    } else {
        ai_models::find(&s.ai_model)
            .map(|m| ai_models::model_path(app_dir, m))
            .filter(|p| p.exists())
            .ok_or_else(|| "no_ai_model".to_string())
    };
    meeting::Config {
        microphone: s.microphone.clone(),
        whisper_model: s.whisper_model.clone(),
        model_path: app_dir.join(rudariflow_lib::whisper_engine::model_filename(&s.whisper_model)),
        gpu_backend: s.gpu_backend.clone(),
        language: s.language.clone(),
        dictionary: screen_context::whisper_prompt(&[], &s.custom_prompt),
        terms: dictionary::terms(&s.custom_prompt),
        swiss_spelling: s.swiss_spelling,
        ai_model,
        german: s.ui_language == "de",
        unload_after: s.engine != "local",
    }
}

fn meeting_config(state: &AppState) -> meeting::Config {
    let settings = state.settings.lock().unwrap().clone();
    meeting_config_from(&settings, &state.app_dir)
}

/// The tray's "Start meeting" / "Stop meeting" item.
static TRAY_MEETING: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();
/// A meeting records, as the tray item and the pill show it.
static MEETING_SHOWN: AtomicBool = AtomicBool::new(false);

fn tray_meeting_text(german: bool, recording: bool) -> &'static str {
    match (german, recording) {
        (false, false) => "Start meeting",
        (false, true) => "Stop meeting",
        (true, false) => "Meeting starten",
        (true, true) => "Meeting beenden",
    }
}

/// Set the tray item's text. From another thread this waits for the main
/// thread, so nothing that holds up the main thread may call it.
fn set_tray_meeting(app: &AppHandle, recording: bool) {
    let german = app.state::<AppState>().settings.lock().unwrap().ui_language == "de";
    if let Some(item) = TRAY_MEETING.get() {
        let _ = item.set_text(tray_meeting_text(german, recording));
    }
}

/// The meetings' changes as events; the tray item and the pill's red dot
/// follow whether a meeting records.
fn meeting_event(event: meeting::Event) {
    let Some(app) = APP_HANDLE.get() else { return };
    match event {
        meeting::Event::Status(status) => {
            let recording = status.recording.is_some();
            let _ = app.emit("meeting-status", status);
            if MEETING_SHOWN.swap(recording, Ordering::SeqCst) != recording {
                set_tray_meeting(app, recording);
                app.state::<AppState>().recorder.set_meeting_dot(app, recording);
            }
        }
        meeting::Event::Lines(lines) => {
            let _ = app.emit("meeting-lines", lines);
        }
        meeting::Event::Changed => {
            let _ = app.emit("meetings-changed", ());
        }
        meeting::Event::Playing(playing) => {
            let _ = app.emit("meeting-playing", playing);
        }
        meeting::Event::Limit => pill_notice(app, "meeting-notice", "limit"),
    }
}

/// The tray item and the hotkey: start a meeting, or stop the one that
/// records. Off the main thread: stopping waits for the capture thread,
/// whose reports update the tray through the main thread. A failed start
/// shows its reason in the pill ("meeting-notice").
fn toggle_meeting(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let result = if state.meetings.is_recording() {
            state.meetings.stop()
        } else {
            state.meetings.start(None, meeting_config(&state)).map(|_| ())
        };
        if let Err(e) = result {
            startup_log::log(&format!("[meeting] {}", e));
            pill_notice(&app, "meeting-notice", &e);
        }
    });
}

/// Start a meeting; `title` empty or missing = "Meeting 3 Oct 2026, 14:00".
/// Errors: "already_recording", "no_model", "disk_full" or a file error.
#[tauri::command]
async fn meeting_start(state: State<'_, AppState>, title: Option<String>) -> Result<String, String> {
    let (meetings, config) = (state.meetings.clone(), meeting_config(&state));
    tauri::async_runtime::spawn_blocking(move || meetings.start(title, config)).await.map_err(|e| e.to_string())?
}

/// Stop recording; the end steps follow in the background.
#[tauri::command]
async fn meeting_stop(state: State<'_, AppState>) -> Result<(), String> {
    let meetings = state.meetings.clone();
    tauri::async_runtime::spawn_blocking(move || meetings.stop()).await.map_err(|e| e.to_string())?
}

/// The status and the meeting that records, with its paragraphs so far.
#[tauri::command]
async fn meeting_state(state: State<'_, AppState>) -> Result<meeting::Current, String> {
    let meetings = state.meetings.clone();
    tauri::async_runtime::spawn_blocking(move || meetings.state()).await.map_err(|e| e.to_string())
}

/// The library, newest first, filtered by title and transcript text.
#[tauri::command]
async fn meeting_list(state: State<'_, AppState>, query: Option<String>) -> Result<Vec<meeting::store::Summary>, String> {
    let meetings = state.meetings.clone();
    tauri::async_runtime::spawn_blocking(move || meetings.list(&query.unwrap_or_default())).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn meeting_get(state: State<'_, AppState>, id: String) -> Result<meeting::MeetingView, String> {
    let meetings = state.meetings.clone();
    tauri::async_runtime::spawn_blocking(move || meetings.get(&id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn meeting_rename(state: State<'_, AppState>, id: String, title: String) -> Result<(), String> {
    state.meetings.rename(&id, &title)
}

/// Name Speaker `speaker + 1` in one meeting ("" = back to "Speaker n").
#[tauri::command]
async fn meeting_rename_speaker(state: State<'_, AppState>, id: String, speaker: u8, name: String) -> Result<(), String> {
    state.meetings.rename_speaker(&id, speaker, &name)
}

#[tauri::command]
async fn meeting_set_action_done(state: State<'_, AppState>, id: String, index: usize, done: bool) -> Result<(), String> {
    state.meetings.set_action_done(&id, index, done)
}

#[tauri::command]
async fn meeting_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let meetings = state.meetings.clone();
    tauri::async_runtime::spawn_blocking(move || meetings.delete(&id)).await.map_err(|e| e.to_string())?
}

/// Run the end steps of an interrupted meeting.
#[tauri::command]
async fn meeting_finish(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.meetings.finish(&id, meeting_config(&state))
}

/// Write the notes (the "Write notes" button): needs the AI model
/// downloaded ("no_ai_model"), not AI cleanup switched on.
#[tauri::command]
async fn meeting_write_notes(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let (model, backend) = {
        let s = state.settings.lock().unwrap();
        (ai_models::find(&s.ai_model).map(|m| ai_models::model_path(&state.app_dir, m)), s.gpu_backend.clone())
    };
    let model = model.filter(|p| p.exists()).ok_or_else(|| "no_ai_model".to_string())?;
    state.meetings.write_notes(&id, model, backend)
}

#[tauri::command]
async fn meeting_play(state: State<'_, AppState>, id: String, from_ms: u64) -> Result<(), String> {
    let meetings = state.meetings.clone();
    tauri::async_runtime::spawn_blocking(move || meetings.play(&id, from_ms)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn meeting_stop_playing(state: State<'_, AppState>) -> Result<(), String> {
    let meetings = state.meetings.clone();
    tauri::async_runtime::spawn_blocking(move || meetings.stop_playing()).await.map_err(|e| e.to_string())
}

/// The title a meeting started now gets, for the title field's placeholder.
#[tauri::command]
async fn meeting_default_title(state: State<'_, AppState>) -> Result<String, String> {
    let german = state.settings.lock().unwrap().ui_language == "de";
    Ok(meeting::store::default_title(german, &rudariflow_lib::replacements::Moment::now()))
}

/// Quit after "Stop the meeting and quit?": the meeting is saved as
/// interrupted at exit (`Meetings::shutdown`), and Finish runs its end
/// steps later.
#[tauri::command]
async fn meeting_quit(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

/// Test hook: play an audio file on the device RUDARIFLOW_MEETING_LOOPBACK
/// names (the virtual cable), never on a real output. Only with
/// RUDARIFLOW_TEST_COMMANDS=1.
#[tauri::command]
async fn meeting_test_play(state: State<'_, AppState>, path: String) -> Result<(), String> {
    if std::env::var("RUDARIFLOW_TEST_COMMANDS").as_deref() != Ok("1") {
        return Err("test commands are off".to_string());
    }
    let meetings = state.meetings.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let samples = media::decode_16k_mono(std::path::Path::new(&path), |_, _| {})?;
        meetings.test_play(samples)
    })
    .await
    .map_err(|e| e.to_string())?
}
```

8. `save_settings`: replace

```rust
    let warm_prompt = polish::system_prompt(&settings);
    *state.settings.lock().unwrap() = settings;
```

with

```rust
    let warm_prompt = polish::system_prompt(&settings);
    let language_changed = state.settings.lock().unwrap().ui_language != settings.ui_language;
    *state.settings.lock().unwrap() = settings;
    if language_changed {
        set_tray_meeting(&app, state.meetings.is_recording());
    }
```

(`save_settings` runs on the main thread; `set_text` from the main thread runs at once.)

9. In `fn main()`:
   - after `let soundboard = Soundboard::new(&app_dir, Box::new(soundboard_event));` add `let whisper_engine = Arc::new(WhisperEngine::new());`;
   - after `llm.set_warm_prompt(polish::system_prompt(&settings));` add `let meetings = Meetings::new(&app_dir, whisper_engine.clone(), llm.clone(), Box::new(meeting_event));`;
   - after `let initial_free_gpu_hotkey = settings.free_gpu_hotkey.clone();` add

```rust
    let initial_meeting_hotkey = settings.meeting_hotkey.clone();
    let initial_german = settings.ui_language == "de";
```

   - in `.manage(AppState { … })` replace `whisper_engine: Arc::new(WhisperEngine::new()),` with `whisper_engine,` and add `meetings,` after `soundboard,`;
   - in `generate_handler![…]`, after `soundboard_set_always_on_top,` add:

```rust
            meeting_start,
            meeting_stop,
            meeting_state,
            meeting_list,
            meeting_get,
            meeting_rename,
            meeting_rename_speaker,
            meeting_set_action_done,
            meeting_delete,
            meeting_finish,
            meeting_write_notes,
            meeting_play,
            meeting_stop_playing,
            meeting_default_title,
            meeting_quit,
            meeting_test_play,
```

   - in `setup`, after the `initial_free_gpu_hotkey` registration add:

```rust
            if !initial_meeting_hotkey.is_empty() {
                let _ = register_hotkey(app.handle(), &initial_meeting_hotkey, HotkeyAction::Meeting);
            }
```

   - the tray: replace

```rust
            let show_item = MenuItem::with_id(app, "show", "Show RudariFlow", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
```

with

```rust
            let show_item = MenuItem::with_id(app, "show", "Show RudariFlow", true, None::<&str>)?;
            let meeting_item =
                MenuItem::with_id(app, "meeting", tray_meeting_text(initial_german, false), true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &meeting_item, &quit_item])?;
            let _ = TRAY_MEETING.set(meeting_item);
```

     and in `.on_menu_event`, replace the `"quit"` arm with:

```rust
                    "meeting" => toggle_meeting(app),
                    "quit" => {
                        // A meeting that records: the window asks "Stop the
                        // meeting and quit?" (meeting_quit).
                        if app.state::<AppState>().meetings.is_recording() {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                            let _ = app.emit("meeting-quit-asked", ());
                        } else {
                            app.exit(0);
                        }
                    }
```

   - in `.run(…)`, after `state.soundboard.shutdown();` add:

```rust
                // A meeting that records is saved as interrupted.
                state.meetings.shutdown();
```

- [ ] **Step 5: The pill: red dot and meeting notices**

In `src/overlay.html`:

1. In the `<style>`, after the `body[data-edit="1"][data-state="recording"] .bar { … }` rule, add:

```css
      /* A meeting records: a small red dot, also between dictations (the
         window lets clicks through then, see recorder.rs rest_overlay). */
      .meeting-dot {
        display: none;
        position: absolute;
        top: 6px;
        right: 22px;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #ff5c5c;
        box-shadow: 0 0 0 2px rgba(20, 20, 22, 0.92);
        pointer-events: none;
      }
      body[data-meeting="1"] .meeting-dot { display: block; }
      body[data-meeting="1"][data-state="ready"] .pill { visibility: hidden; }
      body[data-meeting="1"][data-state="ready"] .meeting-dot {
        top: auto;
        bottom: 14px;
        right: 50%;
        width: 12px;
        height: 12px;
        transform: translateX(50%);
      }
```

2. After `<div class="transcript" id="transcript"></div>` add `<div class="meeting-dot" id="meeting-dot" aria-hidden="true"></div>`.

3. In the script, after the `window.__overlayUpdate = (state) => { … };` function add:

```js
      // Meeting mode: the red dot while a meeting records (Recorder::set_meeting_dot).
      window.__meetingDot = (on) => {
        if (on) document.body.dataset.meeting = "1";
        else delete document.body.dataset.meeting;
      };
```

4. In `NOTICE_TEXT.en`, after `sb_hotkeys_off: …, sb_hotkeys_on: …,` add

```js
          mt_limit: "Meeting stopped at 4 hours", mt_no_model: "Download a Whisper model first",
          mt_disk_full: "Not enough disk space for a meeting", mt_failed: "The meeting could not start",
```

   and in `NOTICE_TEXT.de`, after `sb_hotkeys_off: …, sb_hotkeys_on: …,` add

```js
          mt_limit: "Meeting nach 4 Stunden beendet", mt_no_model: "Zuerst ein Whisper-Modell herunterladen",
          mt_disk_full: "Zu wenig Speicherplatz für ein Meeting", mt_failed: "Das Meeting konnte nicht starten",
```

5. After the `listen("soundboard-notice", …)` block add:

```js
      // Meeting mode: "limit" (stopped at 4 hours), or why a start from the
      // tray or the hotkey failed ("no_model", "disk_full", other codes).
      listen("meeting-notice", (event) => {
        const t = NOTICE_TEXT[pickLang()];
        const text = { limit: t.mt_limit, no_model: t.mt_no_model, disk_full: t.mt_disk_full }[event.payload] || t.mt_failed;
        diag(`meeting-notice received (${event.payload})`);
        showNotice(text, 3000);
      });
```

- [ ] **Step 6: Run the tests to see them pass**

```bash
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib settings::
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib recorder::
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --bins hotkey
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --bins meeting
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --bins tray
```

Expected: `settings::` 17 pass; `recorder::` 3 pass; `hotkey` 12 pass (incl. `the_meeting_hotkey_is_the_fifth_and_joins_the_conflict_check` and the updated count); `meeting` 2 pass; `tray` 1 passes.

- [ ] **Step 7: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/settings.rs src-tauri/src/recorder.rs src-tauri/src/main.rs src/overlay.html
git commit -F - <<'EOF'
feat: meeting commands and events, a tray item, an optional hotkey and the pill's red dot

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 7: The Meetings tab

**Files:**
- Create: `src/meetings.ts`
- Modify: `index.html`, `src/main.ts`, `src/hotkey-capture.ts`, `src/i18n.ts`, `src/style.css`
- Test: `npx tsc --noEmit`; live: check 1 in "Live checks"

**Interfaces:**
- Consumes: the commands and events of Task 6; `export_file(kind, path, doc: ExportDoc)` (`title`, `meta`, `segments: {startMs, endMs, text, speaker}[]`, `names`, `times`, `summary`, `summaryTitle`, `transcriptTitle`); `speaker_model_download`; `copy_text`; `save` from `@tauri-apps/plugin-dialog`; `getLang`, `t` from `./i18n`.
- Produces (`src/meetings.ts`):
  - `export interface MeetingsHost { settings(): { meetingReminderOff: boolean; meetingHeadphonesSeen: boolean }; saveSettings(patch: { meetingReminderOff?: boolean; meetingHeadphonesSeen?: boolean }): Promise<void>; showSection(): void }`
  - `export async function initMeetings(h: MeetingsHost)`, `export async function renderMeetings()`
- Produces (DOM ids): `mt-start`, `mt-title`, `mt-start-btn`, `mt-start-error`, `mt-bar`, `mt-bar-time`, `mt-bar-title`, `mt-stop-btn`, `mt-warnings`, `mt-reminder`, `mt-reminder-text`, `mt-reminder-close`, `mt-finishing`, `mt-view`, `mt-back`, `mt-view-title`, `mt-view-meta`, `mt-copy`, `mt-export-menu`, `mt-export`, `mt-export-list`, `mt-delete`, `mt-hint`, `mt-notes`, `mt-speakers`, `mt-speaker-chips`, `mt-transcript`, `mt-live`, `mt-library`, `mt-search`, `mt-list`, `mt-empty`, `mt-quit`, `mt-quit-ok`, `mt-quit-cancel`, `meeting-hotkey-btn`, `meeting-hotkey-text`, `meeting-hotkey-clear`
- Exports use the Files tab's exporters with segments whose `speaker` is 0 You, 1 Others, 2 + n Speaker n+1, `names` to match, and the notes as the summary (`summaryTitle` "Notes") on top for PDF, Word and text.

- [ ] **Step 1: The tab, the hotkey row and the quit dialog in index.html**

1. In the sidebar `<nav>`, before `<a class="nav-item" data-section="soundboard">`, add:

```html
          <a class="nav-item" data-section="meetings">
            <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="5.5" cy="5.5" r="2" stroke="currentColor" stroke-width="1.2"/>
              <circle cx="10.5" cy="5.5" r="2" stroke="currentColor" stroke-width="1.2"/>
              <path d="M2 12.5c0-1.9 1.6-3.5 3.5-3.5S9 10.6 9 12.5M8.6 9.4A3.5 3.5 0 0114 12.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
            <span data-i18n="nav_meetings">Meetings</span>
          </a>
```

(The spec puts the tab after Files; the Soundboard follows it.)

2. In `#section-recording`, before the setting row with `data-i18n="send_command_label"`, add:

```html
            <div class="setting-row">
              <div class="setting-label">
                <span class="label-text" data-i18n="meeting_hotkey_label">Start / stop a meeting</span>
                <span class="label-hint" data-i18n="meeting_hotkey_hint">Starts a meeting in the Meetings tab, or stops the one that records.</span>
              </div>
              <div class="setting-control hotkey-control">
                <button id="meeting-hotkey-btn" class="hotkey-btn"><kbd id="meeting-hotkey-text"></kbd></button>
                <button id="meeting-hotkey-clear" class="icon-btn" data-i18n-title="paste_last_clear" title="Turn off">
                  <svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
                </button>
              </div>
            </div>
```

3. Before `<section id="section-soundboard" class="content-section">`, add:

```html
        <section id="section-meetings" class="content-section">
          <div class="section-header">
            <h2 class="section-title" data-i18n="mt_title">Meetings</h2>
            <p class="section-desc" data-i18n="mt_desc">Record an online call on this PC (Teams, Zoom, Discord, Google Meet …): your microphone and what the PC plays, transcribed live, with notes when it ends. Everything stays on your PC.</p>
          </div>
          <div id="mt-start" class="mt-start">
            <input id="mt-title" type="text" class="mt-title-input" spellcheck="false" data-i18n-title="mt_title_label" title="Title" />
            <button id="mt-start-btn" class="btn-primary" data-i18n="mt_start">Start meeting</button>
          </div>
          <p id="mt-start-error" class="label-hint mt-error hidden" role="alert"></p>
          <div id="mt-bar" class="mt-bar hidden" role="status">
            <span id="mt-bar-time" class="mt-bar-time"></span>
            <span id="mt-bar-title" class="mt-bar-title"></span>
            <button id="mt-stop-btn" class="btn-secondary mt-stop" data-i18n="mt_stop">Stop</button>
          </div>
          <div id="mt-warnings" class="mt-warnings" role="status"></div>
          <div id="mt-reminder" class="mt-reminder hidden">
            <span id="mt-reminder-text"></span>
            <button id="mt-reminder-close" class="icon-btn" data-i18n-title="mt_reminder_dismiss" title="Don't show again" aria-label="Don't show again">
              <svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div id="mt-finishing" class="mt-finishing" role="status"></div>
          <div id="mt-view" class="mt-view hidden">
            <div class="mt-view-head">
              <button id="mt-back" class="btn-ghost" data-i18n="mt_back">← All meetings</button>
              <div class="mt-view-actions">
                <button id="mt-copy" class="btn-secondary" data-i18n="mt_copy_all">Copy all</button>
                <div id="mt-export-menu" class="export-menu">
                  <button id="mt-export" class="btn-secondary" aria-expanded="false" aria-controls="mt-export-list"><span data-i18n="files_export">Export</span> ▾</button>
                  <div id="mt-export-list" class="export-list hidden">
                    <button data-kind="pdf" data-i18n="files_export_pdf">PDF…</button>
                    <button data-kind="docx" data-i18n="files_export_docx">Word (.docx)…</button>
                    <button data-kind="srt" data-i18n="files_export_srt">Subtitles (.srt)…</button>
                    <button data-kind="vtt" data-i18n="files_export_vtt">Subtitles (.vtt)…</button>
                    <button data-kind="txt" data-i18n="files_export_txt">Text (.txt)…</button>
                  </div>
                </div>
                <button id="mt-delete" class="btn-secondary" data-i18n="mt_delete">Delete</button>
              </div>
            </div>
            <h3 id="mt-view-title" class="mt-view-title" data-i18n-title="mt_rename" title="Click to rename"></h3>
            <span id="mt-view-meta" class="label-hint"></span>
            <div id="mt-hint" class="mt-hint hidden"></div>
            <div id="mt-notes" class="mt-notes hidden"></div>
            <div id="mt-speakers" class="file-speakers hidden">
              <span class="label-hint" data-i18n="files_speakers_names">Speakers:</span>
              <div id="mt-speaker-chips" class="file-speaker-chips"></div>
            </div>
            <div id="mt-transcript" class="mt-transcript" tabindex="0"></div>
            <button id="mt-live" class="btn-secondary mt-live hidden" data-i18n="mt_jump_live">Jump to live</button>
          </div>
          <div id="mt-library" class="mt-library">
            <div class="mt-library-head">
              <h3 class="mt-library-title" data-i18n="mt_library">Your meetings</h3>
              <input id="mt-search" type="search" class="mt-search" spellcheck="false" data-i18n-placeholder="mt_search" placeholder="Search titles and transcripts" />
            </div>
            <div id="mt-list" class="mt-list"></div>
            <p id="mt-empty" class="label-hint hidden"></p>
          </div>
        </section>
```

4. Before `<script type="module" src="/src/main.ts"></script>`, add:

```html
    <div id="mt-quit" class="mt-modal hidden" role="dialog" aria-modal="true" aria-labelledby="mt-quit-question">
      <div class="mt-modal-box">
        <p id="mt-quit-question" class="mt-modal-question" data-i18n="mt_quit_question">Stop the meeting and quit?</p>
        <p class="label-hint" data-i18n="mt_quit_hint">The meeting is kept as interrupted; Finish in the Meetings tab transcribes the rest and writes the notes.</p>
        <div class="mt-modal-actions">
          <button id="mt-quit-cancel" class="btn-secondary" data-i18n="files_cancel">Cancel</button>
          <button id="mt-quit-ok" class="btn-primary" data-i18n="mt_quit_ok">Stop and quit</button>
        </div>
      </div>
    </div>
```

- [ ] **Step 2: Strings (EN and DE)**

In `src/i18n.ts`, add at the end of `const en` (before its closing `};`, after `hotkey_bare: …`):

```ts
  nav_meetings: "Meetings",
  mt_title: "Meetings",
  mt_desc: "Record an online call on this PC (Teams, Zoom, Discord, Google Meet …): your microphone and what the PC plays, transcribed live, with notes when it ends. Everything stays on your PC.",
  mt_title_label: "Title",
  mt_start: "Start meeting",
  mt_stop: "Stop",
  mt_recording: "● Recording {time}",
  mt_reminder_consent: "Let the others know you're recording.",
  mt_reminder_headphones: "Headphones keep your microphone from picking up the others.",
  mt_reminder_dismiss: "Don't show again",
  mt_warn_mic: "Microphone lost — retrying",
  mt_warn_pc: "PC sound lost — retrying",
  mt_warn_no_pc: "No sound from the PC yet — is the call playing on this PC?",
  mt_paused: "Transcription paused while the models are unloaded (Free GPU); it catches up when they are loaded again.",
  mt_finishing: "Finishing “{title}”: {step}…",
  mt_this_meeting: "a meeting",
  mt_step_transcribing: "Transcribing the last minute",
  mt_step_speakers: "Telling the speakers apart",
  mt_step_notes: "Writing the notes",
  mt_you: "You",
  mt_others: "Others",
  mt_notes: "Notes",
  mt_summary: "Summary",
  mt_decisions: "Decisions",
  mt_actions: "Action items",
  mt_none: "None mentioned.",
  mt_copy_all: "Copy all",
  mt_jump_live: "Jump to live",
  mt_play: "Play from here",
  mt_stop_play: "Stop playing",
  mt_back: "← All meetings",
  mt_rename: "Click to rename",
  mt_delete: "Delete",
  mt_delete_confirm: "Delete? Click again",
  mt_library: "Your meetings",
  mt_search: "Search titles and transcripts",
  mt_empty: "No meetings yet.",
  mt_no_match: "No meeting matches.",
  mt_state_recording: "Recording",
  mt_state_finishing: "Finishing",
  mt_state_interrupted: "Interrupted",
  mt_finish: "Finish",
  mt_interrupted_hint: "This meeting was cut off (RudariFlow quit or crashed). Finish transcribes the rest and writes the notes.",
  mt_write_notes: "Write notes",
  mt_hint_notes_ai_off: "No notes: AI cleanup is off. Write notes uses the AI model anyway.",
  mt_hint_notes_no_ai_model: "No notes: the AI model is not downloaded (AI cleanup tab).",
  mt_hint_notes_gpu_freed: "No notes: the AI model was unloaded (Free GPU).",
  mt_hint_notes_empty: "Nothing was said, so there are no notes.",
  mt_hint_notes_error: "No notes: {error}",
  mt_hint_speakers_no_model: "The others are not told apart: the speaker model (45 MB) is not downloaded. Download it for your next meetings.",
  mt_hint_speakers_no_runtime: "The others are not told apart: the speaker runtime is missing; installing RudariFlow again brings it back.",
  mt_hint_speakers_error: "The others are not told apart: {error}",
  mt_audio_deleted: "The audio was deleted 30 days after the meeting; the text stays.",
  mt_err_already: "A meeting is already recording.",
  mt_err_no_model: "Download a Whisper model first (Engine tab).",
  mt_err_disk: "Less than 1 GB is free on the drive with RudariFlow's data; an hour of meeting takes about 230 MB.",
  mt_err_busy: "This meeting is still being finished.",
  mt_quit_question: "Stop the meeting and quit?",
  mt_quit_hint: "The meeting is kept as interrupted; Finish in the Meetings tab transcribes the rest and writes the notes.",
  mt_quit_ok: "Stop and quit",
  meeting_hotkey_label: "Start / stop a meeting",
  meeting_hotkey_hint: "Starts a meeting in the Meetings tab, or stops the one that records.",
```

and at the end of `const de` (after its `hotkey_bare: …`):

```ts
  nav_meetings: "Meetings",
  mt_title: "Meetings",
  mt_desc: "Nimm ein Online-Gespräch auf diesem PC auf (Teams, Zoom, Discord, Google Meet …): dein Mikrofon und was der PC abspielt, live transkribiert, mit Notizen am Ende. Alles bleibt auf deinem PC.",
  mt_title_label: "Titel",
  mt_start: "Meeting starten",
  mt_stop: "Beenden",
  mt_recording: "● Aufnahme {time}",
  mt_reminder_consent: "Sag den anderen, dass du aufnimmst.",
  mt_reminder_headphones: "Mit Kopfhörern nimmt dein Mikrofon die anderen nicht mit auf.",
  mt_reminder_dismiss: "Nicht mehr anzeigen",
  mt_warn_mic: "Mikrofon weg – neuer Versuch läuft",
  mt_warn_pc: "PC-Ton weg – neuer Versuch läuft",
  mt_warn_no_pc: "Noch kein Ton vom PC – läuft das Gespräch auf diesem PC?",
  mt_paused: "Die Transkription pausiert, solange die Modelle entladen sind (GPU freigeben); sie holt auf, sobald sie wieder geladen sind.",
  mt_finishing: "„{title}“ wird abgeschlossen: {step} …",
  mt_this_meeting: "ein Meeting",
  mt_step_transcribing: "Die letzte Minute wird transkribiert",
  mt_step_speakers: "Die Sprecher werden unterschieden",
  mt_step_notes: "Die Notizen werden geschrieben",
  mt_you: "Du",
  mt_others: "Andere",
  mt_notes: "Notizen",
  mt_summary: "Zusammenfassung",
  mt_decisions: "Entscheidungen",
  mt_actions: "Aufgaben",
  mt_none: "Nichts erwähnt.",
  mt_copy_all: "Alles kopieren",
  mt_jump_live: "Zum Live-Text",
  mt_play: "Ab hier abspielen",
  mt_stop_play: "Wiedergabe stoppen",
  mt_back: "← Alle Meetings",
  mt_rename: "Zum Umbenennen klicken",
  mt_delete: "Löschen",
  mt_delete_confirm: "Löschen? Nochmals klicken",
  mt_library: "Deine Meetings",
  mt_search: "Titel und Transkripte durchsuchen",
  mt_empty: "Noch keine Meetings.",
  mt_no_match: "Kein Meeting passt.",
  mt_state_recording: "Aufnahme",
  mt_state_finishing: "Wird abgeschlossen",
  mt_state_interrupted: "Unterbrochen",
  mt_finish: "Abschließen",
  mt_interrupted_hint: "Dieses Meeting wurde abgebrochen (RudariFlow wurde beendet oder ist abgestürzt). „Abschließen“ transkribiert den Rest und schreibt die Notizen.",
  mt_write_notes: "Notizen schreiben",
  mt_hint_notes_ai_off: "Keine Notizen: Die KI-Korrektur ist aus. „Notizen schreiben“ nutzt das KI-Modell trotzdem.",
  mt_hint_notes_no_ai_model: "Keine Notizen: Das KI-Modell ist nicht heruntergeladen (Tab KI-Korrektur).",
  mt_hint_notes_gpu_freed: "Keine Notizen: Das KI-Modell wurde entladen (GPU freigeben).",
  mt_hint_notes_empty: "Es wurde nichts gesagt, darum gibt es keine Notizen.",
  mt_hint_notes_error: "Keine Notizen: {error}",
  mt_hint_speakers_no_model: "Die anderen werden nicht unterschieden: Das Sprechermodell (45 MB) ist nicht heruntergeladen. Lade es für deine nächsten Meetings herunter.",
  mt_hint_speakers_no_runtime: "Die anderen werden nicht unterschieden: Die Sprecher-Laufzeit fehlt; RudariFlow neu installieren bringt sie zurück.",
  mt_hint_speakers_error: "Die anderen werden nicht unterschieden: {error}",
  mt_audio_deleted: "Der Ton wurde 30 Tage nach dem Meeting gelöscht; der Text bleibt.",
  mt_err_already: "Es wird schon ein Meeting aufgenommen.",
  mt_err_no_model: "Lade zuerst ein Whisper-Modell herunter (Tab Engine).",
  mt_err_disk: "Auf dem Laufwerk mit den Daten von RudariFlow ist weniger als 1 GB frei; eine Stunde Meeting braucht etwa 230 MB.",
  mt_err_busy: "Dieses Meeting wird noch abgeschlossen.",
  mt_quit_question: "Meeting beenden und RudariFlow schließen?",
  mt_quit_hint: "Das Meeting bleibt als unterbrochen erhalten; „Abschließen“ im Tab Meetings transkribiert den Rest und schreibt die Notizen.",
  mt_quit_ok: "Beenden und schließen",
  meeting_hotkey_label: "Meeting starten / beenden",
  meeting_hotkey_hint: "Startet ein Meeting im Tab Meetings oder beendet das laufende.",
```

- [ ] **Step 3: Styles**

Append to `src/style.css`:

```css

/* ── Meetings ───────────────────────────────────────── */

.mt-start {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.mt-title-input,
.mt-search,
.mt-title-edit {
  flex: 1 1 auto;
  min-width: 0;
  padding: 7px 10px;
  font: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
}
.mt-title-input:focus-visible,
.mt-search:focus-visible,
.mt-title-edit:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.mt-error { color: var(--red); }

.mt-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px 8px 14px;
  margin-bottom: 6px;
  background: rgba(229, 72, 77, 0.12);
  border: 1px solid var(--red);
  border-radius: var(--radius-lg);
}
.mt-bar-time {
  color: var(--red);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.mt-bar-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}
.mt-warning {
  font-size: 12px;
  color: var(--yellow);
  margin-bottom: 4px;
}
.mt-reminder {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.mt-finishing-line { margin-bottom: 4px; }

.mt-view {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 24px;
}
.mt-view-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.mt-view-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.mt-view-title {
  font-size: 15px;
  font-weight: 600;
  cursor: text;
  overflow-wrap: anywhere;
}
.mt-hint {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mt-hint-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-secondary);
}

.mt-notes {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 14px 12px;
  background: var(--surface);
  border: 1px solid var(--accent);
  border-radius: var(--radius-lg);
  user-select: text;
  -webkit-user-select: text;
}
.mt-notes-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.mt-notes-head h4 {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}
.mt-notes-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.55;
}
.mt-notes ul {
  padding-left: 18px;
  line-height: 1.55;
}
.mt-checklist {
  list-style: none;
  padding-left: 0 !important;
}
.mt-checklist label {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  cursor: pointer;
}
.mt-checklist input {
  margin-top: 4px;
  accent-color: var(--accent);
}
.mt-checklist input:checked + span {
  color: var(--text-secondary);
  text-decoration: line-through;
}

.mt-transcript {
  max-height: 55vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  user-select: text;
  -webkit-user-select: text;
}
.mt-transcript:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.mt-para-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.mt-para-time {
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.mt-para-who {
  font-weight: 600;
}
.mt-para[data-track="you"] .mt-para-who { color: var(--accent-hover); }
.mt-para-text {
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.mt-play {
  width: 22px;
  height: 22px;
  font-size: 10px;
}
.mt-live {
  align-self: center;
}

.mt-library-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 16px 0 8px;
}
.mt-library-title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
}
.mt-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 24px;
}
.mt-item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 12px;
  padding: 10px 14px;
  text-align: left;
  font: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  cursor: pointer;
}
.mt-item:hover { background: var(--surface-hover); }
.mt-item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.mt-item-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mt-item .label-hint { grid-column: 1; }
.mt-badge {
  grid-column: 2;
  grid-row: 1 / span 2;
  align-self: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: var(--accent-subtle);
  color: var(--text);
}
.mt-badge[data-state="recording"] { background: rgba(229, 72, 77, 0.18); color: var(--red); }
.mt-badge[data-state="interrupted"] { background: rgba(245, 166, 35, 0.16); color: var(--yellow); }

.mt-modal {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}
.mt-modal-box {
  max-width: 380px;
  margin: 0 16px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
}
.mt-modal-question {
  font-size: 14px;
  font-weight: 600;
}
.mt-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
```

- [ ] **Step 4: The tab's code**

Create `src/meetings.ts`:

```ts
// Meetings tab: record an online call on this PC (the microphone as "You",
// what the PC plays as "Others"), see the transcript live, and keep every
// meeting with its notes, speakers and (for 30 days) audio. The work runs in
// the backend (`meeting_*` commands, src-tauri/src/meeting/).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { getLang, t } from "./i18n";

export interface MeetingsHost {
  settings(): { meetingReminderOff: boolean; meetingHeadphonesSeen: boolean };
  saveSettings(patch: { meetingReminderOff?: boolean; meetingHeadphonesSeen?: boolean }): Promise<void>;
  /** Show the Meetings section (a meeting started from the tray or hotkey). */
  showSection(): void;
}

type Track = "you" | "others";
type MeetingState = "recording" | "finishing" | "finished" | "interrupted";
type Step = "transcribing" | "speakers" | "notes";
type Warning = "micLost" | "pcLost" | "noPcSound";

interface Line {
  startMs: number;
  endMs: number;
  track: Track;
  speaker?: number;
  text: string;
}

interface ActionItem {
  text: string;
  done: boolean;
}

interface Notes {
  summary: string;
  decisions: string[];
  actionItems: ActionItem[];
}

interface Meeting {
  id: string;
  title: string;
  startedAt: number;
  lengthMs: number;
  language: string;
  state: MeetingState;
  lines: Line[];
  speakerNames: string[];
  notes?: Notes;
  speakersError?: string;
  notesError?: string;
  audioDeleted: boolean;
}

interface Paragraph {
  startMs: number;
  track: Track;
  speaker?: number;
  text: string;
}

interface MeetingView {
  meeting: Meeting;
  paragraphs: Paragraph[];
}

interface Recording {
  id: string;
  title: string;
  startedAt: number;
  warnings: Warning[];
  paused: boolean;
}

interface Status {
  recording: Recording | null;
  finishing: { id: string; step: Step }[];
}

interface Summary {
  id: string;
  title: string;
  startedAt: number;
  lengthMs: number;
  state: MeetingState;
  audioDeleted: boolean;
}

interface LinesChanged {
  id: string;
  from: number;
  paragraphs: Paragraph[];
}

interface Playing {
  id: string;
  fromMs: number;
}

const $ = (id: string) => document.getElementById(id)!;
const startPanel = $("mt-start");
const titleInput = $("mt-title") as HTMLInputElement;
const startBtn = $("mt-start-btn") as HTMLButtonElement;
const startError = $("mt-start-error");
const bar = $("mt-bar");
const barTime = $("mt-bar-time");
const barTitle = $("mt-bar-title");
const stopBtn = $("mt-stop-btn") as HTMLButtonElement;
const warningsEl = $("mt-warnings");
const reminder = $("mt-reminder");
const reminderText = $("mt-reminder-text");
const reminderClose = $("mt-reminder-close") as HTMLButtonElement;
const finishingEl = $("mt-finishing");
const viewEl = $("mt-view");
const backBtn = $("mt-back") as HTMLButtonElement;
const viewTitle = $("mt-view-title");
const viewMeta = $("mt-view-meta");
const copyBtn = $("mt-copy") as HTMLButtonElement;
const exportBtn = $("mt-export") as HTMLButtonElement;
const exportList = $("mt-export-list");
const exportMenu = $("mt-export-menu");
const deleteBtn = $("mt-delete") as HTMLButtonElement;
const hintEl = $("mt-hint");
const notesEl = $("mt-notes");
const speakersRow = $("mt-speakers");
const speakerChips = $("mt-speaker-chips");
const transcriptEl = $("mt-transcript");
const liveBtn = $("mt-live") as HTMLButtonElement;
const listEl = $("mt-list");
const emptyEl = $("mt-empty");
const searchInput = $("mt-search") as HTMLInputElement;
const quitDialog = $("mt-quit");
const quitOk = $("mt-quit-ok") as HTMLButtonElement;
const quitCancel = $("mt-quit-cancel") as HTMLButtonElement;

let host: MeetingsHost;
let status: Status = { recording: null, finishing: [] };
let view: MeetingView | null = null;
let playing: Playing | null = null;
/** The live transcript scrolls along until the user scrolls up. */
let following = true;
/** The headphones hint shows during the first meeting only. */
let headphonesThisMeeting = false;
let clockTimer: number | undefined;
let searchTimer: number | undefined;
let deleteArmed: number | undefined;

/// "4:05" or "1:02:03", like the backend's `clock`.
function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${Math.floor(s / 60)}:${ss}`;
}

function when(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString(getLang(), { day: "numeric", month: "short", year: "numeric" })}, ${d.toLocaleTimeString(getLang(), { hour: "2-digit", minute: "2-digit" })}`;
}

function errorText(e: unknown): string {
  const code = String(e);
  const key: Record<string, string> = {
    already_recording: "mt_err_already",
    no_model: "mt_err_no_model",
    disk_full: "mt_err_disk",
    no_ai_model: "mt_hint_notes_no_ai_model",
    no_audio: "mt_audio_deleted",
    busy: "mt_err_busy",
  };
  return key[code] ? t(key[code]) : `${t("files_err_failed")}: ${code}`;
}

/** Who said a paragraph or line: You, Others, or a speaker's name. */
function who(track: Track, speaker: number | undefined, names: string[]): string {
  if (track === "you") return t("mt_you");
  if (speaker === undefined) return t("mt_others");
  return names[speaker]?.trim() || t("files_speaker_n").replace("{n}", String(speaker + 1));
}

function speakerCount(m: Meeting): number {
  return m.lines.reduce((n, l) => (l.speaker !== undefined ? Math.max(n, l.speaker + 1) : n), 0);
}

function stepText(step: Step): string {
  return t(`mt_step_${step}`);
}

async function copy(text: string, button: HTMLButtonElement, label: string) {
  await invoke("copy_text", { text });
  button.textContent = t("pc_check_copied");
  setTimeout(() => (button.textContent = t(label)), 1500);
}

// ── Recording bar ─────────────────────────────────────

function renderStatus() {
  const rec = status.recording;
  startPanel.classList.toggle("hidden", !!rec);
  bar.classList.toggle("hidden", !rec);
  window.clearInterval(clockTimer);
  if (rec) {
    const tick = () => (barTime.textContent = t("mt_recording").replace("{time}", clock(Date.now() - rec.startedAt)));
    tick();
    clockTimer = window.setInterval(tick, 1000);
    barTitle.textContent = rec.title;
  }
  warningsEl.replaceChildren();
  const lines: string[] = [];
  for (const w of rec?.warnings ?? []) lines.push(t({ micLost: "mt_warn_mic", pcLost: "mt_warn_pc", noPcSound: "mt_warn_no_pc" }[w]));
  if (rec?.paused) lines.push(t("mt_paused"));
  for (const text of lines) {
    const p = document.createElement("p");
    p.className = "mt-warning";
    p.textContent = text;
    warningsEl.append(p);
  }
  renderReminder();
  finishingEl.replaceChildren();
  for (const f of status.finishing) {
    const p = document.createElement("p");
    p.className = "label-hint mt-finishing-line";
    const title = view?.meeting.id === f.id ? view.meeting.title : "";
    p.textContent = t("mt_finishing").replace("{title}", title || t("mt_this_meeting")).replace("{step}", stepText(f.step));
    finishingEl.append(p);
  }
}

function renderReminder() {
  const settings = host.settings();
  const parts: string[] = [];
  if (status.recording) {
    if (!settings.meetingReminderOff) parts.push(t("mt_reminder_consent"));
    if (headphonesThisMeeting) parts.push(t("mt_reminder_headphones"));
  }
  reminderText.textContent = parts.join(" ");
  reminder.classList.toggle("hidden", parts.length === 0);
}

async function start() {
  startBtn.disabled = true;
  startError.classList.add("hidden");
  try {
    await invoke<string>("meeting_start", { title: titleInput.value.trim() || null });
    titleInput.value = "";
  } catch (e) {
    startError.textContent = errorText(e);
    startError.classList.remove("hidden");
  } finally {
    startBtn.disabled = false;
  }
}

async function stop() {
  stopBtn.disabled = true;
  try {
    await invoke("meeting_stop");
  } catch (e) {
    console.error("meeting_stop failed:", e);
  } finally {
    stopBtn.disabled = false;
  }
}

/** A meeting started (here, in the tray or by hotkey): open its live view. */
async function onStarted(rec: Recording) {
  following = true;
  if (!host.settings().meetingHeadphonesSeen) {
    headphonesThisMeeting = true;
    await host.saveSettings({ meetingHeadphonesSeen: true });
  }
  await open(rec.id);
  host.showSection();
}

// ── One meeting ───────────────────────────────────────

async function open(id: string) {
  try {
    view = await invoke<MeetingView>("meeting_get", { id });
  } catch (e) {
    console.error("meeting_get failed:", e);
    view = null;
  }
  renderView();
}

function closeView() {
  view = null;
  renderView();
  void refreshList();
}

function renderView() {
  viewEl.classList.toggle("hidden", !view);
  $("mt-library").classList.toggle("hidden", !!view);
  setExportMenu(false);
  resetDelete();
  if (!view) return;
  const m = view.meeting;
  const live = m.state === "recording";
  viewTitle.textContent = m.title;
  viewMeta.textContent = live ? when(m.startedAt) : `${clock(m.lengthMs)} · ${when(m.startedAt)}`;
  exportBtn.disabled = live || m.lines.length === 0;
  deleteBtn.disabled = live || m.state === "finishing";
  renderHints(m);
  renderNotes(m);
  renderSpeakers(m);
  renderTranscript(0);
  liveBtn.classList.toggle("hidden", !live || following);
}

function hint(text: string, action?: { label: string; run: (b: HTMLButtonElement) => void }) {
  const row = document.createElement("div");
  row.className = "mt-hint-row";
  const span = document.createElement("span");
  span.textContent = text;
  row.append(span);
  if (action) {
    const b = document.createElement("button");
    b.className = "btn-ghost";
    b.textContent = action.label;
    b.addEventListener("click", () => action.run(b));
    row.append(b);
  }
  hintEl.append(row);
}

function renderHints(m: Meeting) {
  hintEl.replaceChildren();
  const finishing = status.finishing.find((f) => f.id === m.id);
  if (finishing) hint(t("mt_finishing").replace("{title}", m.title).replace("{step}", stepText(finishing.step)));
  if (m.state === "interrupted") {
    hint(t("mt_interrupted_hint"), {
      label: t("mt_finish"),
      run: async (b) => {
        b.disabled = true;
        try {
          await invoke("meeting_finish", { id: m.id });
        } catch (e) {
          b.disabled = false;
          b.textContent = errorText(e);
        }
      },
    });
  }
  if (m.state === "finished" && m.speakersError && m.speakersError !== "none_found") {
    const known = ["no_model", "no_runtime"].includes(m.speakersError);
    const text = known ? t(`mt_hint_speakers_${m.speakersError}`) : t("mt_hint_speakers_error").replace("{error}", m.speakersError);
    hint(
      text,
      m.speakersError === "no_model"
        ? {
            label: t("download"),
            run: async (b) => {
              b.disabled = true;
              try {
                await invoke("speaker_model_download");
                b.textContent = "✓";
              } catch {
                b.disabled = false;
                b.textContent = t("files_speakers_download_failed");
              }
            },
          }
        : undefined,
    );
  }
  if (m.state === "finished" && !m.notes && m.notesError) {
    const known = ["ai_off", "no_ai_model", "gpu_freed", "empty"].includes(m.notesError);
    const text = known ? t(`mt_hint_notes_${m.notesError}`) : t("mt_hint_notes_error").replace("{error}", m.notesError);
    hint(
      text,
      m.notesError === "empty"
        ? undefined
        : {
            label: t("mt_write_notes"),
            run: async (b) => {
              b.disabled = true;
              try {
                await invoke("meeting_write_notes", { id: m.id });
              } catch (e) {
                b.disabled = false;
                b.textContent = errorText(e);
              }
            },
          },
    );
  }
  if (m.audioDeleted) hint(t("mt_audio_deleted"));
  hintEl.classList.toggle("hidden", hintEl.childElementCount === 0);
}

/** A notes section as text, for its copy button and the exports. */
function sectionText(m: Meeting, key: "summary" | "decisions" | "actions"): string {
  const n = m.notes!;
  if (key === "summary") return n.summary || t("mt_none");
  if (key === "decisions") return n.decisions.length ? n.decisions.map((d) => `- ${d}`).join("\n") : t("mt_none");
  return n.actionItems.length ? n.actionItems.map((a) => `- [${a.done ? "x" : " "}] ${a.text}`).join("\n") : t("mt_none");
}

function notesText(m: Meeting): string {
  return (["summary", "decisions", "actions"] as const)
    .map((k) => `${t(`mt_${k}`)}\n${sectionText(m, k)}`)
    .join("\n\n");
}

function renderNotes(m: Meeting) {
  notesEl.replaceChildren();
  notesEl.classList.toggle("hidden", !m.notes);
  if (!m.notes) return;
  for (const key of ["summary", "decisions", "actions"] as const) {
    const section = document.createElement("section");
    section.className = "mt-notes-section";
    const head = document.createElement("div");
    head.className = "mt-notes-head";
    const h = document.createElement("h4");
    h.textContent = t(`mt_${key}`);
    const copyOne = document.createElement("button");
    copyOne.className = "btn-ghost";
    copyOne.textContent = t("files_copy");
    copyOne.addEventListener("click", () => copy(sectionText(m, key), copyOne, "files_copy"));
    head.append(h, copyOne);
    section.append(head);
    const n = m.notes;
    const empty = key === "summary" ? !n.summary : key === "decisions" ? !n.decisions.length : !n.actionItems.length;
    if (empty) {
      const p = document.createElement("p");
      p.className = "label-hint";
      p.textContent = t("mt_none");
      section.append(p);
    } else if (key === "summary") {
      const p = document.createElement("p");
      p.className = "mt-notes-text";
      p.textContent = n.summary;
      section.append(p);
    } else if (key === "decisions") {
      const ul = document.createElement("ul");
      for (const d of n.decisions) {
        const li = document.createElement("li");
        li.textContent = d;
        ul.append(li);
      }
      section.append(ul);
    } else {
      const ul = document.createElement("ul");
      ul.className = "mt-checklist";
      n.actionItems.forEach((a, index) => {
        const li = document.createElement("li");
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = a.done;
        box.addEventListener("change", async () => {
          try {
            await invoke("meeting_set_action_done", { id: m.id, index, done: box.checked });
            a.done = box.checked;
          } catch (e) {
            box.checked = !box.checked;
            console.error("meeting_set_action_done failed:", e);
          }
        });
        const span = document.createElement("span");
        span.textContent = a.text;
        label.append(box, span);
        li.append(label);
        ul.append(li);
      });
      section.append(ul);
    }
    notesEl.append(section);
  }
}

function renderSpeakers(m: Meeting) {
  speakerChips.replaceChildren();
  const count = speakerCount(m);
  speakersRow.classList.toggle("hidden", count === 0);
  for (let i = 0; i < count; i++) {
    const chip = document.createElement("button");
    chip.className = "speaker-chip";
    chip.textContent = who("others", i, m.speakerNames);
    chip.title = t("files_speaker_rename");
    chip.addEventListener("click", () => renameSpeaker(m, i, chip));
    speakerChips.append(chip);
  }
}

function renameSpeaker(m: Meeting, i: number, chip: HTMLButtonElement) {
  const input = document.createElement("input");
  input.className = "speaker-chip-input";
  input.value = chip.textContent ?? "";
  chip.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const apply = async (keep: boolean) => {
    if (done) return;
    done = true;
    if (keep) {
      try {
        await invoke("meeting_rename_speaker", { id: m.id, speaker: i, name: input.value.trim() });
      } catch (e) {
        console.error("meeting_rename_speaker failed:", e);
      }
    }
    if (view?.meeting.id === m.id) await open(m.id);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") apply(true);
    if (e.key === "Escape") apply(false);
  });
  input.addEventListener("blur", () => apply(true));
}

/** Redraw the paragraphs from index `from` on. */
function renderTranscript(from: number) {
  if (!view) return;
  const m = view.meeting;
  while (transcriptEl.children.length > from) transcriptEl.lastElementChild!.remove();
  const canPlay = m.state !== "recording" && !m.audioDeleted;
  view.paragraphs.slice(from).forEach((p) => {
    const row = document.createElement("div");
    row.className = "mt-para";
    row.dataset.track = p.track;
    const head = document.createElement("div");
    head.className = "mt-para-head";
    if (canPlay) {
      const play = document.createElement("button");
      play.className = "icon-btn mt-play";
      const isPlaying = playing?.id === m.id && playing.fromMs === p.startMs;
      play.textContent = isPlaying ? "■" : "▶";
      play.title = t(isPlaying ? "mt_stop_play" : "mt_play");
      play.setAttribute("aria-label", play.title);
      play.addEventListener("click", () => togglePlay(m.id, p.startMs));
      head.append(play);
    }
    const time = document.createElement("span");
    time.className = "mt-para-time";
    time.textContent = clock(p.startMs);
    const name = document.createElement("span");
    name.className = "mt-para-who";
    name.textContent = who(p.track, p.speaker, m.speakerNames);
    head.append(time, name);
    const text = document.createElement("p");
    text.className = "mt-para-text";
    text.textContent = p.text;
    row.append(head, text);
    transcriptEl.append(row);
  });
  if (m.state === "recording" && following) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

async function togglePlay(id: string, fromMs: number) {
  try {
    if (playing?.id === id && playing.fromMs === fromMs) await invoke("meeting_stop_playing");
    else await invoke("meeting_play", { id, fromMs });
  } catch (e) {
    hintEl.classList.remove("hidden");
    hint(errorText(e));
  }
}

/** The transcript as text: "[4:05] You: …" paragraphs. */
function transcriptText(): string {
  if (!view) return "";
  const names = view.meeting.speakerNames;
  return view.paragraphs.map((p) => `[${clock(p.startMs)}] ${who(p.track, p.speaker, names)}: ${p.text}`).join("\n\n");
}

function renameTitle() {
  if (!view) return;
  const m = view.meeting;
  const input = document.createElement("input");
  input.className = "mt-title-edit";
  input.value = m.title;
  viewTitle.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const apply = async (keep: boolean) => {
    if (done) return;
    done = true;
    input.replaceWith(viewTitle);
    if (keep && input.value.trim() && input.value.trim() !== m.title) {
      try {
        await invoke("meeting_rename", { id: m.id, title: input.value.trim() });
      } catch (e) {
        console.error("meeting_rename failed:", e);
      }
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") apply(true);
    if (e.key === "Escape") apply(false);
  });
  input.addEventListener("blur", () => apply(true));
}

type ExportKind = "pdf" | "docx" | "srt" | "vtt" | "txt";

function setExportMenu(isOpen: boolean) {
  exportList.classList.toggle("hidden", !isOpen);
  exportBtn.setAttribute("aria-expanded", String(isOpen));
}

/** Export with the Files tab's exporters: the lines as segments (0 You,
 *  1 Others, 2 + n Speaker n+1), the notes on top for PDF, Word and text. */
async function exportAs(kind: ExportKind) {
  setExportMenu(false);
  if (!view) return;
  const m = view.meeting;
  const path = await save({
    defaultPath: `${m.title.replace(/[\\/:*?"<>|]/g, "-")}.${kind}`,
    filters: [{ name: t(`files_filter_${kind}`), extensions: [kind] }],
  });
  if (!path) return;
  const count = speakerCount(m);
  const names = [t("mt_you"), t("mt_others"), ...Array.from({ length: count }, (_, i) => who("others", i, m.speakerNames))];
  const segments = m.lines.map((l) => ({
    startMs: l.startMs,
    endMs: l.endMs,
    text: l.text,
    speaker: l.track === "you" ? 0 : l.speaker === undefined ? 1 : l.speaker + 2,
  }));
  const doc = {
    title: m.title,
    meta: `${clock(m.lengthMs)} · ${when(m.startedAt)}`,
    segments,
    names,
    times: true,
    summary: m.notes ? notesText(m) : null,
    summaryTitle: t("mt_notes"),
    transcriptTitle: t("files_transcript"),
  };
  hintEl.replaceChildren();
  try {
    await invoke("export_file", { kind, path, doc });
    hint(t("files_exported").replace("{name}", path.split(/[\\/]/).pop() ?? path));
  } catch (e) {
    hint(`${t("files_err_failed")}: ${e}`);
  }
  hintEl.classList.remove("hidden");
}

function resetDelete() {
  window.clearTimeout(deleteArmed);
  deleteArmed = undefined;
  deleteBtn.classList.remove("armed");
  deleteBtn.textContent = t("mt_delete");
}

async function deleteMeeting() {
  if (!view) return;
  if (deleteArmed === undefined) {
    deleteBtn.classList.add("armed");
    deleteBtn.textContent = t("mt_delete_confirm");
    deleteArmed = window.setTimeout(resetDelete, 3000);
    return;
  }
  try {
    await invoke("meeting_delete", { id: view.meeting.id });
    closeView();
  } catch (e) {
    resetDelete();
    hint(errorText(e));
    hintEl.classList.remove("hidden");
  }
}

// ── Library ───────────────────────────────────────────

async function refreshList() {
  let items: Summary[] = [];
  try {
    items = await invoke<Summary[]>("meeting_list", { query: searchInput.value });
  } catch (e) {
    console.error("meeting_list failed:", e);
  }
  listEl.replaceChildren();
  for (const s of items) listEl.append(renderItem(s));
  emptyEl.textContent = searchInput.value.trim() ? t("mt_no_match") : t("mt_empty");
  emptyEl.classList.toggle("hidden", items.length > 0);
}

function renderItem(s: Summary): HTMLElement {
  const item = document.createElement("button");
  item.className = "mt-item";
  const title = document.createElement("span");
  title.className = "mt-item-title";
  title.textContent = s.title;
  const meta = document.createElement("span");
  meta.className = "label-hint";
  const parts = [when(s.startedAt)];
  if (s.state !== "recording") parts.push(clock(s.lengthMs));
  meta.textContent = parts.join(" · ");
  item.append(title, meta);
  if (s.state !== "finished") {
    const badge = document.createElement("span");
    badge.className = "mt-badge";
    badge.dataset.state = s.state;
    badge.textContent = t(`mt_state_${s.state}`);
    item.append(badge);
  }
  item.addEventListener("click", () => {
    following = true;
    void open(s.id);
  });
  return item;
}

// ── Wiring ────────────────────────────────────────────

/** Fill the tab again (on show and after a language change). */
export async function renderMeetings() {
  try {
    titleInput.placeholder = await invoke<string>("meeting_default_title");
  } catch {
    titleInput.placeholder = "";
  }
  renderStatus();
  renderView();
  if (!view) await refreshList();
}

export async function initMeetings(h: MeetingsHost) {
  host = h;
  startBtn.addEventListener("click", start);
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") start();
  });
  stopBtn.addEventListener("click", stop);
  reminderClose.addEventListener("click", async () => {
    headphonesThisMeeting = false;
    await host.saveSettings({ meetingReminderOff: true, meetingHeadphonesSeen: true });
    renderReminder();
  });
  backBtn.addEventListener("click", closeView);
  viewTitle.addEventListener("click", renameTitle);
  copyBtn.addEventListener("click", () => copy(transcriptText(), copyBtn, "mt_copy_all"));
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setExportMenu(exportList.classList.contains("hidden"));
  });
  exportList.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((b) =>
    b.addEventListener("click", () => exportAs(b.dataset.kind as ExportKind)),
  );
  document.addEventListener("click", () => setExportMenu(false));
  exportMenu.addEventListener("focusout", (e) => {
    const next = (e as FocusEvent).relatedTarget as Node | null;
    if (!next || !exportMenu.contains(next)) setExportMenu(false);
  });
  deleteBtn.addEventListener("click", deleteMeeting);
  // Scrolling up stops the following; Jump to live starts it again.
  transcriptEl.addEventListener("scroll", () => {
    if (view?.meeting.state !== "recording") return;
    const atEnd = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 24;
    following = atEnd;
    liveBtn.classList.toggle("hidden", atEnd);
  });
  liveBtn.addEventListener("click", () => {
    following = true;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    liveBtn.classList.add("hidden");
  });
  searchInput.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(refreshList, 200);
  });
  quitOk.addEventListener("click", () => invoke("meeting_quit"));
  quitCancel.addEventListener("click", () => quitDialog.classList.add("hidden"));
  quitDialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") quitDialog.classList.add("hidden");
  });

  await listen<Status>("meeting-status", (e) => {
    const before = status.recording?.id;
    status = e.payload;
    const now = status.recording;
    if (now && now.id !== before) void onStarted(now);
    if (!now && before) headphonesThisMeeting = false;
    renderStatus();
    if (view) renderHints(view.meeting);
  });
  await listen<LinesChanged>("meeting-lines", (e) => {
    if (!view || view.meeting.id !== e.payload.id) return;
    view.paragraphs = view.paragraphs.slice(0, e.payload.from).concat(e.payload.paragraphs);
    renderTranscript(e.payload.from);
  });
  await listen("meetings-changed", async () => {
    if (view) await open(view.meeting.id);
    else await refreshList();
  });
  await listen<Playing | null>("meeting-playing", (e) => {
    playing = e.payload;
    if (view) renderTranscript(0);
  });
  await listen("meeting-quit-asked", () => {
    quitDialog.classList.remove("hidden");
    quitOk.focus();
  });

  const current = await invoke<{ status: Status; meeting: MeetingView | null }>("meeting_state");
  status = current.status;
  if (current.meeting) view = current.meeting;
  await renderMeetings();
}
```

What it does, for the reviewer: the start row (title with the default title as placeholder, **Start meeting**), the red bar with the running clock and **Stop**, the warnings (lost devices, no PC sound, paused transcription), the reminder (consent always until dismissed for good; the headphones sentence during the first meeting only), "Finishing …: <step>" lines, one meeting's view (live with following and **Jump to live**, or saved with notes, checklist, speaker chips, ▶ per paragraph, Copy all, Export, Delete that asks once, rename by clicking the title) and the library (newest first, search by title and transcript, badges Recording / Finishing / Interrupted).

- [ ] **Step 5: Wire it into main.ts and the hotkey capture**

In `src/main.ts`:

1. Below `import { initFiles, renderFiles } from "./files";` add `import { initMeetings, renderMeetings } from "./meetings";`.
2. In `interface Settings`, after `fileSpeakers: string;` add:

```ts
  meetingHotkey: string;
  meetingReminderOff: boolean;
  meetingHeadphonesSeen: boolean;
```

3. Below `const freeGpuClear = …;` add:

```ts
const meetingHotkeyBtn = document.getElementById("meeting-hotkey-btn") as HTMLButtonElement;
const meetingHotkeyText = document.getElementById("meeting-hotkey-text")!;
const meetingHotkeyClear = document.getElementById("meeting-hotkey-clear") as HTMLButtonElement;
```

4. In `showSection`, after `soundboard.setActive(target === "soundboard");` add `if (target === "meetings") void renderMeetings();`.
5. In the `uiLanguageSelect` change listener, after `void soundboard.refresh();` add `void renderMeetings();`.
6. Replace the hotkey comment's last lines and the type:

```ts
// unloads the models or loads them again, "meeting" starts or stops a
// meeting. Each takes a key combination or a mouse side button (with or
// without modifiers); the capture itself is in hotkey-capture.ts, shared with
// the Soundboard.
type HotkeyTarget = "dictation" | "pasteLast" | "rewriteLast" | "freeGpu" | "meeting";
```

7. In `renderHotkeys`, at the end add:

```ts
  meetingHotkeyText.textContent = hotkeyLabel(currentSettings.meetingHotkey);
  meetingHotkeyClear.classList.toggle("hidden", !currentSettings.meetingHotkey);
```

8. In `captureElements`, before `return { btn: freeGpuBtn, text: freeGpuText };` add `if (target === "meeting") return { btn: meetingHotkeyBtn, text: meetingHotkeyText };`.
9. In `setHotkey`, before `else currentSettings.freeGpuHotkey = combo;` add `else if (target === "meeting") currentSettings.meetingHotkey = combo;`.
10. After the `freeGpuClear` click listener add:

```ts
meetingHotkeyBtn.addEventListener("click", () => capture("meeting"));
meetingHotkeyClear.addEventListener("click", async () => {
  try {
    await setHotkey("meeting", "");
  } catch (err) {
    console.error("clearing the meeting hotkey failed:", err);
  }
  renderHotkeys();
});
```

11. Replace the last line, `loadSettings();`, with:

```ts
// The Meetings tab reads the settings, so it starts once they are loaded.
loadSettings().then(() =>
  initMeetings({
    settings: () => currentSettings,
    saveSettings: async (patch) => {
      Object.assign(currentSettings, patch);
      await invoke("save_settings", { settings: currentSettings });
    },
    showSection: () => showSection("meetings"),
  }),
);
```

In `src/hotkey-capture.ts`, in `ownerName`'s `keys`, after `freeGpu: "free_gpu_label",` add `meeting: "meeting_hotkey_label",` (a key the meeting hotkey has then reads "Already used by Start / stop a meeting").

- [ ] **Step 6: Type check**

Run `npx tsc --noEmit` from the repo root. Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
cd /e/claude/RudariFlow
git add index.html src/meetings.ts src/main.ts src/hotkey-capture.ts src/i18n.ts src/style.css
git commit -F - <<'EOF'
feat: the Meetings tab: live transcript, notes, speakers, playback and the library

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 8: Docs, the final check and the live check

**Files:**
- Modify: `README.md`, `README.de.md`, `CHANGELOG.md`

(The version line at the top of the READMEs changes with the release, not here.)

- [ ] **Step 1: README.md**

- In Features, after the `- **Transcribe files** (Files tab): …` bullet, add:

```markdown
- **Meetings** (Meetings tab): record an online call on this PC (Teams, Zoom, Discord, Google Meet …) with a button, the tray menu or an optional hotkey; nothing records on its own. RudariFlow records two tracks, your microphone ("You") and what the PC plays ("Others", which follows a headset you plug in), and transcribes them live with your Whisper model, language and dictionary; a dictation still goes first. After Stop the others are told apart (Speaker 1, 2, … with the Files tab's speaker model; click a name to rename it), and the local AI model writes the notes: Summary, Decisions and Action items (a checklist). ▶ on a paragraph plays the meeting from there; export as PDF, Word, text or subtitles with the notes on top; search the library by title and transcript. The audio is kept for 30 days, the text until you delete the meeting. Let the others know you are recording: in Switzerland and many other places recording a conversation without their consent is illegal
```

- In the hotkeys bullet, replace `for all four hotkeys and the soundboard's,` with `for all five hotkeys and the soundboard's,`.
- In Architecture, after the `- **Soundboard:** …` bullet, add:

```markdown
- **Meetings:** two cpal capture streams in WASAPI shared mode, the microphone and loopback of Windows' default output, converted to 16 kHz mono and appended to two WAV files every second (silence fills a track the loopback left quiet, so both stay in step). A worker cuts each growing track into 15–30 s pieces that end in a pause and transcribes them with a Whisper state of its own; a gate lets a dictation go before meeting pieces, and meeting pieces before the Files tab's blocks. After Stop, sherpa-onnx separates the Others track and the AI model writes the notes under three fixed headings
```

- [ ] **Step 2: README.de.md**

- After the `- **Dateien transkribieren** (Tab Dateien): …` bullet, add:

```markdown
- **Meetings** (Tab Meetings): ein Online-Gespräch auf diesem PC aufnehmen (Teams, Zoom, Discord, Google Meet …), mit einem Knopf, im Tray-Menü oder mit einem optionalen Tastenkürzel; von selbst nimmt nichts auf. RudariFlow nimmt zwei Spuren auf, dein Mikrofon („Du“) und was der PC abspielt („Andere“, folgt auch einem frisch eingesteckten Headset), und transkribiert sie live mit deinem Whisper-Modell, deiner Sprache und deinem Wörterbuch; ein Diktat geht trotzdem vor. Nach „Beenden“ werden die anderen unterschieden (Sprecher 1, 2, … mit dem Sprechermodell des Tabs Dateien; ein Klick auf den Namen benennt um), und das lokale KI-Modell schreibt die Notizen: Zusammenfassung, Entscheidungen und Aufgaben (eine Checkliste). ▶ bei einem Absatz spielt das Meeting ab dort ab; Export als PDF, Word, Text oder Untertitel mit den Notizen oben; die Liste lässt sich nach Titel und Transkript durchsuchen. Der Ton bleibt 30 Tage, der Text, bis du das Meeting löschst. Sag den anderen, dass du aufnimmst: In der Schweiz und an vielen anderen Orten ist es verboten, ein Gespräch ohne ihr Einverständnis aufzunehmen
```

- Replace `für alle vier Hotkeys und die des Soundboards,` with `für alle fünf Hotkeys und die des Soundboards,`.
- In Architektur, after the `- **Soundboard:** …` bullet, add:

```markdown
- **Meetings:** zwei cpal-Aufnahmestreams über WASAPI im geteilten Modus, das Mikrofon und Loopback des Windows-Standardausgangs, in 16 kHz Mono umgewandelt und jede Sekunde an zwei WAV-Dateien angehängt (Stille füllt eine Spur, bei der das Loopback nichts lieferte, damit beide im Takt bleiben). Ein Worker schneidet jede wachsende Spur in Stücke von 15–30 s, die in einer Pause enden, und transkribiert sie mit einem eigenen Whisper-Zustand; ein Tor lässt ein Diktat vor Meeting-Stücken und Meeting-Stücke vor den Blöcken des Tabs Dateien laufen. Nach „Beenden“ trennt sherpa-onnx die Spur der anderen, und das KI-Modell schreibt die Notizen unter drei festen Überschriften
```

- [ ] **Step 3: CHANGELOG.md**

Under `## [Unreleased]` add:

```markdown
### Added
- **Meetings** (new tab): record an online call on this PC (Teams, Zoom,
  Discord, Google Meet …) with Start meeting, the tray menu or an optional
  hotkey (Recording tab, off by default). Your microphone ("You") and what
  the PC plays ("Others") are transcribed live, with a red bar, a red dot
  in the pill, "Jump to live" and copy. After Stop the others are told
  apart (Speaker 1, 2, …, renamed with a click) and the AI model writes
  the notes: Summary, Decisions and Action items as a checklist; without
  AI cleanup, "Write notes" writes them later. ▶ plays the meeting from a
  paragraph; export as PDF, Word, text or subtitles with the notes on
  top. Every meeting stays in a searchable list; the audio is deleted
  after 30 days, the text stays. A meeting cut off by a crash or a quit
  can be finished later. Dictations keep going first while a meeting
  transcribes.
```

- [ ] **Step 4: Final check (filtered: no clipboard tests)**

```bash
source /e/claude/RudariFlow/.superpowers/tools/env13.sh
cd /e/claude/RudariFlow/src-tauri
for f in meeting:: whisper_gate:: whisper_engine:: file_transcribe:: settings:: recorder:: speakers:: audio:: soundboard::; do CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib "$f" || break; done
for f in hotkey meeting tray summary; do CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --bins "$f" || break; done
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo clippy --no-default-features --lib --bins --tests 2>&1 | grep -A4 -E "^(warning|error)" | grep -E -- "--> src.(meeting|whisper_gate)" || echo "no findings in the new files"
cd .. && npx tsc --noEmit
git diff --ignore-cr-at-eol --stat src-tauri/Cargo.toml
git status --short
```

Expected: every filtered run passes; clippy has no finding in `src/meeting/*` or `whisper_gate.rs`, and none in the lines this plan added to `main.rs`, `recorder.rs`, `settings.rs`, `whisper_engine.rs`, `file_transcribe.rs` (older findings in those files stay); tsc is clean; the Cargo.toml diff is empty (else `git checkout -- src-tauri/Cargo.toml`); `git status` shows only the three docs files.

- [ ] **Step 5: Commit**

```bash
cd /e/claude/RudariFlow
git add README.md README.de.md CHANGELOG.md
git commit -F - <<'EOF'
docs: Meetings in the READMEs and the changelog

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

- [ ] **Step 6: The live check**

Ask the controller to confirm the user is not in a call (the virtual cable is shared with their Discord). Then run "Live checks" below, checks 1–9, and report each result against its "Expected". Fixes go in `fix:` commits; nothing of the live check is committed.

---

## Live checks (test instance)

These checks use the isolated instance (`.superpowers/tools/live-checks.md`). It never touches the user's data or the installed app.

- **Scratch folder `$S`:** your session's scratchpad directory (forward slashes in JS; in the JS files below replace `S/` with it). It holds the scripts and `mt_voices.wav`.
- **Build:** `source /e/claude/RudariFlow/.superpowers/tools/env13.sh && cd /e/claude/RudariFlow && CARGO_TARGET_DIR='C:\r' npm run tauri build -- --no-bundle` (foreground, 600000 ms), then restore `src-tauri/Cargo.toml` if only its line endings changed. Plain `cargo build` is not enough: the exe would load the dev server.
- **Headroom first (PowerShell):** `nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader`. The test instance loads Whisper and the AI model (about 5.5 GB). If less than 6.5 GB of the 16 GB is free, do not start it; tell the controller.
- **Not in a call:** before the first check that plays audio, the controller has confirmed that the user is not in a call. Otherwise stop.
- **Start, always with the override (PowerShell):**

```powershell
$env:RUDARIFLOW_MEETING_LOOPBACK = "CABLE Input (VB-Audio Virtual Cable)"
& "E:\claude\RudariFlow\.superpowers\tools\start_test.ps1"
```

  The script starts `C:\r\release\rudariflow.exe` with `RUDARIFLOW_DATA_DIR=C:\t\rf-test-data`, `RUDARIFLOW_TEST_COMMANDS=1` and CDP on port 9333, and the override is inherited, so the meeting's "PC sound" is the virtual cable's input and ▶ plays there. Keep `autostart: true` in `C:\t\rf-test-data\config.json`. The speaker models are in `C:\t\rf-test-data\speakers\`.
- **Audio safety:** test audio reaches the cable only through `meeting_test_play`, which answers `no_test_device` when the override is missing. If any check gets `no_test_device`, stop: the instance was started without the override, and ▶ would play on the user's speakers.
- **Drive:** `node E:/claude/RudariFlow/.superpowers/tools/cdp.mjs $S/<file>.js` for the main window (page title "RudariFlow"); add a last argument `overlay.html` for the pill. The file is the body of an async function that `return`s a string.
- **Logs:** `C:\t\rf-test-data\startup.log` (`[meeting]`, `[whisper]`, `[speakers]`, `[hotkey]` lines).
- **Stop, right after each check (and before a restart):**

```powershell
Get-Process rudariflow -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "C:\r\*" } | Stop-Process -Force
Get-Process llama-server -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "E:\claude\RudariFlow\src-tauri\binaries\llama\*" } | Stop-Process -Force
```

**Test audio, once (PowerShell; writes a file, plays nothing):** save as `$S\mt_voices.ps1` and run it with `$S` set to the scratchpad. Two voices (Zira and Hazel), about 80 s, with a decision and action items:

```powershell
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile("$S\mt_voices.wav", $format)
$ssml = @"
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
<voice name="Microsoft Zira Desktop">Good morning, everyone. Let's start the release meeting for version ten. First, where are we with the installer?<break time="1500ms"/></voice>
<voice name="Microsoft Hazel Desktop">The installer is ready. The German translation still has three open strings, and the change log needs a last look.<break time="1500ms"/></voice>
<voice name="Microsoft Zira Desktop">Good. Then we decide to ship version ten on Friday, without the beta channel.<break time="1500ms"/></voice>
<voice name="Microsoft Hazel Desktop">Agreed. I will finish the German strings by Wednesday, and I will send the release notes on Thursday.<break time="1500ms"/></voice>
<voice name="Microsoft Zira Desktop">Perfect. Anna, please test the installer on a clean laptop before Thursday. Second topic: the support mailbox. We had forty new tickets this week, mostly about microphones.<break time="1500ms"/></voice>
<voice name="Microsoft Hazel Desktop">Most of them were about USB interfaces that Windows puts to sleep. I will write a short help page about it.<break time="1500ms"/></voice>
<voice name="Microsoft Zira Desktop">Thank you. That's all for today. See you on Friday.</voice>
</speak>
"@
$synth.SpeakSsml($ssml)
$synth.Dispose()
(Get-Item "$S\mt_voices.wav").Length
```

Expected: about 2.5 MB (16 kHz mono 16-bit, about 80 s).

**Setup (after each start), `mt_setup.js`:**

```js
const i = window.__TAURI_INTERNALS__.invoke;
const s = await i("get_settings");
s.microphone = "Microphone (Scarlett Solo USB)";
s.aiCleanup = true;
s.uiLanguage = "en";
await i("save_settings", { settings: s });
const speakers = await i("speaker_model_status");
return JSON.stringify({ mic: s.microphone, ai: s.aiCleanup, model: s.whisperModel, language: s.language, speakers });
```

Expected: `speakers.downloaded` and `speakers.runtime` true. The microphone records room sound only; the user's voice may appear as "You" lines, which is fine.

**Check 1: the tab (`mt_ui.js`)**

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const i = window.__TAURI_INTERNALS__.invoke;
document.querySelector('.nav-item[data-section="meetings"]').click();
await sleep(500);
const sec = document.getElementById("section-meetings");
const out = {
  active: sec.classList.contains("active"),
  placeholder: document.getElementById("mt-title").placeholder,
  startShown: !document.getElementById("mt-start").classList.contains("hidden"),
  barHidden: document.getElementById("mt-bar").classList.contains("hidden"),
  empty: document.getElementById("mt-empty").textContent,
  hotkey: document.getElementById("meeting-hotkey-text").textContent,
};
await i("change_hotkey", { target: "meeting", newHotkey: "Ctrl+Alt+F12" });
await i("change_hotkey", { target: "meeting", newHotkey: "" });
const sel = document.getElementById("ui-language-select");
sel.value = "de";
sel.dispatchEvent(new Event("change"));
await sleep(800);
out.de = {
  start: document.getElementById("mt-start-btn").textContent,
  placeholder: document.getElementById("mt-title").placeholder,
  nav: document.querySelector('.nav-item[data-section="meetings"] span').textContent,
};
sel.value = "en";
sel.dispatchEvent(new Event("change"));
await sleep(800);
return JSON.stringify(out);
```

Expected: `active` true, `placeholder` "Meeting <today, e.g. 3 Oct 2026>, <hh:mm>", `startShown` and `barHidden` true, `empty` "No meetings yet." on a first run, `hotkey` "Not set"; `de.start` "Meeting starten", `de.placeholder` "Meeting 3. Okt. 2026, …"-style. `startup.log` has `[hotkey] registering Ctrl+Alt+F12 for Meeting` (the hotkey's registration; pressing it is not driven).

**Check 2: live lines and the warnings (`mt_live.js`)**

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const i = window.__TAURI_INTERNALS__.invoke;
const id = await i("meeting_start", { title: "Live check" });
await sleep(33000); // nothing plays yet
const quiet = (await i("meeting_state")).status.recording;
const playedAt = Date.now();
await i("meeting_test_play", { path: "S/mt_voices.wav" });
let firstOthersMs = null;
let st;
while (Date.now() - playedAt < 45000) {
  await sleep(1000);
  st = await i("meeting_state");
  if ((st.meeting?.paragraphs ?? []).some((p) => p.track === "others")) {
    firstOthersMs = Date.now() - playedAt;
    break;
  }
}
await sleep(3000);
const rec = (await i("meeting_state")).status.recording;
return JSON.stringify({
  id,
  quietWarnings: quiet.warnings,
  firstOthersMs,
  warningsAfter: rec.warnings,
  paused: rec.paused,
  bar: document.getElementById("mt-bar-time").textContent,
  reminder: document.getElementById("mt-reminder-text").textContent,
  shown: document.getElementById("mt-transcript").children.length,
  first: st.meeting.paragraphs.find((p) => p.track === "others"),
});
```

While it runs (after its first 35 s), run `mt_dot.js` on the pill:

```js
return JSON.stringify({ meeting: document.body.dataset.meeting ?? null, state: document.body.dataset.state, visibility: document.visibilityState });
```

(`node E:/claude/RudariFlow/.superpowers/tools/cdp.mjs $S/mt_dot.js overlay.html`)

Expected: `quietWarnings` `["noPcSound"]`; `firstOthersMs` ≤ 30000; `warningsAfter` `[]`; `paused` false; `bar` "● Recording 1:1x"; `reminder` starts with "Let the others know you're recording." and has the headphones sentence (first meeting); `shown` ≥ 1; `first.text` resembles the first sentence. The pill: `meeting` "1", `state` "ready" (`visibility` is informational). `startup.log` has `[meeting] … started`, `[meeting] Others track: CABLE Input (VB-Audio Virtual Cable)` and `[meeting] You track: Microphone (Scarlett Solo USB)`.

**Check 3: Stop, speakers and notes (`mt_stop.js`, right after check 2)**

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const i = window.__TAURI_INTERNALS__.invoke;
const id = (await i("meeting_state")).status.recording.id;
await sleep(60000); // the rest of the voices and a little silence
await i("meeting_stop");
const steps = [];
const started = Date.now();
let v;
while (Date.now() - started < 300000) {
  await sleep(1000);
  const f = (await i("meeting_state")).status.finishing.find((x) => x.id === id);
  if (f && steps[steps.length - 1] !== f.step) steps.push(f.step);
  v = await i("meeting_get", { id });
  if (v.meeting.state === "finished") break;
}
const m = v.meeting;
const others = m.lines.filter((l) => l.track === "others");
return JSON.stringify({
  id,
  state: m.state,
  secs: Math.round((Date.now() - started) / 1000),
  steps,
  lengthS: Math.round(m.lengthMs / 1000),
  language: m.language,
  speakers: [...new Set(others.map((l) => l.speaker))].sort(),
  speakersError: m.speakersError ?? null,
  notes: m.notes ?? null,
  notesError: m.notesError ?? null,
  you: m.lines.length - others.length,
  others: others.length,
  chips: [...document.querySelectorAll("#mt-speaker-chips .speaker-chip")].map((c) => c.textContent),
  noteHeads: [...document.querySelectorAll("#mt-notes h4")].map((h) => h.textContent),
});
```

Expected: `state` "finished" within 5 minutes; `steps` ends with `"speakers"`, `"notes"`; `lengthS` about 120 (two minutes); `language` "en"; `speakers` `[0, 1]` (Speaker 1 and 2); `speakersError` null; `notes.summary` non-empty, `notes.decisions` mentions Friday (and no beta), `notes.actionItems` mention the German strings, the release notes, Anna's installer test and the help page, all `done: false`; `notesError` null; `chips` `["Speaker 1", "Speaker 2"]`; `noteHeads` `["Summary", "Decisions", "Action items"]`.

**Check 4: the files on disk (`mt_files.ps1`, with the id from check 3)**

```powershell
param([string]$Id)
$d = "C:\t\rf-test-data\meetings\$Id"
Get-ChildItem $d | Select-Object Name, Length | Format-Table -AutoSize
foreach ($f in "you.wav", "others.wav") {
  $bytes = [IO.File]::ReadAllBytes("$d\$f")
  $data = [BitConverter]::ToUInt32($bytes, 40)
  "{0}: header {1} bytes, {2} bytes after the header, {3:N1} s" -f $f, $data, ($bytes.Length - 44), ($data / 32000)
}
Get-Content "$d\meeting.json" -Raw | ConvertFrom-Json | Select-Object id, title, state, lengthMs, language, audioDeleted
```

Expected: `meeting.json`, `you.wav`, `others.wav` and nothing else (no `meeting.json.tmp`); for each WAV the header's bytes equal the bytes after the header; both durations within 1 s of each other and of `lengthMs`; state "finished", `audioDeleted` False.

**Check 5: ▶ plays to the cable (`mt_play.js`, id from check 3, the meeting's view still open)**

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const i = window.__TAURI_INTERNALS__.invoke;
const id = "ID";
const v = await i("meeting_get", { id });
const p = v.paragraphs.find((x) => x.track === "others");
await i("meeting_play", { id, fromMs: p.startMs });
await sleep(300);
const playing = await i("soundboard_capture_test", { device: "CABLE Input (VB-Audio Virtual Cable)", ms: 3000, loopback: true });
const stopShown = [...document.querySelectorAll("#mt-transcript .mt-play")].some((b) => b.textContent === "\u25A0");
await i("meeting_stop_playing");
await sleep(500);
const after = await i("soundboard_capture_test", { device: "CABLE Input (VB-Audio Virtual Cable)", ms: 1000, loopback: true });
return JSON.stringify({ fromMs: p.startMs, rms: playing.rms, peak: playing.peak, stopShown, rmsAfterStop: after.rms });
```

Expected: `rms` > 0.01; `stopShown` true; `rmsAfterStop` < 0.001.

**Check 6: Free GPU during a meeting (`mt_freegpu.js`)**

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const i = window.__TAURI_INTERNALS__.invoke;
const id = await i("meeting_start", { title: "Free GPU check" });
await i("meeting_test_play", { path: "S/mt_voices.wav" });
await sleep(3000);
const freed = await i("free_gpu_test");
await sleep(40000);
const during = await i("meeting_state");
const before = during.meeting.paragraphs.length;
const loaded = await i("free_gpu_test");
await sleep(25000);
const after = await i("meeting_state");
await sleep(20000);
await i("meeting_stop");
let finishing = true;
for (let t = 0; t < 300 && finishing; t++) {
  await sleep(1000);
  finishing = (await i("meeting_state")).status.finishing.some((f) => f.id === id);
}
return JSON.stringify({ id, freed, pausedDuring: during.status.recording.paused, before, loaded, after: after.meeting.paragraphs.length, pausedAfter: after.status.recording.paused, finished: !finishing });
```

Expected: `freed` "Freed"; `pausedDuring` true (and the bar shows "Transcription paused …"); `loaded` "Loaded"; `after` > `before` (it caught up); `pausedAfter` false; `finished` true. `startup.log` has `[meeting] Whisper unloaded: transcription paused`.

**Check 7: an interrupted meeting finishes after a restart**

1. `mt_kill.js`:

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const i = window.__TAURI_INTERNALS__.invoke;
const id = await i("meeting_start", { title: "Interrupted check" });
await i("meeting_test_play", { path: "S/mt_voices.wav" });
await sleep(40000);
return JSON.stringify({ id, paragraphs: (await i("meeting_state")).meeting.paragraphs.length });
```

2. Stop the test instance with the commands above (the process is killed mid-meeting), start it again **with the override**, run `mt_setup.js`, then `mt_files.ps1 <id>`.
3. `mt_finish.js`:

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const i = window.__TAURI_INTERNALS__.invoke;
document.querySelector('.nav-item[data-section="meetings"]').click();
await sleep(800);
const badge = document.querySelector("#mt-list .mt-badge")?.textContent ?? null;
const [m] = await i("meeting_list", { query: "Interrupted check" });
const before = m.state;
await i("meeting_finish", { id: m.id });
const started = Date.now();
let v;
while (Date.now() - started < 300000) {
  await sleep(2000);
  v = await i("meeting_get", { id: m.id });
  if (v.meeting.state === "finished") break;
}
return JSON.stringify({ id: m.id, badge, before, after: v.meeting.state, lengthS: Math.round(v.meeting.lengthMs / 1000), others: v.meeting.lines.filter((l) => l.track === "others").length, notes: !!v.meeting.notes });
```

Expected: after the restart `startup.log` has `[meeting] <id> was cut off: interrupted`; `mt_files.ps1` shows repaired headers (header bytes = bytes after the header, about 40 s); `badge` "Interrupted"; `before` "interrupted"; `after` "finished"; `lengthS` about 40; `others` > 0; `notes` true.

**Check 8: the echo rule (`mt_echo.js`)**

The microphone becomes the cable's recording side, so the "You" track hears exactly what the "Others" track hears (an input device; nothing more plays anywhere).

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const i = window.__TAURI_INTERNALS__.invoke;
const s = await i("get_settings");
const mic = s.microphone;
s.microphone = "CABLE Output (VB-Audio Virtual Cable)";
await i("save_settings", { settings: s });
const id = await i("meeting_start", { title: "Echo check" });
await i("meeting_test_play", { path: "S/mt_voices.wav" });
await sleep(100000);
const v = await i("meeting_get", { id });
await i("meeting_stop");
s.microphone = mic;
await i("save_settings", { settings: s });
const you = v.meeting.lines.filter((l) => l.track === "you").length;
return JSON.stringify({ id, you, others: v.meeting.lines.length - you });
```

Expected: `others` ≥ 8 and `you` ≤ `others` / 5 (the echoes are dropped).

**Check 9: the quit question (`mt_quit.js`)**

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const i = window.__TAURI_INTERNALS__.invoke;
await i("plugin:event|emit", { event: "meeting-quit-asked", payload: null });
await sleep(300);
const shown = !document.getElementById("mt-quit").classList.contains("hidden");
const text = document.getElementById("mt-quit-question").textContent;
document.getElementById("mt-quit-cancel").click();
await sleep(200);
return JSON.stringify({ shown, text, hiddenAfterCancel: document.getElementById("mt-quit").classList.contains("hidden") });
```

Expected: `shown` true, `text` "Stop the meeting and quit?", `hiddenAfterCancel` true. (Stop and quit is `meeting_quit`, which exits; the interrupted state it leaves is the one check 7 finishes.)

Stop the test instance.

- **Not driven:**
  - The tray items and Quit (no tray clicks): the tray's "meeting" item calls `toggle_meeting`, the hotkey's path; its text is unit-tested (`the_tray_item_starts_or_stops_in_the_ui_language`); the quit question is check 9.
  - A press of the meeting hotkey (no SendKeys): its registration is in check 1; the press runs `toggle_meeting`.
  - A change of Windows' default output or an unplugged microphone during a meeting: changing the user's devices is not allowed; both go through the same reopen path as a failed stream, every 3 s, with the warnings of check 2's kind.
  - The 4-hour stop and the 1 GB check: `to_append`'s cap, `on_limit` and the `disk_full` refusal are in the code and unit tests; 4 hours and a full disk are not simulated.
  - The 30-day audio cleanup: unit-tested (`audio_goes_thirty_days_after_the_meeting_ended`).
  - Exports through the native save dialog: the exporters are the Files tab's, called with the meeting's segments, names and notes.
