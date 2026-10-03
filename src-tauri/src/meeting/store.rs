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

    /// Callers serialise saves of the same meeting (one owner); the temp
    /// name is fixed.
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

/// Only ids `new_id` makes (lowercase hex) name a folder: a command's id
/// never reaches outside `meetings\`.
pub fn valid_id(id: &str) -> bool {
    id.len() == 14 && id.starts_with("m-") && id[2..].bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn load(root: &Path, id: &str) -> Result<Meeting, String> {
    if !valid_id(id) {
        return Err("no_meeting".to_string());
    }
    let text = std::fs::read_to_string(root.join(id).join(FILE)).map_err(|_| "no_meeting".to_string())?;
    let mut m: Meeting = serde_json::from_str(&text).map_err(|e| format!("{} is damaged: {}", FILE, e))?;
    // The folder names the meeting: a copied or edited file cannot make
    // save, cleanup or recovery act on another folder.
    m.id = id.to_string();
    Ok(m)
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

/// Remove an audio file; a file that is already gone counts as removed.
/// Anything else (a lock, no permission) is logged and returns false.
fn remove_audio(path: &Path) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => {
            startup_log::log(&format!("[meeting] {} not deleted: {}", path.display(), e));
            false
        }
    }
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
        let mut all_gone = true;
        for track in [Track::You, Track::Others] {
            if !remove_audio(&m.dir(root).join(track.wav())) {
                all_gone = false;
            }
        }
        if !all_gone {
            // Retried at the next run.
            continue;
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
/// audio, and it becomes interrupted. Returns the ids. Only at app start,
/// before any meeting records.
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
        for bad in ["", "m-", "m-0123456789AB", "m-0123456789aB", "m-0123456789aZ", "m-0123456789abc", "..\\x", "m-../../../../x", "s-0123456789ab"] {
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
        m.lines.push(line(2_000, Track::You, "Die Übergabe ist morgen."));
        assert!(matches(&m, "übergabe"));
        assert!(matches(&m, "ÜBERGABE"));
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
    fn a_file_already_gone_counts_as_deleted() {
        let root = temp("gone");
        let day = 24 * 3600 * 1000;
        let mut m = meeting("m-000000000001", 0);
        m.state = State::Finished;
        m.save(&root).unwrap();
        // No wav files at all: nothing to remove, so the flag is set.
        assert_eq!(delete_old_audio(&root, 40 * day), 1);
        assert!(load(&root, &m.id).unwrap().audio_deleted);
        assert!(remove_audio(&root.join("nope.wav")));
        // A directory cannot be removed as a file: not counted as deleted.
        std::fs::create_dir_all(root.join("dir.wav")).unwrap();
        assert!(!remove_audio(&root.join("dir.wav")));
    }

    #[test]
    fn the_folder_names_the_meeting_not_the_file() {
        let root = temp("folder_id");
        let a = meeting("m-00000000000a", 1_000);
        a.save(&root).unwrap();
        let mut forged = meeting("..\\x", 1_000);
        forged.title = "Forged".into();
        std::fs::create_dir_all(root.join("m-00000000000b")).unwrap();
        std::fs::write(root.join("m-00000000000b").join(FILE), serde_json::to_string(&forged).unwrap()).unwrap();
        assert_eq!(load(&root, "m-00000000000b").unwrap().id, "m-00000000000b");
        let mut copy = load(&root, "m-00000000000a").unwrap();
        copy.id = "m-00000000000b".into();
        std::fs::write(root.join("m-00000000000a").join(FILE), serde_json::to_string(&copy).unwrap()).unwrap();
        assert_eq!(load(&root, "m-00000000000a").unwrap().id, "m-00000000000a", "not another meeting's id");
        let ids: Vec<String> = list(&root).into_iter().map(|m| m.id).collect();
        assert!(ids.iter().all(|id| valid_id(id)), "{:?}", ids);
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
