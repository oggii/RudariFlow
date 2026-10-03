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
