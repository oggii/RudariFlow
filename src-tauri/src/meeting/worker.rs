//! The live transcription of a meeting: each track is cut into pieces of
//! 15–30 s that end in a pause (`lines::next_piece`), and the pieces go to
//! Whisper one by one, the track that is further behind first. While the
//! models are unloaded (Free GPU, battery) it waits, and catches up once
//! something loads them again.

use std::path::PathBuf;
use std::sync::Arc;

use super::capture::Written;
use super::lines::{next_piece, PIECE_MAX_SECS, PIECE_MIN_SECS};
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
    /// track; `before` is the end of that track's text. `NO_MODEL` (or
    /// `PAUSED`): the model was unloaded meanwhile.
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
    /// the piece (it is logged by the caller), so stepping until `Ok(None)`
    /// comes to an end.
    pub fn step(&mut self, source: &dyn Source, whisper: &mut dyn Transcriber, last: bool) -> Result<Option<Piece>, String> {
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
            let to = available.min(from + max);
            let pending = match source.read(track, from, to) {
                Ok(pending) => pending,
                Err(e) => {
                    // A stretch that does not read is left out, not tried forever.
                    self.done[i] = to;
                    return Err(e);
                }
            };
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

/// The user's Whisper model, language and dictionary, with one run of its
/// own at meeting priority for both tracks (`WhisperEngine::start_meeting`).
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
        let loaded = self.engine.is_loaded();
        // Free GPU, battery or another model: the run would keep the old
        // model in memory.
        if self.run.as_ref().is_some_and(|run| !self.engine.is_current(run)) {
            self.run = None;
            startup_log::log(if loaded {
                "[meeting] another Whisper model was loaded: the meeting goes on with it"
            } else {
                "[meeting] Whisper unloaded: transcription paused"
            });
        }
        loaded
    }

    fn transcribe(&mut self, audio: &[f32], offset: u64, before: &[Segment]) -> Result<Vec<Segment>, String> {
        // A second time only when another model was loaded meanwhile.
        for _ in 0..2 {
            if self.run.is_none() {
                self.run = Some(self.engine.start_meeting(&self.language)?);
            }
            let run = self.run.as_mut().expect("started above");
            let found =
                file_transcribe::transcribe_stretch(&self.engine, run, audio, offset as usize, &self.dictionary, before, &*self.spelling);
            self.language = run.language.clone();
            match found {
                // The run's model is gone (`file_block`), and so is the run.
                Err(e) if e == NO_MODEL => {
                    self.run = None;
                    if !self.engine.is_loaded() {
                        return Err(e);
                    }
                }
                found => return found,
            }
        }
        Err(NO_MODEL.to_string())
    }

    fn language(&self) -> String {
        self.language.clone()
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
    }

    impl Fake {
        fn new(you: Vec<f32>, others: Vec<f32>) -> Fake {
            Fake { audio: [you, others], available: [Cell::new(0), Cell::new(0)], broken: Cell::new(false) }
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
        /// Unloaded between `ready` and the run (Free GPU pressed then).
        released_meanwhile: bool,
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
            if self.released_meanwhile {
                return Err(NO_MODEL.to_string());
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
