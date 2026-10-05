//! Meeting mode: an online call on this PC recorded as two tracks, the
//! microphone ("You") and what the PC plays ("Others"), transcribed live,
//! with the others told apart and AI notes after Stop. See
//! docs/superpowers/specs/2026-10-03-meeting-mode-design.md.
//!
//! `Meetings` holds the meeting that records, the ones whose end steps
//! run, and the player, and reports every change as an `Event`. The Tauri
//! commands, the tray items and the hotkey are in main.rs.
//!
//! Saving: `meeting.json` is written through a temp file of a fixed name,
//! so two saves of one meeting must never run at once. A meeting in `open`
//! (it records or runs its end steps) is saved only under its own mutex.
//! Any other meeting is loaded, changed and saved only while `open`'s lock
//! is held: the edits, Finish's first save, the notes of "Write notes",
//! Delete and the daily audio cleanup. A meeting goes into `open` and out
//! of it under that lock too, after its last save.

pub mod capture;
pub mod finish;
pub mod lines;
pub mod notes;
pub mod playback;
pub mod store;
pub mod wav;
pub mod worker;

use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

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
/// Old audio is looked for a minute after the start (not in its busiest
/// moment: it loads every meeting), then once a day by the clock on the
/// wall: a sleep of a day would not count the hours the PC sleeps, so the
/// clock is looked at every hour.
const CLEANUP_AFTER: Duration = Duration::from_secs(60);
const CLEANUP_EVERY_MS: u64 = 24 * 3600 * 1000;
const CLEANUP_CHECK: Duration = Duration::from_secs(3600);
/// Quit waits this long for the live transcription to end (a piece may be
/// running); then it is left behind.
const QUIT_WAIT: Duration = Duration::from_secs(2);
const PER_MS: u64 = wav::RATE as u64 / 1000;

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

/// "meeting-status": what records and what finishes (also a meeting whose
/// notes "Write notes" writes, at `Step::Notes`).
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

/// "meeting-lines": the paragraphs from `from` on are new or changed; the
/// view keeps its first `from` paragraphs and puts these after them (a view
/// that had more drops the rest: an echo was taken out).
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

/// What a meeting is recorded and transcribed with: the settings at Start
/// (`ai_model`: as they are at Stop, see `set_notes_model`).
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
    id: String,
    meeting: Arc<Mutex<Meeting>>,
    capture: Capture,
    stop: Arc<AtomicBool>,
    worker: JoinHandle<(Worker, Whisper)>,
    config: Config,
}

type Open = HashMap<String, Arc<Mutex<Meeting>>>;

pub struct Meetings {
    /// `<app data>\meetings`.
    root: PathBuf,
    app_dir: PathBuf,
    engine: Arc<WhisperEngine>,
    llm: Arc<LlmServer>,
    recording: Mutex<Option<Live>>,
    /// Meetings in memory while they record or run their end steps: edits
    /// go through these, so a step that saves later does not undo them. Its
    /// lock also guards the saves of the other meetings (see above).
    open: Mutex<Open>,
    /// Meetings whose notes "Write notes" is writing.
    writing: Mutex<HashSet<String>>,
    /// The paragraphs each view has, for "meeting-lines".
    shown: Mutex<HashMap<String, Vec<ParagraphView>>>,
    status: Mutex<Status>,
    /// What plays: the meeting's id ("" for the test command) and the player.
    player: Mutex<Option<(String, Player)>>,
    /// Players started so far: the end of one that was replaced is not
    /// reported as the end of the new one.
    plays: AtomicU64,
    /// The GPU is freed for a game (main.rs, Free GPU for games): Stop
    /// transcribes the rest with Whisper alone, lets go of it right after,
    /// and leaves the notes for "Write notes" (`NOTES_GAME`).
    for_game: AtomicBool,
    events: Box<dyn Fn(Event) + Send + Sync>,
    this: Weak<Meetings>,
}

/// The notes' "error" while the GPU is freed for a game: no AI now, "Write
/// notes" later.
pub const NOTES_GAME: &str = "game";

impl Meetings {
    /// The meetings in `<app_dir>\meetings`. Meetings a quit or crash cut
    /// off become interrupted now, and one whose `meeting.json` a power cut
    /// damaged is rebuilt from its audio (`german`: its title); old audio
    /// is deleted soon after and once a day.
    pub fn new(
        app_dir: &Path,
        engine: Arc<WhisperEngine>,
        llm: Arc<LlmServer>,
        german: bool,
        events: Box<dyn Fn(Event) + Send + Sync>,
    ) -> Arc<Meetings> {
        let root = store::root(app_dir);
        // Before anything records or saves; it logs what it did.
        store::recover(&root, german);
        let meetings = Arc::new_cyclic(|this| Meetings {
            root,
            app_dir: app_dir.to_path_buf(),
            engine,
            llm,
            recording: Mutex::new(None),
            open: Mutex::new(HashMap::new()),
            writing: Mutex::new(HashSet::new()),
            shown: Mutex::new(HashMap::new()),
            status: Mutex::new(Status::default()),
            player: Mutex::new(None),
            plays: AtomicU64::new(0),
            for_game: AtomicBool::new(false),
            events,
            this: this.clone(),
        });
        let this = Arc::downgrade(&meetings);
        let _ = std::thread::Builder::new().name("rf-meeting-cleanup".into()).spawn(move || {
            std::thread::sleep(CLEANUP_AFTER);
            let mut last = None;
            while let Some(meetings) = this.upgrade() {
                let now = store::now_ms();
                if cleanup_due(last, now) {
                    meetings.delete_old_audio();
                    last = Some(now);
                }
                drop(meetings);
                std::thread::sleep(CLEANUP_CHECK);
            }
        });
        meetings
    }

    /// The audio of meetings that ended 30 days ago. The candidates are
    /// found without a lock (that loads every meeting); each is looked at
    /// anew and changed under `open`'s lock, so nobody else saves it
    /// meanwhile, and a meeting in `open` is left alone.
    fn delete_old_audio(&self) {
        let now = store::now_ms();
        let mut deleted = 0;
        for id in store::old_audio(&self.root, now) {
            let open = lock(&self.open);
            if !open.contains_key(&id) && store::delete_audio_if_old(&self.root, &id, now) {
                deleted += 1;
            }
        }
        if deleted > 0 {
            startup_log::log(&format!("[meeting] audio of {} meetings deleted (30 days)", deleted));
        }
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

    /// Change the status and send it. main.rs hands it on to the main
    /// thread and does not wait for it, so the sender never hangs on a main
    /// thread that is busy.
    fn change_status(&self, change: impl FnOnce(&mut Status)) {
        let status = {
            let mut status = lock(&self.status);
            change(&mut status);
            status.clone()
        };
        self.emit(Event::Status(status));
    }

    /// Send the status as it is now (after a change made under the locks).
    fn send_status(&self) {
        let status = self.status();
        self.emit(Event::Status(status));
    }

    /// The bar of meeting `id`, if it is the one that records; sent only
    /// when it changed.
    fn change_recording(&self, id: &str, change: impl FnOnce(&mut Recording)) {
        let changed = {
            let mut status = lock(&self.status);
            match status.recording.as_mut().filter(|r| r.id == id) {
                Some(r) => {
                    let before = r.clone();
                    change(r);
                    (*r != before).then(|| status.clone())
                }
                None => None,
            }
        };
        if let Some(status) = changed {
            self.emit(Event::Status(status));
        }
    }

    fn warning(&self, id: &str, warning: Warning, on: bool) {
        self.change_recording(id, |r| {
            r.warnings.retain(|w| *w != warning);
            if on {
                r.warnings.push(warning);
            }
        });
    }

    fn set_paused(&self, id: &str, paused: bool) {
        self.change_recording(id, |r| r.paused = paused);
    }

    fn set_step(&self, id: &str, step: Step) {
        self.change_status(|s| {
            s.finishing.retain(|f| f.id != id);
            s.finishing.push(Finishing { id: id.to_string(), step });
        });
    }

    /// The end steps of `id` are over (finished or interrupted).
    fn end_step(&self, id: &str) {
        lock(&self.open).remove(id);
        lock(&self.shown).remove(id);
        self.change_status(|s| s.finishing.retain(|f| f.id != id));
        self.emit(Event::Changed);
    }

    /// Under `open`'s lock: whether `id` records, runs its end steps or gets
    /// its notes written.
    fn busy(&self, open: &Open, id: &str) -> bool {
        open.contains_key(id) || lock(&self.writing).contains(id)
    }

    /// Send the paragraphs that changed since the last time.
    fn emit_lines(&self, meeting: &Meeting) {
        let paragraphs = lines::paragraphs(&meeting.lines);
        let mut shown = lock(&self.shown);
        let old = shown.entry(meeting.id.clone()).or_default();
        let from = lines::changed_from(old, &paragraphs);
        if from == old.len() && from == paragraphs.len() {
            return;
        }
        self.emit(Event::Lines(LinesChanged { id: meeting.id.clone(), from, paragraphs: paragraphs[from..].to_vec() }));
        *old = paragraphs;
    }

    /// Start recording a meeting; returns its id. Errors: "already_recording",
    /// "no_model" (no Whisper model downloaded), "disk_full" (under 1 GB
    /// free), or why a file could not be created. Not on the main thread:
    /// the devices take a moment to open.
    pub fn start(&self, title: Option<String>, config: Config) -> Result<String, String> {
        let id = {
            let mut live = lock(&self.recording);
            let recording = self.begin(&mut live, title, config)?;
            let id = recording.id.clone();
            // With `recording` held (lock order: recording, then status), so
            // the bar and `is_recording` never disagree; sent after.
            lock(&self.status).recording = Some(recording);
            id
        };
        self.send_status();
        self.emit(Event::Changed);
        // ▶ would play into the loopback, so into this meeting (a ▶ that
        // starts meanwhile stops itself, see `play`).
        self.stop_playing();
        startup_log::log(&format!("[meeting] {} started", id));
        Ok(id)
    }

    /// `start` while `recording` is locked: the files, the capture and the
    /// live transcription. Returns the bar's entry.
    fn begin(&self, live: &mut Option<Live>, title: Option<String>, config: Config) -> Result<Recording, String> {
        if live.is_some() {
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
        let (this, warned) = (self.this.clone(), id.clone());
        let report: Report = Box::new(move |warning, on| {
            if let Some(m) = this.upgrade() {
                m.warning(&warned, warning, on);
            }
        });
        let (this, limited) = (self.this.clone(), id.clone());
        let on_limit = Box::new(move || {
            if let Some(m) = this.upgrade() {
                // Not on the capture thread: stopping joins it.
                std::thread::spawn(move || {
                    if lock(&m.status).recording.as_ref().is_some_and(|r| r.id == limited) {
                        m.emit(Event::Limit);
                        let _ = m.stop_if(Some(&limited));
                    }
                });
            }
        });
        let setup = Setup {
            microphone: config.microphone.clone(),
            loopback: capture::loopback_override(),
            you: dir.join(YOU_WAV),
            others: dir.join(OTHERS_WAV),
            max_samples: MAX_MS * PER_MS,
        };
        let capture = match Capture::start(setup, report, on_limit) {
            Ok(capture) => capture,
            Err(e) => {
                let _ = store::delete(&self.root, &id);
                return Err(e);
            }
        };
        // After the Free GPU hotkey the transcript waits (Ruling 6).
        let paused = self.engine.released();
        let meeting = Arc::new(Mutex::new(meeting));
        let stop = Arc::new(AtomicBool::new(false));
        let whisper = config.whisper(&self.engine, &config.language);
        let source = Tracks::recording(dir, capture.written.clone());
        let load = (self.engine.clone(), config.model_path.clone(), config.gpu_backend.clone());
        let (this, m, s, live_id) = (self.this.clone(), meeting.clone(), stop.clone(), id.clone());
        let worker = std::thread::Builder::new()
            .name("rf-meeting-worker".into())
            .spawn(move || transcribe_live(this, live_id, m, source, whisper, s, load, paused));
        let worker = match worker {
            Ok(worker) => worker,
            Err(e) => {
                capture.stop();
                let _ = store::delete(&self.root, &id);
                return Err(e.to_string());
            }
        };
        lock(&self.open).insert(id.clone(), meeting.clone());
        *live = Some(Live { id: id.clone(), meeting, capture, stop, worker, config });
        Ok(Recording { id, title, started_at: now, warnings: Vec::new(), paused })
    }

    /// AI cleanup was switched or another AI model picked: the meeting that
    /// records writes its notes with the setting as it is at Stop, so Stop
    /// does not start an AI that was switched off meanwhile (and writes the
    /// notes when it was switched on). Not on the main thread: `recording`
    /// is held while a meeting starts and its devices open.
    pub fn set_notes_model(&self, ai_model: Result<PathBuf, String>) {
        if let Some(live) = lock(&self.recording).as_mut() {
            live.config.ai_model = ai_model;
        }
    }

    /// Stop recording; the end steps run in the background ("meeting-status"
    /// shows them). Error "not_recording". Not on the main thread: the
    /// devices take up to 3 s to close.
    pub fn stop(&self) -> Result<(), String> {
        self.stop_if(None)
    }

    /// Free GPU for games freed the GPU (true) or no longer holds it.
    pub fn set_freed_for_game(&self, on: bool) {
        self.for_game.store(on, SeqCst);
    }

    fn freed_for_game(&self) -> bool {
        self.for_game.load(SeqCst)
    }

    /// What the Free GPU hotkey has freed right now.
    fn freed(&self) -> Freed {
        Freed { ai: self.llm.released(), whisper: self.engine.released() }
    }

    /// `stop`, with `only`: only that meeting (the 4-hour limit).
    fn stop_if(&self, only: Option<&str>) -> Result<(), String> {
        // Before the devices close and the live transcription ends, which
        // takes seconds: a Free GPU press from here on is one during the
        // end steps and keeps the GPU free (`end_steps`).
        let freed = self.freed();
        let live = {
            let mut live = lock(&self.recording);
            if !stops(live.as_ref().map(|l| l.id.as_str()), only) {
                return Err("not_recording".to_string());
            }
            let live = live.take().ok_or_else(|| "not_recording".to_string())?;
            // "Finishing…" at once, with `recording` held (see `start`); the
            // devices close meanwhile.
            let mut status = lock(&self.status);
            if status.recording.as_ref().is_some_and(|r| r.id == live.id) {
                status.recording = None;
            }
            status.finishing.retain(|f| f.id != live.id);
            status.finishing.push(Finishing { id: live.id.clone(), step: Step::Transcribing });
            live
        };
        self.send_status();
        let Live { id, meeting, capture, stop, worker, config } = live;
        stop.store(true, SeqCst);
        let samples = capture.stop();
        let dir = {
            let mut m = lock(&meeting);
            m.length_ms = samples / PER_MS;
            m.state = State::Finishing;
            save(&self.root, &m);
            m.dir(&self.root)
        };
        startup_log::log(&format!("[meeting] {} stopped after {} s", id, samples / wav::RATE as u64));
        self.emit(Event::Changed);
        let Some(this) = self.this.upgrade() else {
            self.interrupt(&id, &meeting);
            return Err("shutting down".to_string());
        };
        let m = meeting.clone();
        // The live transcription ends after the piece it may be running,
        // which can wait for a block of a file: joined on the end steps'
        // thread, not here.
        let spawned = std::thread::Builder::new().name("rf-meeting-finish".into()).spawn(move || {
            let (worker, whisper) = match worker.join() {
                Ok(both) => both,
                Err(_) => {
                    startup_log::log("[meeting] the live transcription stopped with a panic; the end steps go on from the saved lines");
                    let m = lock(&m);
                    (Worker::new(m.you_done_ms, m.others_done_ms, &m.lines), config.whisper(&this.engine, &m.language))
                }
            };
            this.end_steps_guarded(m, worker, whisper, Tracks::saved(dir), config, freed)
        });
        if let Err(e) = spawned {
            self.interrupt(&id, &meeting);
            return Err(e.to_string());
        }
        Ok(())
    }

    /// The end steps of an open meeting could not start: interrupted, for
    /// Finish later.
    fn interrupt(&self, id: &str, meeting: &Mutex<Meeting>) {
        {
            let mut m = lock(meeting);
            m.state = State::Interrupted;
            save(&self.root, &m);
        }
        self.end_step(id);
    }

    /// `end_steps`; a panic in them leaves the meeting interrupted (Finish
    /// later) rather than busy until the next start.
    fn end_steps_guarded(&self, meeting: Arc<Mutex<Meeting>>, worker: Worker, whisper: Whisper, source: Tracks, config: Config, freed: Freed) {
        let id = lock(&meeting).id.clone();
        let m = meeting.clone();
        let steps = std::panic::catch_unwind(AssertUnwindSafe(|| self.end_steps(m, worker, whisper, source, config, freed)));
        if steps.is_err() {
            startup_log::log(&format!("[meeting] {}: the end steps stopped with a panic", id));
            let finished = lock(&meeting).state == State::Finished;
            if finished {
                self.end_step(&id);
            } else {
                self.interrupt(&id, &meeting);
            }
        }
    }

    /// The end steps of `meeting` (see `finish::run`) with the real Whisper,
    /// speaker models and AI. `freed`: what the Free GPU hotkey had freed
    /// when Stop (or Finish) was pressed. Freed before that, Stop loads the
    /// models again; a press since then keeps the GPU free
    /// (`notes_allowed`).
    fn end_steps(&self, meeting: Arc<Mutex<Meeting>>, worker: Worker, mut whisper: Whisper, source: Tracks, config: Config, freed: Freed) {
        let (id, audio) = {
            let m = lock(&meeting);
            (m.id.clone(), !m.audio_deleted)
        };
        // Pressed while the devices closed and the live transcription
        // ended: Whisper is not loaded again, and audio that is left makes
        // the meeting interrupted, for Finish later (Ruling 4).
        let pressed = pressed_since(freed, self.freed());
        if pressed {
            startup_log::log(&format!("[meeting] {}: Free GPU was pressed after Stop: the models stay unloaded", id));
        }
        let ai_freed = freed.ai;
        // Stop loads Whisper, also after a Free GPU press before Stop, when
        // there is audio left to transcribe.
        let loaded = audio
            && !pressed
            && finish::left(&source, &worker)
            && self
                .engine
                .ensure_loaded(&config.model_path, &config.gpu_backend)
                .inspect_err(|e| startup_log::log(&format!("[meeting] {}: Whisper did not load: {}", id, e)))
                .is_ok();
        // Still freed from before Stop (the load above ends that): a
        // release from now on is a press.
        let whisper_freed = freed.whisper && self.engine.released();
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
        let notes = |transcript: &str, language: &str| {
            // Freed for a game: no AI now; "Write notes" writes them later.
            if self.freed_for_game() {
                return Err(NOTES_GAME.to_string());
            }
            // Freed during the end steps: the AI is not started again.
            if !notes_allowed(ai_freed, self.llm.released()) || !notes_allowed(whisper_freed, self.engine.released()) {
                return Err("gpu_freed".to_string());
            }
            self.notes_now(&config.ai_model, &config.gpu_backend, transcript, language)
        };
        // The run let go of Whisper right after the transcription; the
        // speakers come next.
        let mut transcribed = false;
        finish::run(
            &self.root,
            &meeting,
            worker,
            for_the_rest(&mut whisper, loaded),
            &source,
            separate,
            notes,
            &mut |step| {
                if step == Step::Speakers && !transcribed {
                    transcribed = true;
                    self.after_the_rest(&config, &id);
                }
                self.set_step(&id, step)
            },
            &mut |m| self.emit_lines(m),
        );
        drop(whisper);
        if !transcribed {
            // Interrupted: also right after the transcription.
            self.after_the_rest(&config, &id);
        }
        let state = lock(&meeting).state;
        startup_log::log(&format!("[meeting] {} end steps done: {:?}", id, state));
        self.end_step(&id);
    }

    /// The rest is transcribed: while the GPU is freed for a game, Whisper
    /// goes again (it was loaded for the rest only); with the cloud engine
    /// it is not kept either. Not while another meeting transcribes with it.
    fn after_the_rest(&self, config: &Config, id: &str) {
        if self.freed_for_game() && !self.whisper_in_use(id) {
            self.engine.release();
            startup_log::log(&format!("[meeting] {}: the GPU is freed for a game: Whisper unloaded again", id));
            return;
        }
        self.unload_whisper(config, id);
    }

    /// With the cloud engine the local model is not kept, unless another
    /// meeting still transcribes with it.
    fn unload_whisper(&self, config: &Config, id: &str) {
        if config.unload_after && !self.whisper_in_use(id) {
            self.engine.invalidate();
        }
    }

    /// Whether a meeting other than `id` records or transcribes its rest.
    fn whisper_in_use(&self, id: &str) -> bool {
        self.is_recording() || lock(&self.status).finishing.iter().any(|f| f.id != id && f.step == Step::Transcribing)
    }

    /// Notes by the AI, waited for. "gpu_freed" when the Free GPU hotkey
    /// stopped the AI (as in the Files tab's summary).
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
        let status = self.status();
        let meeting = status.recording.as_ref().and_then(|r| self.get(&r.id).ok());
        Current { status, meeting }
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
        {
            let open = lock(&self.open);
            match open.get(id) {
                Some(meeting) => {
                    let mut m = lock(meeting);
                    change(&mut m)?;
                    m.save(&self.root)?;
                }
                None => {
                    let mut m = store::load(&self.root, id)?;
                    change(&mut m)?;
                    m.save(&self.root)?;
                }
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
        self.change_recording(id, |r| r.title = title);
        Ok(())
    }

    /// Name Speaker `speaker + 1` of the others in this meeting ("" =
    /// "Speaker n" again). "You" has no number and keeps its name.
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

    /// Delete a meeting with its audio; not while it records, finishes or
    /// gets its notes ("busy").
    pub fn delete(&self, id: &str) -> Result<(), String> {
        if self.busy(&lock(&self.open), id) {
            return Err("busy".to_string());
        }
        // Not under `open`'s lock: a wedged output takes up to 3 s.
        self.stop_playing_meeting(id);
        {
            let open = lock(&self.open);
            if self.busy(&open, id) {
                return Err("busy".to_string());
            }
            if !store::valid_id(id) || !self.root.join(id).is_dir() {
                return Err("no_meeting".to_string());
            }
            store::delete(&self.root, id)?;
        }
        lock(&self.shown).remove(id);
        self.emit(Event::Changed);
        startup_log::log(&format!("[meeting] {} deleted", id));
        Ok(())
    }

    /// Run the end steps of an interrupted meeting on its saved audio,
    /// transcribing what its lines do not cover yet. Errors: "busy",
    /// "no_meeting", "not_interrupted", "no_audio" (deleted after 30 days:
    /// "Write notes" still works), "no_model" (Whisper is needed and not
    /// downloaded).
    pub fn finish(&self, id: &str, config: Config) -> Result<(), String> {
        // As at Stop: a Free GPU press from here on keeps the GPU free.
        let freed = self.freed();
        let (meeting, worker, source, language) = {
            let mut open = lock(&self.open);
            if self.busy(&open, id) {
                return Err("busy".to_string());
            }
            let mut m = store::load(&self.root, id)?;
            if m.state != State::Interrupted {
                return Err("not_interrupted".to_string());
            }
            if m.audio_deleted {
                return Err("no_audio".to_string());
            }
            let worker = Worker::new(m.you_done_ms, m.others_done_ms, &m.lines);
            let source = Tracks::saved(m.dir(&self.root));
            if finish::left(&source, &worker) && !config.model_path.exists() {
                return Err("no_model".to_string());
            }
            m.state = State::Finishing;
            m.save(&self.root)?;
            let language = if m.language.is_empty() { config.language.clone() } else { m.language.clone() };
            let meeting = Arc::new(Mutex::new(m));
            open.insert(id.to_string(), meeting.clone());
            (meeting, worker, source, language)
        };
        self.set_step(id, Step::Transcribing);
        self.emit(Event::Changed);
        let whisper = config.whisper(&self.engine, &language);
        let Some(this) = self.this.upgrade() else {
            self.interrupt(id, &meeting);
            return Err("shutting down".to_string());
        };
        let m = meeting.clone();
        let spawned = std::thread::Builder::new()
            .name("rf-meeting-finish".into())
            .spawn(move || this.end_steps_guarded(m, worker, whisper, source, config, freed));
        if let Err(e) = spawned {
            self.interrupt(id, &meeting);
            return Err(e.to_string());
        }
        startup_log::log(&format!("[meeting] {}: Finish", id));
        Ok(())
    }

    /// Write the notes again or for the first time (the "Write notes"
    /// button), with `model` even when AI cleanup is off. The meeting stays
    /// on disk meanwhile (edits go there); the notes are put into it then.
    pub fn write_notes(&self, id: &str, model: PathBuf, gpu_backend: String) -> Result<(), String> {
        let (transcript, language) = {
            let open = lock(&self.open);
            if self.busy(&open, id) {
                return Err("busy".to_string());
            }
            let m = store::load(&self.root, id)?;
            lock(&self.writing).insert(id.to_string());
            (lines::transcript(&m.lines, &m.speaker_names), m.language.clone())
        };
        self.set_step(id, Step::Notes);
        let Some(this) = self.this.upgrade() else {
            self.end_notes(id);
            return Err("shutting down".to_string());
        };
        let notes_id = id.to_string();
        let spawned = std::thread::Builder::new().name("rf-meeting-notes".into()).spawn(move || {
            let id = notes_id;
            let written = if transcript.trim().is_empty() {
                Err("empty".to_string())
            } else {
                std::panic::catch_unwind(AssertUnwindSafe(|| this.notes_now(&Ok(model), &gpu_backend, &transcript, &language)))
                    .unwrap_or_else(|_| Err("the notes stopped with a panic".to_string()))
            };
            if let Err(e) = &written {
                startup_log::log(&format!("[meeting] {}: no notes: {}", id, e));
            }
            if let Err(e) = this.put_notes(&id, written) {
                startup_log::log(&format!("[meeting] {}: notes not saved: {}", id, e));
            }
            this.end_notes(&id);
        });
        if let Err(e) = spawned {
            self.end_notes(id);
            return Err(e.to_string());
        }
        Ok(())
    }

    /// Put the notes "Write notes" wrote (or why there are none) into the
    /// meeting as it is on disk now, under `open`'s lock: edits made while
    /// they were written stay, and so do earlier notes when there are none.
    fn put_notes(&self, id: &str, written: Result<Notes, String>) -> Result<(), String> {
        let _open = lock(&self.open);
        let mut m = store::load(&self.root, id)?;
        match written {
            Ok(n) => {
                m.notes = Some(n);
                m.notes_error = None;
            }
            Err(e) => m.notes_error = Some(e),
        }
        m.save(&self.root)
    }

    fn end_notes(&self, id: &str) {
        lock(&self.writing).remove(id);
        self.change_status(|s| s.finishing.retain(|f| f.id != id));
        self.emit(Event::Changed);
    }

    /// ▶: play the meeting from `from_ms`, both tracks mixed, on Windows'
    /// default output (the test override's device in the live checks).
    /// Error "recording" while any meeting records: the loopback would
    /// record it into that meeting (Ruling 13).
    pub fn play(&self, id: &str, from_ms: u64) -> Result<(), String> {
        if self.is_recording() {
            return Err("recording".to_string());
        }
        let m = self.load(id)?;
        if m.audio_deleted {
            return Err("no_audio".to_string());
        }
        self.stop_playing();
        let source = playback::meeting_source(&m.dir(&self.root), from_ms);
        // Before the start: a short rest may end at once.
        self.emit(Event::Playing(Some(Playing { id: id.to_string(), from_ms })));
        if let Err(e) = self.start_player(id, source, capture::loopback_override()) {
            self.emit(Event::Playing(None));
            return Err(e);
        }
        // A meeting that started meanwhile found no player yet.
        if self.is_recording() {
            self.stop_playing();
            return Err("recording".to_string());
        }
        Ok(())
    }

    /// Test only: play 16 kHz mono samples on the test override's device,
    /// never on a real output. Error "no_test_device" without one. Allowed
    /// while a meeting records: that is what the live checks record.
    pub fn test_play(&self, samples: Vec<f32>) -> Result<(), String> {
        let device = capture::loopback_override().ok_or_else(|| "no_test_device".to_string())?;
        self.stop_playing();
        self.start_player("", playback::samples_source(samples), Some(device))
    }

    fn start_player(&self, id: &str, source: playback::Source, device: Option<String>) -> Result<(), String> {
        let this = self.this.clone();
        let nth = self.plays.fetch_add(1, SeqCst) + 1;
        // On the player's own thread: only the event (dropping the player
        // there would make the thread join itself).
        let ended = Box::new(move || {
            if let Some(m) = this.upgrade().filter(|m| m.plays.load(SeqCst) == nth) {
                m.emit(Event::Playing(None));
            }
        });
        let player = Player::start(source, device, ended)?;
        *lock(&self.player) = Some((id.to_string(), player));
        Ok(())
    }

    pub fn stop_playing(&self) {
        let player = lock(&self.player).take();
        if let Some((_, player)) = player {
            let was_playing = !player.is_finished();
            player.stop();
            if was_playing {
                self.emit(Event::Playing(None));
            }
        }
    }

    fn stop_playing_meeting(&self, id: &str) {
        let plays = lock(&self.player).as_ref().is_some_and(|(playing, _)| playing == id);
        if plays {
            self.stop_playing();
        }
    }

    /// Quit (on the main thread): a meeting that records stops at once and
    /// becomes interrupted; Finish runs its end steps later (Ruling 3).
    /// Meetings finishing stay "finishing" on disk and are recovered at the
    /// next start. No status is sent: the app is closing, and the main
    /// thread, which would pass it on, is the one that runs this.
    pub fn shutdown(&self) {
        self.stop_playing();
        let live = {
            let mut live = lock(&self.recording);
            let Some(live) = live.take() else { return };
            // Not sent (see above).
            lock(&self.status).recording = None;
            live
        };
        let Live { id, meeting, capture, stop, worker, .. } = live;
        stop.store(true, SeqCst);
        let samples = capture.stop();
        {
            let mut m = lock(&meeting);
            m.length_ms = samples / PER_MS;
            m.state = State::Interrupted;
            save(&self.root, &m);
        }
        startup_log::log(&format!("[meeting] {} interrupted by quit", id));
        // Not joined for long: a piece may be running, and wait for a block
        // of a file. Its save keeps the state (same lock, same meeting).
        let until = Instant::now() + QUIT_WAIT;
        while !worker.is_finished() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        if worker.is_finished() {
            let _ = worker.join();
        }
    }
}

/// Whether a stop asked for `only` (or any meeting, `None`) stops the
/// meeting that records, `recording`.
fn stops(recording: Option<&str>, only: Option<&str>) -> bool {
    recording.is_some_and(|id| only.is_none_or(|only| only == id))
}

/// Whether the notes may start the AI: not after a Free GPU press during
/// the end steps (not released at their start, released now). Freed before
/// them, Stop loads the models.
fn notes_allowed(released_at_start: bool, released_now: bool) -> bool {
    released_at_start || !released_now
}

/// What the Free GPU hotkey had freed at a moment (`released()` of the AI
/// and of Whisper). Taken when Stop or Finish is pressed, before anything
/// they do, and handed to the end steps.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Freed {
    ai: bool,
    whisper: bool,
}

/// Whether Free GPU was pressed between `before` (Stop) and `now`: one of
/// the two was not freed then and is now.
fn pressed_since(before: Freed, now: Freed) -> bool {
    !notes_allowed(before.ai, now.ai) || !notes_allowed(before.whisper, now.whisper)
}

/// Whisper for the rest of the audio: `whisper` when it is loaded for
/// that. With nothing left to transcribe (both tracks were caught up at
/// Stop) or no model, none; then the live transcription's run lets go of
/// Whisper now, not after the speakers and the notes.
fn for_the_rest(whisper: &mut dyn Transcriber, loaded: bool) -> Option<&mut dyn Transcriber> {
    if loaded {
        Some(whisper)
    } else {
        whisper.release();
        None
    }
}

/// Whether the daily look for old audio is due: none yet, a day or more
/// since the last one (`last_ms`) by the clock, or the clock was set back
/// behind it.
fn cleanup_due(last_ms: Option<u64>, now_ms: u64) -> bool {
    last_ms.is_none_or(|last| now_ms < last || now_ms - last >= CLEANUP_EVERY_MS)
}

fn save(root: &Path, meeting: &Meeting) {
    if let Err(e) = meeting.save(root) {
        startup_log::log(&format!("[meeting] {} not saved: {}", meeting.id, e));
    }
}

/// The live transcription while a meeting records. Whisper loads first if
/// it is not loaded (not yet, or the battery watcher unloaded it), but not
/// after the Free GPU hotkey: then the transcript waits for the next
/// dictation, the hotkey again, or Stop (Ruling 6). A panic ends the live
/// transcription with the bar saying "paused"; Stop transcribes the rest
/// from the saved lines on.
#[allow(clippy::too_many_arguments)]
fn transcribe_live(
    this: Weak<Meetings>,
    id: String,
    meeting: Arc<Mutex<Meeting>>,
    source: Tracks,
    mut whisper: Whisper,
    stop: Arc<AtomicBool>,
    (engine, model, backend): (Arc<WhisperEngine>, PathBuf, String),
    mut paused: bool,
) -> (Worker, Whisper) {
    let mut worker = Worker::new(0, 0, &[]);
    let live = std::panic::catch_unwind(AssertUnwindSafe(|| {
        if !engine.released() {
            if let Err(e) = engine.ensure_loaded(&model, &backend) {
                startup_log::log(&format!("[meeting] Whisper did not load: {}", e));
            }
        }
        while !stop.load(SeqCst) {
            let Some(meetings) = this.upgrade() else { break };
            match worker.step(&source, &mut whisper, false) {
                Ok(Some(piece)) => {
                    if paused {
                        paused = false;
                        meetings.set_paused(&id, false);
                    }
                    let mut m = lock(&meeting);
                    finish::apply_piece(&mut m, piece);
                    save(&meetings.root, &m);
                    meetings.emit_lines(&m);
                    // Catching up: the next piece at once.
                    continue;
                }
                Ok(None) => {}
                Err(e) if e == PAUSED => {
                    if !paused {
                        paused = true;
                        meetings.set_paused(&id, true);
                    }
                }
                Err(e) => startup_log::log(&format!("[meeting] {}: a piece was skipped: {}", id, e)),
            }
            drop(meetings);
            std::thread::sleep(TICK);
        }
    }));
    if live.is_err() {
        startup_log::log(&format!("[meeting] {}: the live transcription stopped with a panic; Stop transcribes the rest", id));
        if let Some(meetings) = this.upgrade() {
            meetings.set_paused(&id, true);
        }
        whisper.release();
        let m = lock(&meeting);
        worker = Worker::new(m.you_done_ms, m.others_done_ms, &m.lines);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::store::{ActionItem, Line, Track};
    use crate::meeting::wav::TrackFile;

    fn setup(name: &str) -> (PathBuf, Arc<Meetings>, Arc<Mutex<Vec<Event>>>) {
        let app_dir = std::env::temp_dir().join(format!("rudariflow_meetings_{}", name));
        let _ = std::fs::remove_dir_all(&app_dir);
        std::fs::create_dir_all(&app_dir).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let llm = Arc::new(LlmServer::new(app_dir.join("llama"), app_dir.join("llm-server.log"), Box::new(|_| {})));
        let meetings = Meetings::new(&app_dir, Arc::new(WhisperEngine::new()), llm, false, Box::new(move |e| seen.lock().unwrap().push(e)));
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
        // And one whose file a power cut emptied, with a second of audio.
        let damaged = store::root(&app_dir).join("m-000000000002");
        std::fs::create_dir_all(&damaged).unwrap();
        std::fs::write(damaged.join(store::FILE), b"").unwrap();
        let mut track = TrackFile::create(&damaged.join(YOU_WAV)).unwrap();
        track.append(&[0.1; 16_000]).unwrap();
        drop(track);
        let llm = Arc::new(LlmServer::new(app_dir.join("llama"), app_dir.join("llm-server.log"), Box::new(|_| {})));
        let meetings = Meetings::new(&app_dir, Arc::new(WhisperEngine::new()), llm, true, Box::new(|_| {}));
        assert_eq!(meetings.get("m-000000000001").unwrap().meeting.state, State::Interrupted);
        assert_eq!(meetings.status(), Status::default());
        let rebuilt = meetings.get("m-000000000002").unwrap().meeting;
        assert_eq!((rebuilt.state, rebuilt.length_ms, rebuilt.audio_deleted), (State::Interrupted, 1_000, false));
        assert!(rebuilt.title.starts_with("Meeting ") && rebuilt.title.contains(". "), "a German title: {}", rebuilt.title);
        assert_eq!(meetings.list("").len(), 2, "the library shows it");
        // Finish takes it (here it stops at the missing Whisper model).
        assert_eq!(meetings.finish("m-000000000002", config(&app_dir)), Err("no_model".into()));
        meetings.delete("m-000000000002").unwrap();
        assert!(!damaged.exists(), "and it can be deleted");
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

    /// Waits until no end steps and no notes run.
    fn settled(meetings: &Meetings) {
        let until = Instant::now() + Duration::from_secs(20);
        while !meetings.status().finishing.is_empty() {
            assert!(Instant::now() < until, "still busy: {:?}", meetings.status());
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn finish_runs_the_end_steps_of_an_interrupted_meeting() {
        let (app_dir, meetings, events) = setup("finish");
        let root = store::root(&app_dir);
        // All its audio transcribed (none on disk): no Whisper needed.
        saved(&app_dir, "m-000000000001", State::Interrupted);
        let mut gone = saved(&app_dir, "m-000000000002", State::Interrupted);
        gone.audio_deleted = true;
        gone.save(&root).unwrap();
        assert_eq!(meetings.finish("m-000000000002", config(&app_dir)), Err("no_audio".into()), "Write notes still works");
        let left = saved(&app_dir, "m-000000000003", State::Interrupted);
        let mut track = TrackFile::create(&left.dir(&root).join(YOU_WAV)).unwrap();
        track.append(&[0.1; 16_000]).unwrap();
        track.finish().unwrap();
        assert_eq!(meetings.finish("m-000000000003", config(&app_dir)), Err("no_model".into()), "a second to transcribe");
        assert_eq!(store::load(&root, "m-000000000003").unwrap().state, State::Interrupted);
        meetings.finish("m-000000000001", config(&app_dir)).unwrap();
        settled(&meetings);
        let done = meetings.get("m-000000000001").unwrap().meeting;
        assert_eq!(done.state, State::Finished);
        assert_eq!(done.speakers_error.as_deref(), Some("no_model"), "no speaker models here");
        assert_eq!(done.notes_error.as_deref(), Some("ai_off"));
        assert_eq!(done.notes.unwrap().summary, "Hi.", "earlier notes stay");
        assert_eq!(meetings.finish("m-000000000001", config(&app_dir)), Err("not_interrupted".into()));
        let mut steps: Vec<Step> = Vec::new();
        for e in events.lock().unwrap().iter() {
            if let Event::Status(s) = e {
                if let Some(f) = s.finishing.iter().find(|f| f.id == "m-000000000001") {
                    if steps.last() != Some(&f.step) {
                        steps.push(f.step);
                    }
                }
            }
        }
        assert_eq!(steps, [Step::Transcribing, Step::Speakers, Step::Notes]);
        assert!(meetings.open.lock().unwrap().is_empty());
    }

    #[test]
    fn a_meeting_in_memory_is_edited_there_and_is_busy() {
        let (app_dir, meetings, _) = setup("open");
        let m = saved(&app_dir, "m-000000000001", State::Finishing);
        let open = Arc::new(Mutex::new(m));
        meetings.open.lock().unwrap().insert("m-000000000001".into(), open.clone());
        meetings.rename("m-000000000001", "Live call").unwrap();
        assert_eq!(open.lock().unwrap().title, "Live call", "in memory");
        assert_eq!(store::load(&store::root(&app_dir), "m-000000000001").unwrap().title, "Live call", "and saved");
        open.lock().unwrap().lines.clear();
        assert!(meetings.get("m-000000000001").unwrap().meeting.lines.is_empty(), "shown from memory");
        assert_eq!(meetings.list("live call").len(), 1);
        assert_eq!(meetings.delete("m-000000000001"), Err("busy".into()));
        assert_eq!(meetings.finish("m-000000000001", config(&app_dir)), Err("busy".into()));
        assert_eq!(meetings.write_notes("m-000000000001", app_dir.join("ai.gguf"), "cpu".into()), Err("busy".into()));
        assert_eq!(meetings.delete("m-0000000000ff"), Err("no_meeting".into()));
        assert_eq!(meetings.delete("..\\..\\x"), Err("no_meeting".into()));
    }

    #[test]
    fn write_notes_without_words_says_so() {
        let (app_dir, meetings, events) = setup("notes");
        let mut m = saved(&app_dir, "m-000000000001", State::Finished);
        m.lines.clear();
        m.save(&store::root(&app_dir)).unwrap();
        meetings.write_notes("m-000000000001", app_dir.join("ai.gguf"), "cpu".into()).unwrap();
        settled(&meetings);
        let m = meetings.get("m-000000000001").unwrap().meeting;
        assert_eq!(m.notes_error.as_deref(), Some("empty"));
        assert_eq!(m.notes.unwrap().summary, "Hi.", "earlier notes stay");
        assert!(meetings.writing.lock().unwrap().is_empty());
        assert!(events.lock().unwrap().contains(&Event::Changed));
        assert_eq!(meetings.write_notes("m-0000000000ff", app_dir.join("ai.gguf"), "cpu".into()), Err("no_meeting".into()));
        assert!(meetings.writing.lock().unwrap().is_empty());
    }

    #[test]
    fn warnings_and_pauses_go_to_the_meeting_they_are_for() {
        let (_, meetings, events) = setup("bar");
        meetings.status.lock().unwrap().recording =
            Some(Recording { id: "m-000000000001".into(), title: "Call".into(), started_at: 0, warnings: vec![], paused: false });
        let sent = || events.lock().unwrap().iter().filter(|e| matches!(e, Event::Status(_))).count();
        // A meeting that stopped while the next one started.
        meetings.warning("m-000000000002", Warning::MicLost, true);
        meetings.set_paused("m-000000000002", true);
        meetings.rename("m-000000000002", "Old").unwrap_err();
        assert_eq!(sent(), 0, "nothing for a meeting that no longer records");
        meetings.warning("m-000000000001", Warning::NoPcSound, true);
        meetings.warning("m-000000000001", Warning::PcLost, true);
        meetings.warning("m-000000000001", Warning::PcLost, true);
        meetings.warning("m-000000000001", Warning::NoPcSound, false);
        meetings.set_paused("m-000000000001", true);
        meetings.set_paused("m-000000000001", true);
        let r = meetings.status().recording.unwrap();
        assert_eq!((r.warnings, r.paused), (vec![Warning::PcLost], true));
        assert_eq!(sent(), 4, "only changes are sent");
    }

    #[test]
    fn a_stop_for_another_meeting_stops_nothing() {
        assert!(stops(Some("m-000000000001"), None));
        assert!(stops(Some("m-000000000001"), Some("m-000000000001")));
        assert!(!stops(Some("m-000000000001"), Some("m-000000000002")), "the 4-hour limit of a meeting already stopped");
        assert!(!stops(None, None));
        assert!(!stops(None, Some("m-000000000001")));
        let (_, meetings, _) = setup("stop_if");
        assert_eq!(meetings.stop_if(Some("m-000000000002")), Err("not_recording".into()));
    }

    #[test]
    fn a_free_gpu_press_during_the_end_steps_keeps_the_ai_off() {
        assert!(notes_allowed(false, false), "nothing freed");
        assert!(notes_allowed(true, true), "freed before Stop: Stop loads the models");
        assert!(notes_allowed(true, false), "loaded again meanwhile");
        assert!(!notes_allowed(false, true), "pressed during the end steps: it stays free");
    }

    #[test]
    fn a_press_between_stop_and_the_end_steps_counts_as_one_during_them() {
        let (none, both) = (Freed { ai: false, whisper: false }, Freed { ai: true, whisper: true });
        assert!(!pressed_since(none, none), "nothing freed");
        assert!(!pressed_since(both, both), "freed before Stop: Stop loads the models");
        assert!(!pressed_since(both, none), "loaded again meanwhile");
        assert!(pressed_since(none, both), "pressed while the devices closed");
        assert!(pressed_since(none, Freed { ai: true, whisper: false }));
        assert!(pressed_since(Freed { ai: true, whisper: false }, both), "Whisper freed since");

        // The end steps go by what Stop saw, not by what is true when they
        // start. Here both are freed by then, as the hotkey does it.
        let (app_dir, meetings, _) = setup("freed");
        meetings.llm.release();
        meetings.engine.release();
        assert_eq!(meetings.freed(), both);
        let end_steps = |id: &str, at_stop: Freed| {
            let meeting = Arc::new(Mutex::new(saved(&app_dir, id, State::Finishing)));
            meetings.open.lock().unwrap().insert(id.to_string(), meeting.clone());
            let mut config = config(&app_dir);
            // What only the AI's own step says: the notes were let through.
            config.ai_model = Err("no_ai_model".into());
            let whisper = config.whisper(&meetings.engine, "en");
            let source = Tracks::saved(store::root(&app_dir).join(id));
            meetings.end_steps_guarded(meeting.clone(), Worker::new(0, 0, &[]), whisper, source, config, at_stop);
            let m = meeting.lock().unwrap();
            (m.state, m.notes_error.clone())
        };
        assert_eq!(end_steps("m-000000000001", both), (State::Finished, Some("no_ai_model".into())), "freed before Stop: the notes are written");
        assert_eq!(end_steps("m-000000000002", none), (State::Finished, Some("gpu_freed".into())), "pressed after Stop: the AI stays off");
        assert!(meetings.llm.released() && meetings.engine.released(), "nothing was loaded");
        assert!(meetings.open.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_during_a_game_leaves_the_ai_off_and_the_notes_for_later() {
        let (app_dir, meetings, _) = setup("game");
        // Free GPU for games freed both, as the hotkey would.
        meetings.llm.release();
        meetings.engine.release();
        meetings.set_freed_for_game(true);
        let both = Freed { ai: true, whisper: true };
        let end_steps = |id: &str| {
            let meeting = Arc::new(Mutex::new(saved(&app_dir, id, State::Finishing)));
            meetings.open.lock().unwrap().insert(id.to_string(), meeting.clone());
            let mut config = config(&app_dir);
            // The AI's own step would say this: the notes were let through.
            config.ai_model = Err("no_ai_model".into());
            let whisper = config.whisper(&meetings.engine, "en");
            let source = Tracks::saved(store::root(&app_dir).join(id));
            meetings.end_steps_guarded(meeting.clone(), Worker::new(0, 0, &[]), whisper, source, config, both);
            let m = meeting.lock().unwrap();
            (m.state, m.notes_error.clone(), m.speakers_error.clone())
        };
        // Not "freed by the user before Stop" (that would start the AI for
        // the notes): finished, the speakers step ran, the notes wait.
        assert_eq!(
            end_steps("m-000000000001"),
            (State::Finished, Some(NOTES_GAME.to_string()), Some("no_model".to_string()))
        );
        assert!(meetings.llm.released(), "the AI was not started");
        assert!(meetings.engine.released(), "Whisper stays unloaded after the rest");
        // The game is over before Stop: the notes go through as before.
        meetings.set_freed_for_game(false);
        assert_eq!(end_steps("m-000000000002").1, Some("no_ai_model".to_string()));
    }

    #[test]
    fn with_nothing_left_to_transcribe_the_live_run_lets_go_at_once() {
        /// Counts its releases.
        struct Held(usize);
        impl Transcriber for Held {
            fn ready(&mut self) -> bool {
                true
            }
            fn transcribe(&mut self, _: &[f32], _: u64, _: &[crate::whisper_engine::Segment]) -> Result<Vec<crate::whisper_engine::Segment>, String> {
                Ok(Vec::new())
            }
            fn language(&self) -> String {
                "en".into()
            }
            fn release(&mut self) {
                self.0 += 1;
            }
        }
        let mut held = Held(0);
        assert!(for_the_rest(&mut held, true).is_some());
        assert_eq!(held.0, 0, "it transcribes the rest and lets go after that (`finish::run`)");
        assert!(for_the_rest(&mut held, false).is_none());
        assert_eq!(held.0, 1, "both tracks caught up at Stop: before the speakers and the notes");
    }

    #[test]
    fn old_audio_is_looked_for_once_a_day_by_the_clock() {
        let (hour, day) = (3_600_000, 24 * 3_600_000);
        assert!(cleanup_due(None, 5 * day), "a minute after the start");
        assert!(!cleanup_due(Some(5 * day), 5 * day + hour));
        assert!(!cleanup_due(Some(5 * day), 6 * day - 1));
        assert!(cleanup_due(Some(5 * day), 6 * day), "a day later, slept through or not");
        assert!(cleanup_due(Some(5 * day), 9 * day));
        assert!(cleanup_due(Some(5 * day), 4 * day), "the clock was set back");
    }

    #[test]
    fn notes_written_meanwhile_keep_the_edits() {
        let (app_dir, meetings, _) = setup("put_notes");
        let root = store::root(&app_dir);
        saved(&app_dir, "m-000000000001", State::Finished);
        // While the AI writes: an edit, and the 30-day cleanup.
        meetings.rename_speaker("m-000000000001", 0, "Anna").unwrap();
        meetings.set_action_done("m-000000000001", 0, true).unwrap();
        let mut m = store::load(&root, "m-000000000001").unwrap();
        m.audio_deleted = true;
        m.save(&root).unwrap();
        meetings.put_notes("m-000000000001", Err("gpu_freed".into())).unwrap();
        let m = meetings.get("m-000000000001").unwrap().meeting;
        assert_eq!(m.notes_error.as_deref(), Some("gpu_freed"));
        assert!(m.notes.as_ref().unwrap().action_items[0].done, "earlier notes stay, ticked");
        let new = Notes { summary: "New.".into(), decisions: vec!["Ship".into()], action_items: vec![] };
        meetings.put_notes("m-000000000001", Ok(new.clone())).unwrap();
        let m = meetings.get("m-000000000001").unwrap().meeting;
        assert_eq!((m.notes, m.notes_error), (Some(new), None));
        assert_eq!(m.speaker_names, ["Anna"]);
        assert!(m.audio_deleted);
        assert_eq!(meetings.put_notes("m-0000000000ff", Err("empty".into())), Err("no_meeting".into()));
    }

    #[test]
    fn the_cleanup_leaves_open_meetings_alone() {
        let (app_dir, meetings, _) = setup("cleanup");
        let root = store::root(&app_dir);
        // Both ended in 1970.
        let old = saved(&app_dir, "m-000000000001", State::Finished);
        let open = saved(&app_dir, "m-000000000002", State::Finished);
        for m in [&old, &open] {
            std::fs::write(m.dir(&root).join(YOU_WAV), b"x").unwrap();
        }
        meetings.open.lock().unwrap().insert(open.id.clone(), Arc::new(Mutex::new(open.clone())));
        meetings.delete_old_audio();
        assert!(store::load(&root, &old.id).unwrap().audio_deleted);
        assert!(!old.dir(&root).join(YOU_WAV).exists());
        assert!(!store::load(&root, &open.id).unwrap().audio_deleted, "in memory: not touched");
        assert!(open.dir(&root).join(YOU_WAV).exists());
    }

    #[test]
    fn only_changed_paragraphs_are_sent() {
        let (_, meetings, events) = setup("lines");
        let mut m = Meeting::new("m-000000000001", "Call", 0, 0, "small", "en");
        m.lines.push(Line { start_ms: 0, end_ms: 1_000, track: Track::You, speaker: None, text: "One.".into() });
        meetings.emit_lines(&m);
        meetings.emit_lines(&m);
        m.lines.push(Line { start_ms: 5_000, end_ms: 6_000, track: Track::Others, speaker: None, text: "Two.".into() });
        meetings.emit_lines(&m);
        let sent: Vec<(usize, usize)> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| if let Event::Lines(l) = e { Some((l.from, l.paragraphs.len())) } else { None })
            .collect();
        assert_eq!(sent, [(0, 1), (1, 1)], "nothing new, nothing sent");
    }

    #[test]
    fn the_drive_has_free_space() {
        let free = free_bytes(&std::env::temp_dir());
        #[cfg(windows)]
        assert!(free.is_some_and(|b| b > 0), "{:?}", free);
        let _ = free;
    }
}
