# Changelog

All notable changes to RudariFlow are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- **A new window that is easier to find your way in.** Five sidebar items
  instead of ten: Home, Files, Meetings, Soundboard and Settings. What the
  tabs General, Engine, Recording, Dictionary, Replacements, AI cleanup and
  History held is now on Home and in Settings. The window opens where you
  left it; only a first run (no speech model yet and no dictation so far)
  opens on Home. No setting was removed and every setting keeps its value:
  `config.json` has the same keys as in 0.16.0. What a setting is called in
  the window did change in many places; "Labels renamed" below lists every
  old name with its new one.
- **Home is the dictation page:** your hotkeys (Dictate, Paste last,
  Rewrite last, Free GPU; click a key to change it in place), AI cleanup,
  Spoken language and Write in, what is loaded (speech model, AI model,
  microphone; a click opens its setting), a field that adds a word to the
  dictionary, and your recent dictations with a search for text or app.
  History moved here: Home shows the latest eight, "Show all" opens the
  rest on the page, 50 at a time. The list stays on Home while the setup
  steps show (a headset that is unplugged, a cloud key that was cleared):
  it is under the steps then, with its search and every action. "History
  settings" under it leads to Keep history, and with the history off the
  list says where to turn it on.
- **Settings in five tabs:** Dictation, AI cleanup, Dictionary, Models &
  GPU and General. A tab starts with what most people change, and the rest
  is behind Advanced, which stays open or closed per tab as you left it.
  Hints are one line; "More" opens the rest. Where things went: the speech
  model and Spoken language lead Models & GPU, with Transcription (on this
  PC or Groq Cloud; "Transcription Engine" until now), the GPU backend,
  PC check, Free GPU for games, Unload when idle and Unused models under
  Advanced. The hotkeys, the microphone and the start and stop sounds are
  on Dictation, with the Free GPU and meeting hotkeys, Mute other apps and
  the "send it" command under Advanced. Replacements are on the Dictionary
  tab, with Words on screen, Learn from corrections and Import and export
  under Advanced. The AI model and "Try it" are under AI cleanup ›
  Advanced. Keep history and Delete history are on General. What is also
  on Home shows the same value in both places.
- **One status** in the sidebar and beside Home's heading says what is
  going on: Setup needed (and what is missing), Downloading with percent,
  Recording, Transcribing, Meeting recording, Transcribing a file, Loading
  models, Freed for a game, GPU freed, Ready. It says "Ready" only when a
  dictation would work: with a microphone, and with a speech model that is
  downloaded and loaded or Groq Cloud and its key. A ring beside it
  marks a meeting that records or a file that runs while another state
  shows. A screen reader hears the changes, not every percent.
- **A model's download shows on its own row** in Settings (the speech
  model on Models & GPU, the AI model under AI cleanup › Advanced): a bar
  with percent and size. One that does not finish says so on that row,
  with the reason (a full disk, for example) and Retry; the advice to
  check the internet connection shows only where no reason is known. A
  speech model becomes your saved choice only once it is on disk.
- **The speech models can be read about without choosing one.** "More" on
  the Speech model row lists all eight with size and a line about each
  (Base and Medium had none), and marks the one recommended for this PC's
  graphics card, as the dropdown does. Before, a model's line showed only
  once it was chosen, and choosing a model that is missing starts its
  download. On a new PC the row also says which model is recommended and
  for which graphics card; the dropdown stays on what the settings say.
- **One way to delete everywhere:** "Delete", then "Delete?". Esc, a click
  elsewhere or scrolling the button out of view takes the question back,
  and a double click or a held Enter deletes nothing. Nothing is deleted on
  a single click any more (a history entry, a dictionary word, a
  replacement, a rule, a soundboard category and Clear in Files, now
  "Remove transcript", used to be). A delete that fails says so on its
  button.
- **One layout for every page, and large windows are used.** Every page
  runs from one left edge to the window's right edge, at every size: no
  page is a narrow column in a wide, empty window any more, and the right
  edge no longer jumps from page to page. Inside that width a page has
  columns. One in a small window. From a window about 1100 px wide Home
  has two (controls, dictations) and the Soundboard shows its settings
  beside the sounds. From about 1450 px a Settings tab is two columns
  (General's two cards side by side), the meetings are two columns of rows
  (the newer half at the left), an open meeting has its notes at the left
  and its transcript at the right (without notes, what is said about the
  meeting stands in the notes' place; a meeting that records has nothing
  to put there yet, so its transcript has the whole width, under one line
  that says when the notes come), and Files with a file has its options,
  the file and its summary at the left and the transcript at the right. From about 1800 px Home's controls stand in
  two columns as well, and the setup steps stand beside the optional card
  and the recent dictations. One gutter between two columns everywhere.
  Running text (a transcript, notes, a summary) keeps a readable line
  length however wide its frame is.
- **The smallest window (900×600):** Home's four keys stand two by two,
  so the recent dictations start on the first screen.
- **Files:** the options (Language, Speakers) come first and the drop
  zone under them: what to set stands before where to drop. Without a file
  the zone takes the height the window leaves. Once a file is loaded the
  drop zone shrinks to one line and so do the options (their hints are
  behind "More"), so the transcript starts higher up. "Summarise with AI"
  and the summary stand under the file's line, before the transcript;
  where the summary stands over the transcript (a window under about
  1450 px) it shows its first five lines, two in a window lower than
  700 px, and "More" opens the rest, so the transcript's first lines stay
  on the first screen. "Copy" copies the whole summary either way.
- **Recent dictations are quieter.** "Copy" always shows, as the last
  action of every row, at the card's right edge where the search field
  ends; the other actions (Delete, Original, Play, Re-run) stand to its
  left and show while the pointer is on the row or the focus is in it (the
  keyboard's or a click's: after a click on Re-run the row keeps showing
  it). They keep their places while they are not seen, and no row changes
  its height. An armed "Delete?", "Stop" while a recording plays and a
  failure stay in view; on a touch screen and in a contrast theme all of
  them always show. A row's second line is the app, the time and the
  length ("01:55 · 6 s") on one line; the model's internal name is gone
  from it. In a narrow list (a window from about 1100 to 1440 px) "Copy"
  stands at the end of that line, and the other actions take the line
  while they show.
- **One name for a model.** A model reads "Large v3 Turbo q8" everywhere:
  in a meeting's line (it was "Whisper large-v3-turbo-q8_0") and under
  Unused models, where the file's name ("ggml-medium.bin") is now the
  second line.
- **Labels renamed** since 0.16.0 (English, then German; search for the
  old word and you find the new one here). No key in `config.json` changed
  with them.
  - The sidebar's General, Engine, Recording, Dictionary, Replacements,
    AI cleanup and History → Home and the five tabs of Settings ·
    Allgemein, Engine, Aufnahme, Wörterbuch, Ersetzungen, KI-Korrektur und
    Verlauf → Start und die fünf Tabs der Einstellungen. The page
    "Transcribe a file" → Files · Datei transkribieren → Dateien
  - Language, on the Engine tab → Spoken language, on Home and under
    Models & GPU · Sprache → Gesprochene Sprache
  - Transcription Engine: Local Whisper / Groq Cloud → Transcription: On
    this PC / Groq Cloud · Transkriptions-Engine: Lokales Whisper / Groq
    Cloud → Transkription: Auf diesem PC / Groq Cloud
  - Model Size → Speech model · Modellgröße → Sprachmodell
  - Model, under AI cleanup → AI model · Modell → KI-Modell
  - Recording Mode (Toggle / Push to Talk) and Hotkey → one row, Dictate
    (Hold / Toggle, and the key beside them) · Aufnahmemodus (Umschalten /
    Push-to-Talk) und Tastenkürzel → eine Zeile, Diktieren (Halten /
    Umschalten, daneben die Taste)
  - Notification Volume → Start and stop sounds ·
    Benachrichtigungslautstärke → Start- und Stopptöne
  - Start with computer → Start with Windows · Mit Computer starten → Mit
    Windows starten
  - Paste last transcript → Paste last dictation (German as before:
    Letztes Diktat einfügen)
  - Clear history → Delete history (German as before: Verlauf löschen)
  - Clear, in Files → Remove transcript · Leeren → Transkript entfernen
  - Hotkey to turn sound hotkeys on/off → On/off key for sound hotkeys ·
    Tastenkürzel, das Sound-Tastenkürzel ein- und ausschaltet →
    Ein/Aus-Taste für Sound-Tastenkürzel
  - A Soundboard device: Automatic (name) → Auto: name · Automatisch
    (Name) → Auto: Name
  - A microphone: System default (name) → System default: name ·
    Systemstandard (Name) → Systemstandard: Name
  - Whisper model, under Unused models → Speech model · Whisper-Modell →
    Sprachmodell
  - "Whisper" in a sentence of the window → "the speech model", or "the
    app" where the dictionary is meant: "Loading Whisper…" → "Loading the
    speech model…", "with your Whisper model" → "with your speech model",
    "Words Whisper should know" → "Words the app should know" · „Whisper
    wird geladen…“ → „Sprachmodell wird geladen…“, „mit deinem
    Whisper-Modell“ → „mit deinem Sprachmodell“, „Wörter, die Whisper
    kennen soll“ → „Wörter, die die App kennen soll“. The READMEs and the
    PC check's report still name Whisper where the technology is meant.
  - "Engine tab", "AI cleanup tab", "Meetings tab" in a sentence → the
    place in the new window ("Settings › Models & GPU", "Settings › AI
    cleanup › Advanced", "Meetings") · „Tab Engine“, „Tab KI-Korrektur“,
    „Tab Meetings“ → „Einstellungen › Modelle & GPU“, „Einstellungen ›
    KI-Korrektur › Erweitert“, „Meetings“
  - AI cleanup's first sentence: "A language model" → "An AI model" · „Ein
    Sprachmodell“ → „Ein KI-Modell“ (speech model, Sprachmodell, is the
    model that transcribes, everywhere)
  - GPU Backend → GPU backend (English only)
  - German only: Eigenes Fenster → In eigenem Fenster öffnen; Stopp →
    Stoppen; Erneut versuchen → Wiederholen; „Kein Sound passt.“ and „Kein
    Meeting passt.“ → „Kein Sound gefunden.“, „Kein Meeting gefunden.“;
    Hotkey → Diktiertaste (in sentences); Strg → Ctrl and Umschalt →
    Shift, as the key boxes show them; Bearbeiten → Bearbeiten per Stimme
    where the feature is meant (the pill's notice); „Auto:“ →
    „Automatisch:“ in the GPU backend's hint
  - The pill, when a meeting cannot start: "Download a Whisper model
    first" → "Download a speech model first" · „Zuerst ein Whisper-Modell
    herunterladen“ → „Zuerst ein Sprachmodell herunterladen“
- **The pill is set in the window's font** (IBM Plex Sans; only its Latin
  part is loaded there) and takes the window's colours. While it shows
  text, the microphone, the bars and the x no longer show faintly behind
  the words, and it keeps its outline: the ground of a text or a notice is
  the pill's own shape and size (it was a larger box, 320 by 64 px around
  a pill of 304 by 48).
- **Smaller ones:** one thin scrollbar for every list and text box (a
  file's transcript had Windows' own); the tab labels no longer move when
  another tab is opened; one mark for "opens below" (Export and the
  Soundboard's Devices have the arrow of a select and of Advanced); a
  summary, a meeting's notes and the dictionary's suggestions are cards
  without an outline (it read as the keyboard focus); "More" never stands
  alone on a line; the list of all speech models behind "More" takes the
  row's width; a rule's Delete stands at the card's right edge like every
  Delete; after an import in which some sounds failed only those are red;
  a sound with a combination of three keys keeps its volume on the same
  line.
- **Soundboard:** the sounds come first, as tiles. A bar above them holds
  the Virtual microphone switch, Stop all, Pop out and "Soundboard
  settings", which opens a panel with the volumes, Play sounds over each
  other, the Sound hotkeys switch and its key, the Stop all key and the
  devices: beside the sounds in a wide window, closed at first in a
  narrow one and in the pop-out, and remembered as you left it.
- **Calmer look:** bigger type, more room, softer surfaces. Hint text is
  readable (4.5:1), every control shows the keyboard focus, has a name for
  screen readers and is at least 24 px, and the sidebar is reached by Tab.
  A page's title is its first heading, the Soundboard's switches are
  switches to a screen reader, and the end of a file's transcription is
  read out.
- **Windows contrast themes:** with a contrast theme on, every control has
  an edge and every "on" or "selected" shows in the theme's highlight
  colours: a switch, the open tab, the current page, a chosen chip, a
  sound that loops or plays, an armed Delete, a progress bar. Before, a
  switch could only be seen while it had the focus.
- **A faster, calmer start:** the window asks the app for everything at
  once instead of one thing after the other, is in your Display Language
  from its first moment, and Home shows its heading alone until it knows
  what to show (a new PC no longer sees the daily view for a moment before
  the steps). The status says "Ready" only once the AI's state is known
  too, and never while Home still says "Getting ready…". Should one of
  those questions never be answered, the window goes on after five seconds
  with what it has, and a notice says "Could not reach the app's backend.
  Restart RudariFlow."; an answer that comes later still counts.
- **Less motion:** only a page change and an opening fold move (150 ms);
  hover and focus change at once, and nothing is animated when Windows is
  set to reduce motion.
- **The pill and the tray menu follow the Display Language**, without a
  restart. The pill used to follow Windows' language, and the tray's "Show
  RudariFlow" and "Quit" were English only.

### Added
- **Setup steps** on Home, while a microphone or a speech model is
  missing: the microphone with a live level, the speech model recommended
  for your graphics card with a download that shows percent and size (the
  status says "Downloading n %" meanwhile), and your dictation key; AI
  cleanup is offered on an optional card ("Hide" puts it away, and the
  card says where the model can be downloaded later). A PC that has never
  dictated is welcomed; someone who has dictated before sees the plain
  "Setup needed" with the reason. The level runs only while you
  use the window (within a minute of your last touch) and never in a
  window that was not shown, such as a start in the tray at login.
- **A dictation without a speech model says so in the pill** ("No speech
  model yet. Open RudariFlow to download one.") and records nothing;
  Rewrite last checks for a model before it selects anything.
- Search for dictionary words and for replacements.
- With Groq Cloud chosen and no API key, Models & GPU says that nothing
  is transcribed, and "Enter the key" leads to the field.
- **A save that fails says so.** A notice gives the reason ("Could not
  save: …"), and the control goes back to the saved value. The notice lies
  over the bottom of the page: it pushes nothing down, covers neither the
  tabs nor a page's head, and can be dismissed; a page leaves its height
  free at its end meanwhile, so its last row can be scrolled clear of it.
  Before, the control kept showing the new value and nothing was said.
- For development: `tools/ui-check`, which opens 113 pages of the
  frontend in headless Chromium with a mocked backend and fails on layout,
  accessibility and wording defects, and `npm run test:unit` (76 tests of
  the pure modules, run by Node's own test runner). See the README.

### Fixed
- **A click on a setting in the first moments after the start could wipe
  settings** (in 0.16.0 too): the save read controls that were not filled
  yet and stored the microphone as empty, the speech model as Small, no
  replacement and no rule. Nothing is saved before the settings are read
  now, the pages rest until then, and every control is filled in one go.
- The Display Language is saved first when it is changed, so a hiccup
  while the window is drawn again cannot lose it, and no line keeps the
  old language (an export's result, "Added …" on Home, the time under
  "Try it", the Soundboard's notice, a running PC check).
- A name or a reason with "$&" in it was shown as the placeholder it stood
  in for (an app in a rule, a device's name, the backend's reason).
- After the window was loaded again while the AI model downloaded, Settings
  said "Downloading" and the sidebar did not.
- Keyboard focus was lost in the recent dictations when the window crossed
  the width where the list changes its place.
- The sidebar said "Ready" without a speech model, with the models
  unloaded and while a meeting recorded.
- The tenth sidebar item and the version were below the window at its
  smallest size (900×600).
- The font is shipped with the app; nothing is requested from Google Fonts
  at the start any more.
- Switching Transcription from Groq Cloud to On this PC loads the speech
  model at once instead of at the next dictation.
- The pill in Edit mode: the cancel button was pushed out of the pill and
  its window beside "12 words", and a bar at the left end could be cut to
  a sliver. The pill's text was cut at both ends when it was too long; it
  is one line that shows the end of what was said now: a short text stands
  in the middle, a longer one loses its beginning, not its end.
- German: text ran under the Soundboard's key box for sound hotkeys
  on/off, the second line of a history entry lost the app name, and the
  language select of a rule per app was cut.
- Home's quick switches: in German "Gesprochene Sprache" stood over its
  select while "Schreiben in" stood beside its own (in windows from 1800
  px and from 1100 to 1239 px). Both selects stand beside their names at
  every width now.
- The Soundboard's pop-out: three hints that end in "More" broke before
  their last word although the line was free.

## [0.16.0] - 2026-10-05 - Free GPU for games

Tested on an NVIDIA GeForce RTX 5080 with a Ryzen 9 7900X.

### Added
- **Free GPU for games** (Engine tab, off by default): when an app covers a
  whole monitor (fullscreen or borderless) in the foreground for 5 seconds,
  Whisper and the AI model are unloaded as with the Free GPU hotkey. Video
  players count as games; browsers (a fullscreen video), calls (Teams, Zoom,
  Discord), remote desktops (Remote Desktop, RustDesk, Parsec, AnyDesk,
  TeamViewer), the desktop and RudariFlow's own windows do not. The game
  then counts as running while its window stays open and fullscreen, also
  while another window is in front (Discord on another monitor); 30 seconds
  after it is closed, minimised or no longer fullscreen, the models load
  again. Meanwhile a dictation loads only Whisper (about 1 GB), is pasted
  without AI cleanup and unloads Whisper again; Edit mode is off (with text
  selected nothing is pasted, and the pill says so), and Rewrite last
  refuses with a notice. A meeting keeps recording; its text catches up once
  the models are back, and Stop during a game transcribes the rest with
  Whisper alone and leaves the notes for Write notes. Loading with the Free
  GPU hotkey during a game keeps the models loaded until that game is over.
  The Engine and AI tabs say when the GPU is freed for a game.
- **Large v3 Turbo q5** in the Whisper model list (~574 MB): about 0.3 GB
  less graphics memory than Large v3 Turbo q8 at the same speed.
- **Unload when idle** (Engine tab): on mains power, Whisper and the AI
  model can be unloaded after 15 minutes, 30 minutes or 1 hour without a
  dictation (Never by default); on battery it stays 10 minutes. Requests to
  the AI from another program (the Twitch caption service), a running file
  transcription or a meeting keep the models loaded. The AI tab now says
  "Unloaded" instead of "Starting…" after such an unload.
- **Unused models** (Engine tab): downloaded Whisper models, AI models and
  drafters that no setting uses, and unfinished downloads, with their size
  and a Delete button that asks once more; a file with other hard links
  says that deleting it frees no disk space. Nothing is deleted on its own.

## [0.15.0] - 2026-10-04 - Meetings

Tested on an NVIDIA GeForce RTX 5080 with a Ryzen 9 7900X.

### Added
- **Meetings** (new tab): record an online call on this PC (Teams, Zoom,
  Discord, Google Meet …) with Start meeting, the tray menu or an optional
  hotkey (Recording tab, off by default). Your microphone ("You") and what
  the PC plays on Windows' default output ("Others") are transcribed live,
  about half a minute behind on a GPU (longer on the CPU), with a red bar,
  a red dot in the pill, "Jump to live" and copy. After Stop the others are told apart
  (Speaker 1, 2, …, renamed with a click) and the AI model writes the
  notes: Summary, Decisions and Action items as a checklist; without AI
  cleanup, "Write notes" writes them later. ▶ plays the meeting from a
  paragraph (not while a meeting records); export as PDF, Word, text or
  subtitles with the notes on top. Every meeting stays in a searchable
  list; the audio is deleted after 30 days, the text stays. A meeting cut
  off by a crash or a quit can be finished later (Finish); quitting during
  a meeting asks first. Dictations keep going first while a meeting
  transcribes, and "Mute other apps while recording" does not mute during
  a meeting (it would record the silence); after a Free GPU press the
  recording goes on and the text catches up when the models are loaded
  again. Stop loads the models again when they were freed before it, for
  the rest of the transcript and the notes. The PC check does not run
  during a meeting.

### Fixed
- RudariFlow no longer runs twice: starting it again brings the running window
  to the front.
- RudariFlow's hidden window no longer takes the keyboard focus when the app
  starts in the tray (at Windows login): typing went into it for a moment.

## [0.14.1] - 2026-10-02 - Sound hotkeys on/off, loops, two columns

Tested on an NVIDIA GeForce RTX 5080 with a Ryzen 9 7900X.

### Added
- **Sound hotkeys on/off** (Soundboard): a "Sound hotkeys" switch and a
  hotkey to flip it, so a sound is not played by accident. Off, the
  sounds keep their hotkeys but pressing them does nothing, and the keys
  work normally in other apps again; the Stop all hotkey, the toggle
  hotkey and clicking a sound keep working. The hotkey shows "Sound
  hotkeys off" / "Sound hotkeys on" in the pill; the sounds' hotkeys look
  dimmed while off.
- **Loop a sound** (Soundboard): a loop button on each sound makes it
  repeat without a gap until it is stopped (its hotkey or button again,
  Stop all, or a new sound replacing it); its progress bar starts over
  with every round. Switched off while the sound plays, the round that
  plays is the last.
- **Two columns** (Soundboard tab): on a wide window the settings sit on
  the left and the sounds (add, search, categories, the list) on the
  right; narrow windows and the pop-out keep one column.

### Fixed
- **Echo and a beep on your voice after a sound** (virtual microphone):
  when the microphone or the cable stalled for a moment, the voice's
  buffer drained the backlog by dropping a frame in every hundred: up to
  about 16 s of 100–180 ms delay and a 480 Hz pattern on the voice.
  The backlog is now skipped at once with a short crossfade, and clock
  drift is followed by a slight, inaudible speed change; the voice's
  extra delay is about 15 ms.
- The soundboard's audio threads run as Windows "Pro Audio" threads;
  the audio library's own priority boost silently failed, so they ran at
  normal priority and could be held up by a busy PC.

## [0.14.0] - 2026-10-02 - Soundboard, Free GPU hotkey and a Clear button

Tested on an NVIDIA GeForce RTX 5080 with a Ryzen 9 7900X.

### Added
- **Soundboard** (new tab, can pop out into its own window): sounds on
  hotkeys for Discord and games, like Soundpad. Turn on "Virtual
  microphone" and RudariFlow sends your microphone plus the sounds to the
  free VB-Audio Virtual Cable, which your voice app uses as its microphone
  ("CABLE Output"); you hear the sounds on your headphones at your own
  volume, never your own voice. Add AAC, FLAC, M4A, MP3, OGG, OPUS, WAV or
  WMA files (up to 30 minutes each; copies are kept in RudariFlow's data
  folder), sort them into categories, search, and give each a hotkey: a
  key (the numpad and F-keys also alone), a combination or a mouse side
  button. A new sound replaces the playing one, or plays over it; the same
  hotkey stops it, and a Stop all hotkey stops everything. Sound hotkeys
  are taken from other apps only while the virtual microphone is on. The
  pop-out window can stay on top and remembers its size and position.
- **Free GPU hotkey:** a fourth hotkey (Settings → Recording, off by
  default, a key combination or a mouse side button) unloads Whisper and
  stops the AI model, so a game gets the graphics card's memory: about
  5.6 GB with Large v3 Turbo q8 and Gemma 4 E4B on an RTX 5080. The pill
  says "GPU freed". Press it again to load both ("Loading models…", then
  "Models loaded"). A dictation, a file or a summary also loads what it
  needs; the first dictation after a free waits for the AI model (a few
  seconds) instead of being pasted without AI cleanup. A press during a
  dictation frees the GPU once the text is pasted.
- **Clear in the Files tab:** empties the tab for the next file: the
  transcript, the speaker names, the summary and the file line go, and
  the audio file stays where it is. Not while a file, a summary or an
  export is running.
- **The AI model for other programs:** while the AI is ready, RudariFlow
  writes `llm-endpoint.json` to its data folder (address, key and a third
  llama-server slot of their own), so the Twitch Live Translate caption
  service translates with the model that is already loaded instead of
  loading a second one. The dictation slot and its prompt cache are not
  shared. Costs about 100 MB of video memory. Free GPU, turning the AI off
  or quitting takes the file away.

### Fixed
- Ogg Vorbis files now open in the Files tab on PCs whose Media Foundation
  cannot read them (RudariFlow decodes them itself).

## [0.12.0] - 2026-09-25 - Speakers, exports and a resizable window

Tested on an NVIDIA GeForce RTX 5080 with a Ryzen 9 7900X.

### Fixed
- **0.11.0 could crash on processors without AVX-512.** whisper.cpp was
  compiled for the build PC's CPU (a Ryzen 9 7900X), so the 0.11.0
  installers carried AVX-512 code. 0.12.0 targets AVX2: Intel Haswell
  (2013), AMD Ryzen and newer.

### Added
- **Speakers in file transcripts:** choose Auto or 2 to 8 speakers next to
  the language, and each change of speaker starts a paragraph with the
  name. Rename a speaker once and the transcript and its exports use the
  name; rename before summarising and the summary uses the names too. The
  speaker model (45 MB) downloads on first use and runs on the CPU: about
  21 s for a 10-minute meeting on a Ryzen 9 7900X (8 threads).
- **Export** file transcripts as PDF, Word (.docx) or text, with or
  without timestamps and the summary on top when one is shown, or as
  subtitles (.srt, .vtt), always timed.
- **A resizable window:** the main window can be resized and maximised,
  and remembers its size and position. Long transcripts use the height,
  and the summary can be hidden to give the transcript more room.

### Changed
- **The Export menu replaces "Save as text…":** PDF, Word, subtitles and
  text all come from one menu, and carry the timestamps switch, the
  speaker names and the summary shown on screen.
- **The transcript box is read-only** once a file is done, so exports and
  Copy always use the transcript as shown; to correct words, edit the
  exported file.

## [0.11.0] - 2026-09-24 - AI on CUDA, sturdier dictation and files

Tested on an NVIDIA GeForce RTX 5080 with an AMD Radeon iGPU next to it.

### Changed
- **AI cleanup runs on CUDA on NVIDIA:** the llama.cpp server carries its
  CUDA backend next to the Vulkan one and takes it for the card Whisper
  uses. On an RTX 5080 long dictations are cleaned in 174 to 186 ms
  instead of 238 to 279 ms, and the slowest of 36 test requests took 217
  to 231 ms instead of 279 to 324 ms; short ones are about as fast as
  before (85 to 93 ms). AMD, Intel and older NVIDIA cards keep Vulkan, and
  so does a PC where CUDA does not load.
- **CUDA 13.4 for Whisper and the AI:** both use one CUDA runtime, which
  is smaller than the CUDA 12 one (523 MB instead of 752 MB), so the CUDA
  backend of the AI adds 49 MB to the installer. CUDA now needs NVIDIA
  driver 580 or newer (2025); with an older driver Whisper and the AI run
  on Vulkan. Builds need the CUDA Toolkit 13.x.

### Fixed
- **Whisper compiled without optimisation:** with the Visual Studio
  generator the cmake crate replaced the Release flags of CMake, so builds
  where that reached the projects (this PC, CMake 4.4) ran Whisper with
  unoptimised C/C++ code: 438 to 454 ms instead of 292 to 320 ms for 42 s
  of speech on an RTX 5080 (CUDA), 501 to 699 ms instead of 277 to 297 ms
  on Vulkan. A new whisper-rs-sys patch sets the flags.
- **The AI on the integrated GPU:** the Radeon of a Ryzen 7900X reports
  more memory than the RTX 5080 next to it, so with Whisper on the CPU (or
  the card missing from an early device list) the AI ran on the Radeon.
  An integrated GPU is now used only when there is no other.
- **Mouse side buttons bounce:** a worn button reported release and press
  again 3 to 22 ms apart, which stopped a toggle recording right after it
  started, or cut a push-to-talk dictation in two ("…sicher, dass" +
  "Und wir…"). A release followed within 40 ms by a press of the same
  hotkey is now ignored.
- **Files: timestamps after pauses** were up to 45 s early (speech at 1:15
  showed as 0:30), and Whisper invented "Thank you." in silences. Pauses
  of 2 s and more are now left out of what Whisper hears.
- **Files: names from the dictionary** were spelled right in the first
  minute only ("Prodiga", "Aji" later on); every part now gets the
  dictionary and the text before it.
- **Files: capitals in the middle of sentences** where Whisper split a
  sentence into two segments ("we could Go to the park").
- **Files: Ogg Vorbis** (`.ogg`, `.oga`) was refused; it now goes to
  Windows' decoder when it is not Opus.
- **Files: summaries of Chinese, Japanese and Korean** transcripts failed
  on long texts (parts too big for the model); the parts are smaller.
- **Files: a summary of an earlier file** could show up for the next one,
  and saving during a summary wrote "Summarising…" into the file.
- **Dictating while a summary runs:** the AI server had one slot, so a
  dictation waited behind a summary part and was pasted without AI
  cleanup (4.6 s timeout on the RTX 5080). It now has a second slot for
  summaries (about 100 MB of video memory): 121 to 174 ms per dictation
  during a summary.
- **PC check** also timed the integrated GPU, which no setting can pick:
  4.7 minutes instead of 19 s next to an RTX 5080.
- **The microphone stayed open after the release** while a piece of a
  long dictation was still being transcribed.
- **Long dictations with auto-detect** detected the language again for
  every piece and the rest; the first piece's language now holds, and
  the rest follows the app rule from the press, like the pieces.
- **Rewrite last:** a quick tap in push-to-talk left the last dictation
  selected, so the next keystroke replaced it.
- **Words on screen** went to Groq with the cloud engine; they stay on
  the PC as described.
- **Learning dictionary:** capitals for emphasis ("SOFORT") were
  suggested as names, and accent fixes ("Umit" to "Ümit") were not.
- **AI speed estimate:** the one-token cache refresh counted as a
  measurement of 0.001 ms per token and lowered the time limits.
- **The MTP drafter was switched off for good** when the AI was stopped
  while loading (AI cleanup turned off, model changed); now only a crash
  counts.

### Added
- **A space between two dictations in a row:** when the previous
  dictation stands right before the cursor, the next one starts with a
  space. Only then, since empty fields of web apps can report their
  placeholder as text.

## [0.10.0] - 2026-09-24 - Files, rewrite last, a dictionary that learns

### Added
- **Language per app:** an app rule can set the language Whisper listens
  for, e.g. German in WhatsApp and English in VS Code, with auto-detect
  everywhere else.
- **Snippets with variables:** replacements can hold `{date}`, `{time}`,
  `{weekday}`, `{year}` and `{iso_date}`, filled in when you dictate
  the trigger.
- **Rewrite the last dictation:** a hotkey selects your last dictation in
  the field, and what you say next edits it like Edit mode (needs AI
  cleanup).
- **PC check** (Engine tab): measures Whisper on every GPU with flash
  attention on and off, keeps the fastest setup and gives a report to
  copy.
- **Long dictations are transcribed in pieces while you speak:** every
  29 s a piece is cut in a pause, so after the release only the rest is
  left (40 to 70 s dictations: 295 to 364 ms instead of 629 to 796 ms).
- **The dictionary learns from your corrections:** correct a name right
  after dictating ("Glyfert" to "Gleifert") and it is suggested in the
  Dictionary tab to add or dismiss. The field is read once more at the
  next hotkey press or after 20 s, in the same app only; only the
  corrected word is kept, never your text. Can be switched off.
- **Transcribe files** (new Files tab): drop an audio or video file on the
  window (MP3, M4A, WAV, FLAC, WhatsApp voice messages, MP4, MOV, MKV,
  WebM) and the text appears minute by minute, with optional timestamps,
  copy and save as text. 4 minutes of MP3 took 6.6 s on an RX 6800. The AI
  model can summarise the transcript: key points and next steps, long
  recordings in parts. Dictating while a file runs works; the dictation
  waits for the current minute at most.
- **Mouse side buttons for every hotkey:** paste last and rewrite last
  take Mouse 4 / Mouse 5 too, alone or with Ctrl, Shift, Alt or Win, so
  one button can serve two hotkeys (Mouse 5 dictates, Shift+Mouse 5
  rewrites).
- Ctrl+A, C, V, X, Z, Y and S can no longer be set as a hotkey: taken by
  RudariFlow they stopped working in every app (Ctrl+V would also catch
  RudariFlow's own paste). A chord like that saved earlier is not
  registered.

## [0.9.0] - 2026-09-24 - Faster AI, Large v3 Turbo q8

### Improved
Measured on an AMD Radeon RX 6800.
- **AI cleanup about 30 % faster** with Gemma 4's MTP drafter, a small
  companion model (about 100 MB, 465 MB for 12B) that guesses the next
  words for the AI to check in one pass: dictation 343 -> 240 ms median,
  edits up to 150 ms faster. It downloads with the AI model; existing
  installs fetch it once in the background. If the AI server ever fails
  with it, RudariFlow restarts it without the drafter and keeps it off
  until the next update.
- **The first dictation after start or a model switch is as fast as the
  rest:** Whisper does one short run right after loading, so the graphics
  card sets itself up then (first dictation 535 ms -> 297 ms live; up to
  1.8 s before when the driver had nothing cached yet).
- **Large v3 Turbo q8** (Engine tab): the same text as Large v3 Turbo in
  49 of 49 test recordings, 18 % faster (274 vs 336 ms) and half the
  memory (870 MB).
- **Hints for your hardware** next to the detected GPUs: without a
  dedicated GPU, Whisper Small and Gemma 4 E2B with the Light style; with
  8 GB of video memory or less, Large v3 Turbo q8 and Gemma 4 E2B.
- **AI time limits follow the measured speed**, so a slower GPU or the
  CPU gets its AI cleanup instead of the plain text: simulated slow GPU,
  6 of 6 dictations cleaned (before: 6 of 6 fell back after 2.5 s).
- No 450 ms wait when you dictate into a Chromium page whose focus is not
  a text field (the Edit mode check waited for Chromium's accessibility).
- The pill names a missing microphone ("Microphone not found: Fast
  Track"), e.g. a USB interface that is switched off.

### Fixed
- An interrupted model download continues where it stopped instead of
  starting over (checked: resumed at 5.2 of 77.7 MB, same SHA-256).
- Whisper and the paste keystrokes no longer hold an async worker thread.
- startup.log moves to startup.prev.log at start when it is over 2 MB.

## [0.8.0] - 2026-09-24 - Words on screen, faster dictation

### Added
- **Words on screen** (Dictionary tab, on by default), like Aqua Voice's
  Deep Context. When you press the hotkey, RudariFlow reads the visible
  text of the window you dictate into through Windows UI Automation (about
  20 ms for a web page, 200 ms for VS Code, while you speak) and picks out
  names, brands and technical terms: "Yılmaz", "Paperless-ngx", "GitLab",
  "Salon-Agenda". Up to 20 name-like terms go into Whisper's prompt ahead
  of the dictionary. Of up to 40 terms, those that resemble something
  Whisper heard go into the AI cleanup and Edit mode request, with the
  instruction to use their spelling but never add them. Measured:
  "Umit Yilmaz" becomes "Ümit Yılmaz", "Paperless NGX" becomes
  "Paperless-ngx", an unrelated sentence stays unchanged. Only the word
  list is used, nothing is stored; the log records counts only. Ordinary
  words, words at the start of a line, links, emails, code fragments,
  measurements ("13h", "0.32s") and dictionary entries are left out.

### Improved
Measured on an AMD Radeon RX 6800 with large-v3-turbo and Gemma 4 E4B.
- **First dictation after start as fast as the rest.** The AI server warms
  its prompt cache with the dictation prompt of your settings (dictionary,
  instructions, Write in), and again when they change, instead of a
  generic prompt: AI time of the first dictation 958 ms -> 477 ms.
- **Auto-detect costs no extra time.** The language detection's encoder
  pass is reused instead of running the encoder twice (whisper.cpp patch
  in patches/, applied by scripts/setup-whisper-patch.ps1): Whisper with
  Auto-detect 631 ms -> 330 ms, like a set language (331 ms), same text
  in 30 of 30 recordings; German is still detected as German.
- **Whisper loads at start**, before the AI server: the first dictation no
  longer waits for it (1.2 s from a warm disk, 5.7 s cold), and the AI
  server's memory fit sees Whisper's share of the video memory.
- **Whisper keeps its state** between dictations: 50 ms less each time,
  same text in 20 of 20 recordings.
- **Fewer screen terms for the AI** (see Words on screen): AI time
  559 ms -> 389 ms in the median.
- After 10 minutes without a request, a hotkey press refreshes the AI's
  prompt cache while you speak; after a night of idling the first
  dictation had run into its time limit and was pasted without AI.
- On battery, Whisper and the AI model are unloaded after 10 minutes
  without dictation (about 5 GB of video memory and 3 GB of RAM), so a
  laptop's graphics card can sleep. The next press loads them while you
  speak.

### Fixed
- NVIDIA cards older than GTX 16 / RTX 20 (compute capability below 7.5)
  use Vulkan. The bundled CUDA kernels do not run on them, and the first
  transcription crashed the app.
- PCs with an integrated and a dedicated GPU: Whisper and the AI use the
  dedicated card (then the one with more memory), not whichever Vulkan
  lists first.
- Requests to the local AI server ignore a Windows system proxy.

### Diagnostics
- startup.log gets one "[timing]" line per dictation (start, audio,
  Whisper, text, AI, paste, clipboard restore, history) and a "[whisper]"
  line; the previous llm-server.log stays as llm-server.prev.log.
- New benchmarks in src-tauri/examples: warm_bench (first dictation after
  start), state_bench (Whisper state), terms_bench (screen terms),
  lang_bench (Auto-detect) and ctx_bench (a shorter encoder window: faster,
  but it changed or repeated words in 9 to 19 of 49 recordings, so it is
  not used).

## [0.7.0] - 2026-09-23 - Edit mode

### Added
- **Edit mode** (AI cleanup tab, on by default). Select text in any app,
  hold the hotkey and say what to change ("make it shorter", "more formal",
  "translate this into Turkish", "change five to six", "make this a list"),
  say the new wording itself, or say "delete that". The local model rewrites
  the selection and RudariFlow pastes over it; Ctrl+Z in the app undoes it.
  The pill shows "✎ 12 words" while you speak. With nothing selected the
  hotkey dictates as before. The selection is read through Windows UI
  Automation, so nothing is copied and no keys are pressed before you
  speak; apps that do not share their text, terminals, address and search
  bars, password fields, apps set to No AI and selections over 6,000
  characters get a normal dictation. History keeps the original text and
  what you said. Measured on an RX 6800: 0.2 to 0.7 s for a sentence,
  1.4 s to shorten and 3.7 s to rewrite a 900-character email.

### Changed
- The AI server keeps 8,192 tokens of context (was 4,096), enough for a
  6,000-character selection and its rewrite.

## [0.6.2] - 2026-09-23

### Improved
- **Write in** now says where it does not translate: a line under the
  setting names the apps whose rule says No AI ("Not translated in: code
  (No AI).") and warns when AI cleanup is off. Before, a No AI rule for the
  app you dictated into silently kept the spoken language.

## [0.6.1] - 2026-09-23 - Write in, dictionary import and export

### Added
- **Write in** (AI cleanup tab): pick one language and the AI writes every
  dictation in it, translating when you spoke another one. Meant for people
  who switch languages while speaking: set Engine > Language to Auto-detect
  so Whisper hears each language correctly, and the AI turns it into, say,
  English. The output check now makes sure the answer is in the chosen
  language. Default is "Same language as spoken", which keeps the old behaviour.
- **Dictionary import and export.** Export saves the list as a text file,
  one entry per line; Import merges a file into the list and skips words
  that are already there (commas, a UTF-8 BOM and blank lines are fine). Use
  it to keep the same dictionary on several PCs.

## [0.6.0] - 2026-09-23 - Local AI cleanup, dictionary and history

### Added
- **AI cleanup, fully local.** New tab. After Whisper, a language model on
  the PC removes fillers and false starts, applies spoken self-corrections,
  fixes grammar and punctuation, formats lists and (Polished style) smooths
  phrasing; Light keeps the wording. Per-app rules add instructions or turn
  the AI off, matched on the exe name or a whole word in the window title.
  Runs Gemma 4 E4B (default), 12B or E2B in a bundled llama.cpp server
  (b11100, Vulkan) on 127.0.0.1, on the GPU Whisper uses; the model
  downloads once. A test box shows the result and time. Replacement
  triggers are hidden from the model behind placeholders. The language
  Whisper heard is named in the request and answers in another language are
  discarded, so a rule such as "German: Sie-Form" cannot translate an
  English dictation. Any failure,
  missing model or time limit pastes the plain Whisper text. Measured on
  an RX 6800: 0.2 to 0.8 s per dictation. Off by default.
- **Dictionary tab** (replaces the Custom Vocabulary text box in Engine).
  An input with Add and a list with Remove, like Aqua Voice's dictionary;
  pasting a list with commas or line breaks adds every entry, duplicates
  are skipped. Entries are still stored in `customPrompt` (no migration).
  New: the transcript gets their exact spelling, also when Whisper hears
  them differently: case, spaces, hyphens, apostrophes and ß/ss are
  ignored when comparing, and entries of 8+ letters allow one letter off
  (12+: two), so "Grüß'n shop" becomes "Grüssen-Shop" without AI. Short
  entries need an exact match ("polar" never becomes "Polars"), and word
  forms that only add an ending ("Heinrichs") stay. AI cleanup receives
  the list in its cached system prompt.
- **Swiss spelling** switch in the Dictionary tab: ss instead of ß in
  every dictation, with or without AI.
- History keeps the app a dictation went into and, when the AI changed
  it, the original text ("Original" button).
- `scripts/setup-llama.ps1` and `examples/ai_bench.rs` (model benchmark).
- **Replacements.** A new tab maps spoken phrases to longer text ("my email" ->
  your address, links, signatures). Matched as whole words in any
  capitalisation, in one pass, longest phrase first; a dictation that is only
  the phrase inserts just the replacement, without Whisper's punctuation.
- **"Send it" voice command.** With Recording > Voice command set to Enter or
  Ctrl+Enter, a dictation ending in "Send it." / "Abschicken." (also "Send.",
  "Senden.", "Absenden.", "Schick es ab.") as its own sentence is pasted
  without the phrase and then submitted. The phrase only counts as a separate
  sentence, so "I'll send it." is pasted as dictated. Off by default.
- **History tab.** The last 200 dictations are stored in
  `history/history.json`, the last 50 with a 16 kHz WAV. Copy, play, delete,
  clear, and re-run a recording with the current engine and model (nothing is
  pasted). Setting: text and recordings (default), text only, or off.
  Dictations are saved even when the paste fails.
- **Paste last transcript hotkey** (default Alt+Shift+V, keyboard chords only,
  can be turned off). Works with history off, from memory.
- **Mute other apps while recording.** Mutes every audio session on every
  playback device except RudariFlow's own (the start/stop sounds keep
  playing) and sessions that were already muted, and unmutes exactly those
  when recording stops or is cancelled. Off by default.
- The language picker lists all ~100 Whisper languages, named in the UI
  language with the native name.
- `RUDARIFLOW_DATA_DIR` points a build at a separate settings/history folder.

### Changed
- Dictations are kept out of the Windows clipboard history (Win+V) and the
  cloud clipboard; so is the restored previous clipboard content.
- Settings rows: long hints wrap instead of squeezing the dropdown next to
  them, and dropdowns are as wide as their longest option.
- The sidebar shows the real app version (it was stuck at v0.4.0).
- The settings window has a fixed size (900 x 600) and cannot be maximized.

### Fixed
- Model downloads go to `<file>.part` and are renamed when complete, so an
  interrupted download no longer looks like a finished model; progress
  events are throttled to about 10 per second.
- **Microphone dropdown was blank** with the default setting, because the
  list had no entry for "default"; the next settings save then stored an empty
  device name, and every recording first failed to open "" and retried for
  0.4 s before falling back. The list now starts with "System default (device
  name)", a saved device that is unplugged stays listed as "not connected",
  and an empty saved value loads as "default".
- Pasting waits (up to 1.5 s) until Ctrl, Shift, Alt and Win are released, so
  a hotkey that is still held cannot turn Ctrl+V into Ctrl+Shift+V.
- The two clipboard unit tests no longer race each other.

## [0.5.1] - 2026-09-15 - Mouse side buttons as hotkey

### Added
- **Mouse side buttons as hotkey.** Press Mouse 4 (Back) or Mouse 5 (Forward),
  optionally with Ctrl/Shift/Alt/Win, while capturing the hotkey in settings.
  Implemented with a low-level mouse hook because `RegisterHotKey` only
  accepts keyboard keys. Toggle and push-to-talk both work; the bound button
  is consumed so it does not also navigate back/forward in the focused app.

## [0.5.0] - 2026-09-15 - One build for NVIDIA, AMD and Intel GPUs

### Added
- **Vulkan backend next to CUDA.** whisper.cpp is compiled with both; AMD
  Radeon (RX 6000 and newer) and Intel Arc are now GPU-accelerated instead of
  running on the CPU.
- **Runtime backend selection.** The app enumerates ggml's GPU devices and picks
  CUDA on NVIDIA, otherwise Vulkan, otherwise CPU. If a backend fails to load,
  Auto moves on to the next one.
- GPU Backend setting: Auto / NVIDIA CUDA / Vulkan / CPU only, plus a line
  showing the detected GPUs and which APIs they support.
- `bench` example to compare GPU with and without flash attention, and CPU.

### Changed
- Flash attention per backend: on for CUDA, off for Vulkan. On an RX 6800 (no
  cooperative-matrix support) large-v3-turbo took 910 ms with it vs 434 ms
  without for 17.5 s of audio. Override with `RUDARIFLOW_FLASH_ATTN=1|0`.
- Whisper uses up to 8 CPU threads on the GPU path too (log-mel extraction and
  non-offloaded ops run on the CPU).
- CUDA kernels built for compute 7.5/8.0/8.6/8.9/12.0 (RTX 20 to RTX 50) with
  CUDA 12.8; RTX 50 no longer depends on PTX JIT.
- The CUDA runtime (cudart, cuBLAS, cuBLASLt 12.8) and the Vulkan loader are
  installed next to `rudariflow.exe`, where Windows resolves load-time imports.
  Replaces the `binaries/cuda-runtime` folder and `SetDllDirectoryW`, which could
  not satisfy load-time imports on machines without a CUDA Toolkit.
- Model load logs the chosen backend and device to `startup.log`.

### Fixed
- **Hotkey stopped responding after idle.** Opening a USB audio interface that
  Windows had suspended could block forever while the recorder state lock was
  held. The microphone now opens on its own thread with a 6 s timeout, one
  retry and a fallback to the default input; failures show "Microphone
  unavailable" in the overlay.
- **Changing the hotkey could leave no hotkey at all** when the new chord was
  rejected. The new chord is registered before the old one is released, the
  current chord is paused while capturing, and digits/punctuation use the
  physical key code.
- A panic during transcription can no longer leave the app stuck in
  Transcribing; poisoned locks are recovered.
- Hotkey presses, microphone and transcription errors are written to
  `startup.log`.

### Build
- Prerequisites: CMake, LLVM (libclang), Vulkan SDK and CUDA Toolkit 12.x.
  `scripts/setup-whisper.ps1` collects the runtime DLLs from CUDA_PATH and
  System32. Set a short `CARGO_TARGET_DIR` (e.g. `C:\t\rf`); the nested Vulkan
  shader build exceeds the Windows path limit under `src-tauri\target`.
- Vulkan-only builds: `--no-default-features --features vulkan`.

## [0.4.0] — 2026-05-09 — Phase B: in-process whisper-rs

Architectural shift from per-dictation `whisper-cli.exe` subprocess to in-process
[`whisper-rs`](https://github.com/tazz4843/whisper-rs) bindings.

### Added
- **In-process transcription** via `whisper-rs` 0.16 — no more subprocess spawn,
  no stdout parsing, no temp-WAV-only IPC.
- **Persistent model.** The selected model is loaded once on first dictation and
  reused; stays resident in RAM until you change model or backend.
- **Hotkey-press warmup.** Pressing PTT kicks off model load in parallel so the
  model is hot by the time you stop speaking.
- **Streaming partial transcripts.** Each Whisper segment is emitted as a
  `partial-transcript` event and shown in the overlay as it's produced.
- **Engine auto-invalidation** when `whisperModel` or `gpuBackend` changes in
  Settings — no app restart needed.
- CUDA runtime DLLs isolated under `cuda-runtime/` and discovered via
  `SetDllDirectoryW` at startup.

### Changed
- `whisper.cpp` bundled statically into `rudariflow.exe` with CUDA kernels for 5
  GPU architectures (compute 75/80/86/89/90).
- Build prerequisite: **CUDA Toolkit 12.x** is now required to compile (runtime
  DLLs are still bundled, end users do not need it).
- README setup step now fetches only the 5 CUDA runtime DLLs (~80 MB) instead
  of the full whisper.cpp Windows build (~600 MB).

### Fixed
- Rapid-PTT race after a "no speech" notice — overlay no longer flickers hidden
  when you re-press immediately after a silent recording.

### Removed
- `whisper-cli.exe`, `whisper.dll`, `ggml*.dll` and the `transcribe_local.rs`
  subprocess module.
- `setup-whisper.ps1` no longer downloads the whisper.cpp release archive.

### Known issues
- Installer is larger than v0.3.0: NSIS ~362 MB (+84 MB), MSI ~748 MB (+312 MB),
  driven by static CUDA kernel embedding for 5 architectures. Optimization
  deferred to a later release.

---

## [0.3.0] — Phase C: surgical accuracy + UX wins

### Added
- **Custom Vocabulary** textarea in Settings — inject domain terms, names,
  jargon, and acronyms as a Whisper prompt to bias recognition.
- **No-speech notice** in the overlay when a recording was all silence,
  instead of pasting nothing or showing an error.
- **Clipboard preservation around auto-paste** — your previous clipboard
  contents are saved before paste and restored after.
- Energy-gated **silence trimming** before transcription.
- `audio-empty` event emitted when the trimmed clip has no signal.

### Changed
- Deterministic Whisper sampling flags.
- CPU-thread tuning surfaced for the local backend.
- Groq backend correctly threads the configured language.

### Fixed
- Stopped force-appending a terminal period to every transcript — text comes
  out as Whisper produced it.

### Removed
- Pruned unused whisper.cpp binaries from the bundle.

---

## [0.2.0] — CPU fallback backend + GPU Backend setting

### Added
- **CPU fallback backend** for AMD / Intel / no-GPU systems (significantly
  slower; `small` or `medium` model recommended).
- **GPU Backend setting** in the UI: auto / CUDA / CPU.
- Auto-detection of NVIDIA CUDA at runtime with fallback to CPU when
  unavailable.

### Fixed
- Console window flicker on transcription.
- Autostart now starts minimized to the tray.

---

## [0.1.0] — Initial release

Initial public release of RudariFlow: Tauri 2 dictation app for Windows with
local whisper.cpp transcription, global hotkey, push-to-talk and toggle modes,
auto-paste via simulated typing, system tray, and EN/DE UI.

[0.4.0]: https://github.com/oggii/RudariFlow/releases/tag/v0.4.0
[0.3.0]: https://github.com/oggii/RudariFlow/releases/tag/v0.3.0
[0.2.0]: https://github.com/oggii/RudariFlow/releases/tag/v0.2.0
[0.1.0]: https://github.com/oggii/RudariFlow/releases/tag/v0.1.0
