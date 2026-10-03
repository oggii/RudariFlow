//! The live transcription of a meeting: each track is cut into pieces of
//! 15–30 s that end in a pause (`lines::next_piece`), and the pieces go to
//! Whisper one by one, the track that is further behind first. While the
//! models are unloaded (Free GPU, battery) it waits, and catches up once
//! something loads them again.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::capture::Written;
use super::lines::{next_piece, PIECE_MAX_SECS, PIECE_MIN_SECS};
use super::store::{Line, Track};
use super::wav::{self, RATE};
use crate::file_transcribe;
use crate::startup_log;
use crate::whisper_engine::{FileRun, Segment, WhisperEngine, NO_MODEL};

/// Not transcribing now: no model is loaded, or Whisper found no GPU memory
/// for the meeting's run. Nothing was taken; the worker catches up later.
pub const PAUSED: &str = "paused";
/// The end of a track's text that goes into the next prompt.
const TAIL: usize = 20;
/// A stretch of a meeting's track with less sound than this in it (a lone
/// click, 20–50 ms) does not go to Whisper, which makes "Vielen Dank." of
/// it. A short answer on its own ("Ja.", "OK") has more. The Files tab
/// keeps every stretch.
const MIN_SPEECH_MS: u64 = 200;
/// After the meeting's run could not be made (the GPU's memory is full: a
/// game, say), Whisper is tried again this much later.
const RUN_RETRY: Duration = Duration::from_secs(5);

/// A meeting's audio as the worker reads it.
pub trait Source {
    /// Samples of `track` there so far.
    fn available(&self, track: Track) -> u64;
    fn read(&self, track: Track, from: u64, to: u64) -> Result<Vec<f32>, String>;
}

/// Whisper as the worker uses it.
pub trait Transcriber {
    /// Whether Whisper can run now. Asked at every step, even with no piece
    /// due: a run whose model was unloaded lets go of its memory here.
    fn ready(&mut self) -> bool;
    /// The segments of `audio`, which starts at sample `offset` of its
    /// track; `before` is the end of that track's text. `NO_MODEL` or
    /// `PAUSED`: Whisper can't run now (nothing was taken).
    fn transcribe(&mut self, audio: &[f32], offset: u64, before: &[Segment]) -> Result<Vec<Segment>, String>;
    /// The language code in use ("auto" until detected).
    fn language(&self) -> String;
    /// The Whisper model the last piece was transcribed with ("small",
    /// "large-v3-turbo"); "" when not known.
    fn model(&self) -> String {
        String::new()
    }
}

/// Whether a transcription error means "not now" rather than a bad piece.
fn paused(error: &str) -> bool {
    error == NO_MODEL || error == PAUSED
}

/// What one step transcribed.
#[derive(Debug, Clone, PartialEq)]
pub struct Piece {
    pub track: Track,
    pub lines: Vec<Line>,
    /// How far this track is transcribed now.
    pub done_ms: u64,
    pub language: String,
    /// The Whisper model it was transcribed with ("" when not known).
    pub model: String,
}

pub struct Worker {
    /// Samples transcribed, per track.
    done: [u64; 2],
    tail: [Vec<Segment>; 2],
    /// Where a track did not read while recording: tried once more.
    unread: [Option<u64>; 2],
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
        Worker {
            done: [you_done_ms * per_ms, others_done_ms * per_ms],
            tail: [tail(Track::You), tail(Track::Others)],
            unread: [None; 2],
        }
    }

    pub fn done(&self, track: Track) -> u64 {
        self.done[track.index()]
    }

    /// Transcribe the next piece if one is ready; `last` (the recording
    /// ended) takes what is left. `Ok(None)`: nothing to do now.
    /// `Err(PAUSED)`: Whisper can't run now; nothing was taken (or read).
    /// Any other error skips the piece (it is logged by the caller), so
    /// stepping until `Ok(None)` comes to an end. A piece Whisper fails on
    /// is tried once more first (from a fresh state), and a track that
    /// does not read while recording once more at the next step.
    pub fn step(&mut self, source: &dyn Source, whisper: &mut dyn Transcriber, last: bool) -> Result<Option<Piece>, String> {
        // Every step: a run whose model was freed lets go of it at once.
        let ready = whisper.ready();
        let min = (PIECE_MIN_SECS * RATE as f32) as u64;
        let max = (PIECE_MAX_SECS * RATE as f32) as u64;
        let mut tracks = [Track::You, Track::Others];
        tracks.sort_by_key(|t| self.done[t.index()]);
        for track in tracks {
            let i = track.index();
            let from = self.done[i];
            let available = source.available(track);
            // Under 15 s is no piece yet (`next_piece`): not read for nothing.
            if available <= from || (!last && available - from < min) {
                continue;
            }
            if !ready {
                return Err(PAUSED.to_string());
            }
            let to = available.min(from + max);
            let pending = match source.read(track, from, to) {
                Ok(pending) => {
                    self.unread[i] = None;
                    pending
                }
                Err(e) if !last && self.unread[i] != Some(from) => {
                    startup_log::log(&format!("[meeting] the {:?} track did not read, once more next time: {}", track, e));
                    self.unread[i] = Some(from);
                    continue;
                }
                Err(e) => {
                    // Left out, not tried forever.
                    self.unread[i] = None;
                    self.done[i] = to;
                    return Err(e);
                }
            };
            let Some(len) = next_piece(&pending, last && to == available) else {
                continue;
            };
            let audio = &pending[..len];
            let mut result = whisper.transcribe(audio, from, &self.tail[i]);
            if result.as_ref().is_err_and(|e| !paused(e)) {
                // Once more: a passing failure loses nothing.
                result = whisper.transcribe(audio, from, &self.tail[i]);
            }
            let segments = match result {
                Ok(segments) => segments,
                Err(e) if paused(&e) => return Err(PAUSED.to_string()),
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
            return Ok(Some(Piece {
                track,
                lines,
                done_ms: self.done[i] / (RATE as u64 / 1000),
                language: whisper.language(),
                model: whisper.model(),
            }));
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

/// The user's Whisper model, language and dictionary, with one run of its
/// own at meeting priority for both tracks (`WhisperEngine::start_meeting`).
pub struct Whisper {
    engine: Arc<WhisperEngine>,
    run: Option<FileRun>,
    language: String,
    dictionary: String,
    spelling: Box<dyn Fn(&str) -> String + Send>,
    /// The run could not be made: not tried again before then.
    no_run_until: Option<Instant>,
    /// The model of the last piece (`model_name`).
    model: String,
}

/// "large-v3-turbo" of `…\ggml-large-v3-turbo.bin` (`model_filename`).
fn model_name(path: &Path) -> String {
    let file = path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
    file.strip_prefix("ggml-").and_then(|f| f.strip_suffix(".bin")).map_or(file.clone(), str::to_string)
}

impl Whisper {
    pub fn new(engine: Arc<WhisperEngine>, language: &str, dictionary: String, spelling: Box<dyn Fn(&str) -> String + Send>) -> Whisper {
        Whisper {
            engine,
            run: None,
            language: language.to_string(),
            dictionary,
            spelling,
            no_run_until: None,
            model: String::new(),
        }
    }

    /// A run with the loaded model. Without one (a state needs GPU memory
    /// the model does not hold yet): `PAUSED`, tried again in `RUN_RETRY`.
    fn start_run(&mut self) -> Result<FileRun, String> {
        match self.engine.start_meeting(&self.language) {
            Ok(run) => {
                self.no_run_until = None;
                Ok(run)
            }
            Err(e) if e == NO_MODEL => Err(e),
            Err(e) => {
                startup_log::log(&format!(
                    "[meeting] no Whisper run for the meeting ({}): paused, tried again in {} s",
                    e,
                    RUN_RETRY.as_secs()
                ));
                self.no_run_until = Some(Instant::now() + RUN_RETRY);
                Err(PAUSED.to_string())
            }
        }
    }
}

impl Transcriber for Whisper {
    fn ready(&mut self) -> bool {
        let (loaded, current) = self.engine.loaded_for(self.run.as_ref());
        // Free GPU, battery or another model: the run would keep the old
        // model in memory.
        if self.run.is_some() && !current {
            self.run = None;
            startup_log::log(if loaded {
                "[meeting] another Whisper model was loaded: the meeting goes on with it"
            } else {
                "[meeting] Whisper unloaded: transcription paused"
            });
        }
        loaded && self.no_run_until.is_none_or(|at| Instant::now() >= at)
    }

    fn transcribe(&mut self, audio: &[f32], offset: u64, before: &[Segment]) -> Result<Vec<Segment>, String> {
        let spans = file_transcribe::stretches(audio, MIN_SPEECH_MS);
        if spans.is_empty() {
            return Ok(Vec::new());
        }
        // A second time only when another model was loaded meanwhile.
        for _ in 0..2 {
            if self.run.is_none() {
                self.run = Some(self.start_run()?);
            }
            let run = self.run.as_mut().expect("started above");
            let found = file_transcribe::transcribe_stretch(
                &self.engine,
                run,
                audio,
                &spans,
                offset as usize,
                &self.dictionary,
                before,
                &*self.spelling,
            );
            self.language = run.language.clone();
            match found {
                Ok(segments) => {
                    self.model = model_name(run.model_path());
                    return Ok(segments);
                }
                // The run's model is gone (`file_block`), and so is the run.
                Err(e) if e == NO_MODEL => {
                    self.run = None;
                    if !self.engine.is_loaded() {
                        return Err(e);
                    }
                }
                Err(e) => {
                    // The next try starts from a fresh state, as a
                    // dictation does after a failure.
                    self.run = None;
                    startup_log::log(&format!("[meeting] Whisper failed on a piece: {}", e));
                    return Err(e);
                }
            }
        }
        Err(NO_MODEL.to_string())
    }

    fn language(&self) -> String {
        self.language.clone()
    }

    fn model(&self) -> String {
        self.model.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// Two tracks in memory, as far as `available` says.
    struct Fake {
        audio: [Vec<f32>; 2],
        available: [Cell<u64>; 2],
        /// Reading fails (a damaged or vanished file).
        broken: Cell<bool>,
        reads: Cell<usize>,
    }

    impl Fake {
        fn new(you: Vec<f32>, others: Vec<f32>) -> Fake {
            Fake { audio: [you, others], available: [Cell::new(0), Cell::new(0)], broken: Cell::new(false), reads: Cell::new(0) }
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
            self.reads.set(self.reads.get() + 1);
            if self.broken.get() {
                return Err("you.wav: access denied".to_string());
            }
            Ok(self.audio[track.index()][from as usize..to as usize].to_vec())
        }
    }

    /// One segment per piece, named by its offset; remembers the prompts.
    #[derive(Default)]
    struct Whisperer {
        unloaded: bool,
        fail: bool,
        /// Calls that fail before it works.
        hiccups: usize,
        /// Unloaded between `ready` and the run (Free GPU pressed then).
        released_meanwhile: bool,
        /// No GPU memory for a run.
        no_memory: bool,
        /// Holds a run, as `Whisper` does, until it is unloaded.
        held: bool,
        calls: Vec<(u64, usize, Vec<String>)>,
    }

    impl Transcriber for Whisperer {
        fn ready(&mut self) -> bool {
            if self.unloaded {
                self.held = false;
            }
            !self.unloaded
        }

        fn transcribe(&mut self, audio: &[f32], offset: u64, before: &[Segment]) -> Result<Vec<Segment>, String> {
            self.calls.push((offset, audio.len(), before.iter().map(|s| s.text.clone()).collect()));
            if self.no_memory {
                return Err(PAUSED.to_string());
            }
            if self.fail {
                return Err("whisper full() failed".to_string());
            }
            if self.hiccups > 0 {
                self.hiccups -= 1;
                return Err("whisper full() failed".to_string());
            }
            if self.released_meanwhile {
                return Err(NO_MODEL.to_string());
            }
            self.held = true;
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
        assert_eq!(source.reads.get(), 0, "nothing read");
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
        assert_eq!(whisper.calls.len(), 2, "tried once more");
        assert!(worker.done(Track::You) >= 15 * 16_000, "not tried forever");
    }

    #[test]
    fn a_piece_whisper_fails_on_once_loses_nothing() {
        let source = Fake::new(talk(40.0, &[]), Vec::new());
        let mut whisper = Whisperer { hiccups: 1, ..Default::default() };
        let mut worker = Worker::new(0, 0, &[]);
        source.up_to(40.0, 0.0);
        let piece = worker.step(&source, &mut whisper, false).unwrap().unwrap();
        assert_eq!(piece.lines[0].start_ms, 0);
        assert_eq!(whisper.calls.iter().map(|c| c.0).collect::<Vec<_>>(), [0, 0], "the same piece twice");
    }

    #[test]
    fn no_gpu_memory_for_a_run_pauses_like_no_model() {
        let source = Fake::new(talk(40.0, &[]), Vec::new());
        let mut whisper = Whisperer { no_memory: true, ..Default::default() };
        let mut worker = Worker::new(0, 0, &[]);
        source.up_to(40.0, 0.0);
        assert_eq!(worker.step(&source, &mut whisper, false), Err(PAUSED.to_string()));
        assert_eq!(worker.done(Track::You), 0, "nothing skipped");
        assert_eq!(whisper.calls.len(), 1, "no second try while paused");
        whisper.no_memory = false;
        assert_eq!(worker.step(&source, &mut whisper, false).unwrap().unwrap().lines[0].start_ms, 0);
    }

    #[test]
    fn a_freed_model_is_let_go_of_before_the_next_piece_is_due() {
        let source = Fake::new(talk(40.0, &[17.0]), Vec::new());
        let mut whisper = Whisperer::default();
        let mut worker = Worker::new(0, 0, &[]);
        source.up_to(25.0, 0.0);
        worker.step(&source, &mut whisper, false).unwrap().unwrap();
        assert!(whisper.held);
        // Free GPU, with under 15 s to transcribe.
        whisper.unloaded = true;
        source.up_to(26.0, 0.0);
        let reads = source.reads.get();
        assert_eq!(worker.step(&source, &mut whisper, false), Ok(None));
        assert!(!whisper.held, "the run let go of the model at once");
        source.up_to(40.0, 0.0);
        assert_eq!(worker.step(&source, &mut whisper, false), Err(PAUSED.to_string()));
        assert_eq!(source.reads.get(), reads, "nothing read while paused");
    }

    #[test]
    fn a_track_further_behind_without_a_piece_does_not_hold_up_the_other() {
        let source = Fake::new(talk(20.0, &[]), talk(60.0, &[]));
        let mut whisper = Whisperer::default();
        // Under 15 s, then 20 s without a pause: no piece of "You" yet.
        for you_secs in [10.0, 20.0] {
            let mut worker = Worker::new(0, 20_000, &[]);
            source.up_to(you_secs, 60.0);
            let piece = worker.step(&source, &mut whisper, false).unwrap().unwrap();
            assert_eq!(piece.track, Track::Others, "{} s", you_secs);
            assert_eq!(worker.done(Track::You), 0);
        }
        assert!(whisper.calls.iter().all(|c| c.0 == 20_000 * 16));
    }

    #[test]
    fn a_backlog_comes_in_pieces_that_join_up() {
        let source = Fake::new(talk(120.0, &[20.0, 45.0, 70.0, 95.0]), Vec::new());
        let mut whisper = Whisperer::default();
        let mut worker = Worker::new(0, 0, &[]);
        source.up_to(120.0, 0.0);
        let mut done = Vec::new();
        for last in [false, true] {
            while let Some(piece) = worker.step(&source, &mut whisper, last).unwrap() {
                done.push(piece.done_ms);
            }
        }
        assert!(whisper.calls.len() >= 5, "{:?}", done);
        let mut at = 0;
        for (offset, len, _) in &whisper.calls {
            assert_eq!(*offset, at, "each piece starts where the last one ended");
            assert!(*len <= 30 * 16_000);
            at = offset + *len as u64;
        }
        assert_eq!(at, 120 * 16_000);
        assert_eq!(done.last(), Some(&120_000));
    }

    #[test]
    fn a_track_that_does_not_read_while_recording_is_tried_once_more() {
        let source = Fake::new(talk(60.0, &[]), Vec::new());
        let mut whisper = Whisperer::default();
        let mut worker = Worker::new(0, 0, &[]);
        source.up_to(40.0, 0.0);
        source.broken.set(true);
        assert_eq!(worker.step(&source, &mut whisper, false), Ok(None), "once more next time");
        assert_eq!(worker.done(Track::You), 0);
        source.broken.set(false);
        assert_eq!(worker.step(&source, &mut whisper, false).unwrap().unwrap().lines[0].start_ms, 0, "nothing lost");
        // Twice at the same place: left out.
        source.up_to(60.0, 0.0);
        source.broken.set(true);
        let at = worker.done(Track::You);
        assert_eq!(worker.step(&source, &mut whisper, false), Ok(None));
        assert_eq!(worker.step(&source, &mut whisper, false), Err("you.wav: access denied".to_string()));
        assert_eq!(worker.done(Track::You), at + 30 * 16_000, "not tried forever");
    }

    #[test]
    fn a_lone_click_never_reaches_whisper() {
        // No model loaded: anything that goes to Whisper fails with NO_MODEL.
        let mut whisper = Whisper::new(Arc::new(WhisperEngine::new()), "auto", String::new(), Box::new(|s: &str| s.to_string()));
        // `ms` of sound at 5 s in 20 s of silence.
        let alone = |ms: usize| {
            let mut audio = vec![0.0; 20 * 16_000];
            audio[5 * 16_000..5 * 16_000 + ms * 16].iter_mut().for_each(|s| *s = 0.5);
            audio
        };
        for click_ms in [20, 50] {
            assert_eq!(whisper.transcribe(&alone(click_ms), 0, &[]), Ok(Vec::new()), "{} ms: no Whisper, no run", click_ms);
        }
        assert_eq!(whisper.transcribe(&alone(250), 0, &[]).err().as_deref(), Some(NO_MODEL), "a short \"Ja.\" goes to Whisper");
        assert_eq!(whisper.transcribe(&talk(20.0, &[]), 0, &[]).err().as_deref(), Some(NO_MODEL), "speech goes to Whisper");
        assert!(!whisper.ready());
    }

    #[test]
    fn a_release_while_a_piece_runs_pauses_and_keeps_the_piece() {
        let source = Fake::new(talk(40.0, &[]), Vec::new());
        let mut whisper = Whisperer { released_meanwhile: true, ..Default::default() };
        let mut worker = Worker::new(0, 0, &[]);
        source.up_to(40.0, 0.0);
        assert_eq!(worker.step(&source, &mut whisper, false), Err(PAUSED.to_string()));
        assert_eq!(worker.done(Track::You), 0, "the piece is done once Whisper is back");
        whisper.released_meanwhile = false;
        let piece = worker.step(&source, &mut whisper, false).unwrap().unwrap();
        assert_eq!(piece.lines[0].start_ms, 0);
        assert!(whisper.calls.iter().all(|c| c.0 == 0), "the same piece again");
    }

    #[test]
    fn a_stretch_that_cannot_be_read_is_skipped_and_the_end_comes() {
        let source = Fake::new(talk(40.0, &[]), talk(10.0, &[]));
        let mut whisper = Whisperer::default();
        let mut worker = Worker::new(0, 0, &[]);
        source.up_to(40.0, 10.0);
        source.broken.set(true);
        let mut errors = 0;
        // As the end steps do: step until nothing is left.
        while worker.step(&source, &mut whisper, true).is_err() {
            errors += 1;
            assert!(errors <= 4, "not tried forever");
        }
        assert_eq!((worker.done(Track::You), worker.done(Track::Others)), (40 * 16_000, 10 * 16_000));
        assert!(whisper.calls.is_empty());
    }

    #[test]
    fn a_model_is_named_by_its_file() {
        assert_eq!(model_name(Path::new(r"C:\data\ggml-large-v3-turbo.bin")), "large-v3-turbo");
        assert_eq!(model_name(Path::new(r"C:\data\ggml-small.bin")), "small");
        assert_eq!(model_name(Path::new(r"C:\data\custom.gguf")), "custom.gguf");
        assert_eq!(Whisperer::default().model(), "", "not known");
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
