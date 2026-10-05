# Meeting mode (design)

Date: 2026-10-03. Branch `feature/meeting-mode` from main 4ca4ab4 (0.14.1).

## Decisions (the user's)

- **Use:** online calls on this PC (Teams, Zoom, Discord, Google Meet, …).
- **Live transcript** while the call runs.
- **Start:** by the user only — a button, the tray menu, an optional hotkey. Nothing records on its own.
- **Meeting library:** every meeting is kept with its transcript, speakers and notes; the audio for 30 days.
- **AI notes when it ends:** Summary, Decisions, Action items.
- **Approach A:** two tracks — the microphone ("You") and what the PC plays ("Others") — transcribed live; the others are told apart (Speaker 1, 2, …) after the meeting.

Not in version 1: a follow-up email draft, noticing calls by itself, live labels per individual speaker, search by meaning, calendar integration.

## What the user sees

### The Meetings tab (new, in the sidebar after Files)

- **Start meeting** and a title field (default "Meeting 3 Oct 2026, 14:00", in the UI language's date format). Also in the tray menu ("Start meeting" / "Stop meeting") and as an optional hotkey under Recording (off by default; same capture and conflict rules as the other hotkeys; a press toggles start/stop).
- **While recording:**
  - A red bar: "● Recording 12:34" and **Stop**.
  - The floating pill shows a small red dot while a meeting records (also when the window is hidden).
  - A one-line reminder under the bar, dismissable for good: "Let the others know you're recording." (Recording a conversation without the others' consent is illegal in Switzerland and many other places.)
  - The reminder also says once: "Headphones keep your microphone from picking up the others." (RudariFlow can't tell headphones from speakers.)
  - **Live transcript:** paragraphs, each with its time (from the meeting start) and **You** or **Others**. It follows new text; scrolling up stops the following and shows **Jump to live**. Copy all, or select and copy.
- **After Stop:** "Finishing…" with the step ("Transcribing the last minute", "Telling the speakers apart", "Writing the notes"), then:
  - **Notes** at the top: **Summary**, **Decisions**, **Action items** (a checklist; the ticks are saved), each with a copy button. A section with nothing in it says "None mentioned."
  - **Transcript** below: You, Speaker 1, Speaker 2, … Renaming a speaker (click the name) renames all their lines in this meeting.
  - **▶** on each paragraph plays the meeting from there (both tracks mixed) while the audio is kept.
  - Export: PDF, Word, text, subtitles (.srt/.vtt) — the Files tab's exporters, with the notes on top for PDF/Word/text.
- **Library:** the list of meetings (title, date, length, "Interrupted" or "Finishing" if so), newest first; a search box filters by title and transcript text. Open, rename, export, delete (asks once). Opening a meeting while another one records is allowed.

## How it works

### Recording

- **Microphone:** the Recording setting's microphone, its own shared-mode stream (the dictation recorder and the soundboard keep theirs).
- **PC sound:** WASAPI loopback of Windows' default output device (cpal input stream on the output device, as `soundboard::engine::capture_levels` does). When the default output changes during the meeting (a headset plugged in), the loopback stream moves to the new default.
- Both are converted to 16 kHz mono and appended every second to `<app data>\meetings\<id>\you.wav` and `others.wav` (16-bit; the WAV header is fixed on stop and on recovery). `<id>` = `m-` + 12 hex characters, like the soundboard's ids.
- Audio callbacks only copy into a buffer; a writer thread does the disk writes. Callback threads register as MMCSS "Pro Audio" like the soundboard's.

### Live transcription

- A meeting worker cuts each track into pieces of 15–30 s, ending in a pause (`file_transcribe::block_ends` logic applied to the growing track), and transcribes each piece with the user's Whisper model, language and dictionary prompt; the end of that track's text so far goes into the prompt. Stretches of silence are left out, as in the Files tab.
- **Priority for Whisper:** dictation first, then the meeting, then a file in the Files tab. A dictation never waits for a meeting piece longer than the piece already running.
- **Free GPU / battery unload during a meeting:** recording goes on; transcription pauses and catches up after the models are loaded again (the meeting does not load them by itself while they're freed — the next dictation, the Free GPU hotkey again, or Stop does).
- **Echo:** a "You" line whose words largely repeat an "Others" line from the same moment (overlapping time, ≥ 70 % of its words) is dropped.
- Lines become paragraphs as in the Files tab (a new paragraph on a pause, a track change, or a long paragraph's sentence end).

### After Stop

1. The rest of both tracks is transcribed.
2. **Speakers:** sherpa-onnx separation (the Files tab's models, automatic speaker count) on `others.wav`; the Others lines get Speaker 1, 2, … by overlap (`speakers::assign`). Without the models, "Others" stays and a hint offers the download (as in the Files tab). One speaker found → the lines say "Speaker 1".
3. **Notes:** the AI model gets the transcript ("You" / speaker names, times) and returns the three sections in the meeting's language — a prompt built like `file_transcribe::summary_prompt`, asking for three fixed headings in a parseable form; a long meeting is first condensed in parts (`notes_prompt`, `chunks`) as in the Files tab. AI cleanup off or the AI unavailable → no notes, a hint and a **Write notes** button for later.
4. The meeting is saved as finished.

### Storage

- `<app data>\meetings\<id>\meeting.json`: version, id, title, start time (UTC + local offset), length, Whisper model, language, state (`recording` / `finishing` / `finished` / `interrupted`), lines (start ms, end ms, track `you`/`others`, speaker number or none, text), speaker names, notes (summary text, decisions list, action items with done flags), audio-deleted flag. Written atomically (temp + rename) after every change.
- Audio is deleted 30 days after the meeting ended (checked at app start and once a day); the text stays until the meeting is deleted.
- **Recovery:** at start, a meeting still in `recording`/`finishing` becomes `interrupted`; the library shows it with **Finish**, which runs the end steps on the saved audio (transcribing what the lines don't cover yet).

### Commands and events (Tauri)

`meeting_start(title?)`, `meeting_stop()`, `meeting_state()` (current meeting or none, its lines so far), `meeting_list()`, `meeting_get(id)`, `meeting_rename(id, title)`, `meeting_rename_speaker(id, speaker, name)`, `meeting_set_action_done(id, index, done)`, `meeting_delete(id)`, `meeting_finish(id)` (interrupted), `meeting_write_notes(id)`, `meeting_play(id, from_ms)` / `meeting_stop_playing()`, export through the existing export commands. Events: `meeting-status` (recording/finishing step/finished/warning), `meeting-lines` (new or changed lines), `meetings-changed`.

## Errors and limits

- A track's device fails or disappears: the other track keeps recording; the bar warns ("Microphone lost — retrying" / "PC sound lost — retrying"); it reopens every 3 s.
- No PC sound within the first 30 s: "No sound from the PC yet — is the call playing on this PC?"
- Starting needs ≥ 1 GB free on the app-data drive; an hour is about 230 MB of audio. A meeting stops itself at 4 hours with a notice.
- Starting while a meeting records: refused ("A meeting is already recording"). Quitting while recording: asks "Stop the meeting and quit?"; a crash leaves an interrupted meeting.

## Testing

- **Unit tests:** cutting pieces from a growing track; the echo rule; lines → paragraphs with tracks; speaker assignment on the Others track; `meeting.json` round trip and the atomic write; the 30-day cleanup; recovery of `recording`/`finishing` meetings; the notes parser (headings present, missing, empty sections); priority order of the Whisper gate.
- **Live, on the isolated test instance:** a test-only setting points the loopback at the **virtual cable** ("CABLE Input") instead of the default output, and a two- or three-voice test recording is played into the cable (never to the user's speakers); the mic is the user's Scarlett (room sound only). Checks: live lines for You/Others arrive within 30 s; Stop gives Speaker 1/2(/3), notes in three sections; the files on disk; an interrupted meeting (process killed) finishes after restart; ▶ plays (to the cable endpoint in the test).
