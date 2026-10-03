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
/// far its track is done, the language once Whisper detected it, and the
/// Whisper model when another one was loaded meanwhile (the settings
/// changed during the meeting): `whisper_model` then names each model its
/// lines came from ("small, large-v3-turbo").
pub fn apply_piece(meeting: &mut Meeting, piece: Piece) {
    lines::add_lines(&mut meeting.lines, piece.lines);
    match piece.track {
        Track::You => meeting.you_done_ms = piece.done_ms,
        Track::Others => meeting.others_done_ms = piece.done_ms,
    }
    if (meeting.language.is_empty() || meeting.language == "auto") && piece.language != "auto" {
        meeting.language = piece.language;
    }
    if !piece.model.is_empty() && !meeting.whisper_model.split(", ").any(|m| m == piece.model) {
        meeting.whisper_model = if meeting.whisper_model.is_empty() {
            piece.model
        } else {
            format!("{}, {}", meeting.whisper_model, piece.model)
        };
    }
}

/// Run the end steps on `meeting` and save it (`root` is
/// `<app data>\meetings`). `whisper` is `None` when Whisper could not load
/// (or is not needed: the audio is gone, or all of it is transcribed).
/// `speakers` separates the Others track (an error such as "no_model" is
/// kept as the reason), `notes` writes the notes from the transcript and
/// the language code. `whisper` lets go of its run right after the
/// transcription (`Transcriber::release`), before the speakers and the
/// notes. Unloaded models while the rest is transcribed (the Free GPU
/// hotkey), or no Whisper for audio not transcribed yet, leave the meeting
/// interrupted, for Finish later, rather than finished with a part missing.
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
    let complete = match whisper {
        Some(whisper) => {
            let complete = !audio || transcribe_rest(&id, root, meeting, &mut worker, whisper, source, on_lines);
            // Its memory goes now, not after the speakers and the notes.
            whisper.release();
            complete
        }
        None if audio && left(source, &worker) => {
            startup_log::log(&format!("[meeting] {}: no Whisper for the rest; Finish goes on later", id));
            false
        }
        None => true,
    };
    if !complete {
        interrupt(root, meeting);
        return;
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

/// Transcribe what is left of both tracks. False when Whisper was unloaded
/// meanwhile (the Free GPU hotkey) or found no GPU memory: Finish later.
fn transcribe_rest(
    id: &str,
    root: &Path,
    meeting: &Mutex<Meeting>,
    worker: &mut Worker,
    whisper: &mut dyn Transcriber,
    source: &dyn Source,
    on_lines: &mut dyn FnMut(&Meeting),
) -> bool {
    loop {
        match worker.step(source, whisper, true) {
            Ok(Some(piece)) => {
                let mut m = lock(meeting);
                apply_piece(&mut m, piece);
                save(root, &m);
                on_lines(&m);
            }
            Ok(None) => return true,
            Err(e) if e == PAUSED => {
                startup_log::log(&format!("[meeting] {}: Whisper was unloaded while finishing; Finish goes on later", id));
                return false;
            }
            Err(e) => startup_log::log(&format!("[meeting] {}: a piece was skipped: {}", id, e)),
        }
    }
}

/// Whether some audio of either track is not transcribed yet.
pub fn left(source: &dyn Source, worker: &Worker) -> bool {
    [Track::You, Track::Others].into_iter().any(|t| source.available(t) > worker.done(t))
}

fn interrupt(root: &Path, meeting: &Mutex<Meeting>) {
    let mut m = lock(meeting);
    m.state = State::Interrupted;
    save(root, &m);
}

fn save(root: &Path, meeting: &Meeting) {
    if let Err(e) = meeting.save(root) {
        startup_log::log(&format!("[meeting] {} not saved: {}", meeting.id, e));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::store::{self, ActionItem, Line, OTHERS_WAV, YOU_WAV};
    use crate::meeting::wav::TrackFile;
    use crate::meeting::worker::Tracks;
    use crate::whisper_engine::Segment;
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::rc::Rc;

    /// One segment per call, said by "you" or "others" by the audio level.
    /// `log` has its transcriptions and releases, in order.
    #[derive(Default)]
    struct Fake {
        unloaded: bool,
        log: Rc<RefCell<Vec<&'static str>>>,
    }

    impl Transcriber for Fake {
        fn ready(&mut self) -> bool {
            !self.unloaded
        }

        fn transcribe(&mut self, audio: &[f32], offset: u64, _: &[Segment]) -> Result<Vec<Segment>, String> {
            self.log.borrow_mut().push("transcribe");
            let who = if audio[0] > 0.35 { "Others talk" } else { "You talk" };
            let start_ms = offset / 16;
            Ok(vec![Segment { start_ms, end_ms: start_ms + audio.len() as u64 / 16, text: who.to_string(), speaker: None }])
        }

        fn language(&self) -> String {
            "en".to_string()
        }

        fn release(&mut self) {
            self.log.borrow_mut().push("release");
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
        let worker = {
            let m = meeting.lock().unwrap();
            Worker::new(m.you_done_ms, m.others_done_ms, &m.lines)
        };
        let mut whisper = Fake::default();
        let log = whisper.log.clone();
        let (speakers_log, notes_log) = (log.clone(), log.clone());
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
                speakers_log.borrow_mut().push("speakers");
                heard = audio.len();
                Ok(vec![Turn { start_ms: 0, end_ms: 20_000, speaker: 4 }])
            },
            |transcript, language| {
                notes_log.borrow_mut().push("notes");
                assert!(transcript.contains("Speaker 1: Others talk"), "{}", transcript);
                assert!(transcript.starts_with("[0:00] You: Live line."), "{}", transcript);
                assert_eq!(language, "en", "detected while finishing");
                Ok(Notes { summary: "A call.".into(), decisions: vec![], action_items: vec![ActionItem { text: "Write it".into(), done: false }] })
            },
            &mut |s| steps.push(s),
            &mut |_| redraws += 1,
        );
        assert_eq!(steps, [Step::Transcribing, Step::Speakers, Step::Notes]);
        assert_eq!(*log.borrow(), ["transcribe", "transcribe", "release", "speakers", "notes"], "the run let go before the speakers");
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
            Some(&mut Fake::default()),
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
        let mut whisper = Fake { unloaded: true, ..Default::default() };
        run(
            &root,
            &meeting,
            Worker::new(1_000, 0, &[]),
            Some(&mut whisper),
            &source,
            |_| panic!("no speakers before the transcript is done"),
            |_, _| panic!("no notes either"),
            &mut |s| steps.push(s),
            &mut |_| {},
        );
        assert_eq!(steps, [Step::Transcribing]);
        assert_eq!(*whisper.log.borrow(), ["release"], "let go of on the way out too");
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

    #[test]
    fn without_whisper_for_the_rest_it_stays_interrupted() {
        let (root, meeting) = recorded("no_whisper");
        let source = Tracks::saved(meeting.lock().unwrap().dir(&root));
        let mut steps = Vec::new();
        run(
            &root,
            &meeting,
            Worker::new(1_000, 0, &[]),
            None,
            &source,
            |_| panic!("not on half a transcript"),
            |_, _| panic!("no notes either"),
            &mut |s| steps.push(s),
            &mut |_| {},
        );
        assert_eq!(steps, [Step::Transcribing]);
        assert_eq!(store::load(&root, "m-00000000000a").unwrap().state, State::Interrupted, "Finish later");
        // All of it transcribed already: no Whisper needed.
        let (root, meeting) = recorded("all_done");
        let source = Tracks::saved(meeting.lock().unwrap().dir(&root));
        assert!(!left(&source, &Worker::new(20_000, 20_000, &[])));
        run(
            &root,
            &meeting,
            Worker::new(20_000, 20_000, &[]),
            None,
            &source,
            |_| Ok(vec![]),
            |_, _| Ok(Notes::default()),
            &mut |_| {},
            &mut |_| {},
        );
        let saved = store::load(&root, "m-00000000000a").unwrap();
        assert_eq!(saved.state, State::Finished);
        assert_eq!(saved.speakers_error, None, "no Others lines: nothing to tell apart");
    }

    #[test]
    fn a_piece_brings_its_language_and_a_swapped_model() {
        let mut m = Meeting::new("m-00000000000a", "Call", 0, 0, "small", "auto");
        let piece = |model: &str, language: &str| Piece {
            track: Track::You,
            lines: vec![Line { start_ms: 0, end_ms: 1_000, track: Track::You, speaker: None, text: "Hi.".into() }],
            done_ms: 1_000,
            language: language.into(),
            model: model.into(),
        };
        apply_piece(&mut m, piece("", "auto"));
        assert_eq!((m.language.as_str(), m.whisper_model.as_str()), ("auto", "small"), "nothing known yet");
        apply_piece(&mut m, piece("small", "de"));
        assert_eq!((m.language.as_str(), m.whisper_model.as_str()), ("de", "small"));
        apply_piece(&mut m, piece("large-v3-turbo", "en"));
        assert_eq!(m.language, "de", "detected once");
        assert_eq!(m.whisper_model, "small, large-v3-turbo", "the settings changed during the meeting");
        apply_piece(&mut m, piece("small", "de"));
        assert_eq!(m.whisper_model, "small, large-v3-turbo");
        assert_eq!(m.you_done_ms, 1_000);
    }
}
