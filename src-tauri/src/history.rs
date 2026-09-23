//! Local transcript history: `history/history.json` plus one 16 kHz WAV per
//! entry when audio is kept. Nothing leaves the machine.
//!
//! The last transcript is also kept in memory for the "paste last transcript"
//! hotkey, so that works even with history turned off.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::audio::{lock, samples_to_wav};

/// Text entries kept on disk.
const MAX_ENTRIES: usize = 200;
/// Entries that keep their recording. Older recordings are deleted, the text stays.
const MAX_AUDIO: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryEntry {
    /// Unix time in milliseconds; unique within the history.
    pub id: u64,
    pub text: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    /// Whisper model name, or "groq" for the cloud engine.
    pub model: String,
    #[serde(rename = "hasAudio")]
    pub has_audio: bool,
}

pub struct History {
    dir: PathBuf,
    /// Oldest first.
    entries: Mutex<Vec<HistoryEntry>>,
    last_text: Mutex<Option<String>>,
}

impl History {
    pub fn load(app_dir: &Path) -> Self {
        let dir = app_dir.join("history");
        let entries: Vec<HistoryEntry> = fs::read_to_string(dir.join("history.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let last_text = entries.last().map(|e| e.text.clone());
        Self {
            dir,
            entries: Mutex::new(entries),
            last_text: Mutex::new(last_text),
        }
    }

    pub fn last_text(&self) -> Option<String> {
        lock(&self.last_text).clone()
    }

    /// Record a finished dictation. `mode` is the history setting: "off"
    /// keeps only the in-memory last transcript, "text" stores the text,
    /// "audio" stores the text and the recording.
    pub fn record(&self, text: &str, samples: &[f32], model: &str, mode: &str) -> Option<HistoryEntry> {
        *lock(&self.last_text) = Some(text.to_string());
        if mode == "off" {
            return None;
        }

        let mut entries = lock(&self.entries);
        let mut id = now_ms();
        if let Some(prev) = entries.last() {
            id = id.max(prev.id + 1);
        }
        let mut entry = HistoryEntry {
            id,
            text: text.to_string(),
            duration_ms: samples.len() as u64 * 1000 / 16_000,
            model: model.to_string(),
            has_audio: false,
        };
        if mode == "audio" && fs::create_dir_all(&self.dir).is_ok() {
            entry.has_audio = samples_to_wav(samples, &self.audio_path(id)).is_ok();
        }
        entries.push(entry.clone());
        self.prune(&mut entries);
        self.save(&entries);
        Some(entry)
    }

    /// Newest first.
    pub fn list(&self) -> Vec<HistoryEntry> {
        lock(&self.entries).iter().rev().cloned().collect()
    }

    pub fn get(&self, id: u64) -> Option<HistoryEntry> {
        lock(&self.entries).iter().find(|e| e.id == id).cloned()
    }

    /// Replace an entry's text after a re-run with another model. Re-running
    /// the newest entry also updates what "paste last transcript" pastes.
    pub fn update_text(&self, id: u64, text: &str, model: &str) -> Option<HistoryEntry> {
        let mut entries = lock(&self.entries);
        let is_newest = entries.last().is_some_and(|e| e.id == id);
        let entry = entries.iter_mut().find(|e| e.id == id)?;
        entry.text = text.to_string();
        entry.model = model.to_string();
        let updated = entry.clone();
        self.save(&entries);
        if is_newest {
            *lock(&self.last_text) = Some(text.to_string());
        }
        Some(updated)
    }

    pub fn delete(&self, id: u64) {
        let mut entries = lock(&self.entries);
        entries.retain(|e| e.id != id);
        let _ = fs::remove_file(self.audio_path(id));
        self.save(&entries);
    }

    pub fn clear(&self) {
        lock(&self.entries).clear();
        *lock(&self.last_text) = None;
        let _ = fs::remove_dir_all(&self.dir);
    }

    pub fn audio_path(&self, id: u64) -> PathBuf {
        self.dir.join(format!("{}.wav", id))
    }

    fn prune(&self, entries: &mut Vec<HistoryEntry>) {
        if entries.len() > MAX_ENTRIES {
            let excess = entries.len() - MAX_ENTRIES;
            for e in entries.drain(..excess) {
                let _ = fs::remove_file(self.audio_path(e.id));
            }
        }
        let with_audio = entries.iter().filter(|e| e.has_audio).count();
        let mut to_drop = with_audio.saturating_sub(MAX_AUDIO);
        for e in entries.iter_mut() {
            if to_drop == 0 {
                break;
            }
            if e.has_audio {
                let _ = fs::remove_file(self.audio_path(e.id));
                e.has_audio = false;
                to_drop -= 1;
            }
        }
    }

    fn save(&self, entries: &[HistoryEntry]) {
        if fs::create_dir_all(&self.dir).is_err() {
            return;
        }
        if let Ok(json) = serde_json::to_string_pretty(entries) {
            let _ = fs::write(self.dir.join("history.json"), json);
        }
    }
}

/// Read a history recording back as 16 kHz mono samples.
pub fn read_wav(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    reader
        .samples::<i16>()
        .map(|s| s.map(|v| v as f32 / i16::MAX as f32).map_err(|e| e.to_string()))
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_app_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rudariflow_history_{}", name));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn records_text_and_audio_and_reloads() {
        let dir = temp_app_dir("roundtrip");
        let h = History::load(&dir);
        let samples = vec![0.25_f32; 16_000];
        let e = h.record("Hello.", &samples, "small", "audio").unwrap();
        assert_eq!(e.duration_ms, 1000);
        assert!(e.has_audio);
        assert!(h.audio_path(e.id).exists());

        let reloaded = History::load(&dir);
        assert_eq!(reloaded.list(), vec![e.clone()]);
        assert_eq!(reloaded.last_text().as_deref(), Some("Hello."));

        let back = read_wav(&h.audio_path(e.id)).unwrap();
        assert_eq!(back.len(), samples.len());
        assert!((back[0] - 0.25).abs() < 0.001);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn off_keeps_only_last_text() {
        let dir = temp_app_dir("off");
        let h = History::load(&dir);
        assert!(h.record("Secret.", &[0.0; 1600], "small", "off").is_none());
        assert_eq!(h.last_text().as_deref(), Some("Secret."));
        assert!(h.list().is_empty());
        assert!(!dir.join("history").exists());
    }

    #[test]
    fn text_mode_stores_no_audio() {
        let dir = temp_app_dir("text");
        let h = History::load(&dir);
        let e = h.record("Hi.", &[0.0; 1600], "groq", "text").unwrap();
        assert!(!e.has_audio);
        assert!(!h.audio_path(e.id).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ids_are_unique_and_list_is_newest_first() {
        let dir = temp_app_dir("ids");
        let h = History::load(&dir);
        let a = h.record("a", &[], "small", "text").unwrap();
        let b = h.record("b", &[], "small", "text").unwrap();
        assert!(b.id > a.id);
        assert_eq!(h.list().iter().map(|e| e.text.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prunes_old_entries_and_old_audio() {
        let dir = temp_app_dir("prune");
        let h = History::load(&dir);
        for i in 0..(MAX_ENTRIES + 5) {
            h.record(&format!("t{}", i), &[0.0; 160], "small", "audio");
        }
        let list = h.list();
        assert_eq!(list.len(), MAX_ENTRIES);
        assert_eq!(list.last().unwrap().text, "t5");
        assert_eq!(list.iter().filter(|e| e.has_audio).count(), MAX_AUDIO);
        assert!(list[..MAX_AUDIO].iter().all(|e| e.has_audio));
        let wavs = fs::read_dir(dir.join("history"))
            .unwrap()
            .filter(|f| f.as_ref().unwrap().path().extension().is_some_and(|x| x == "wav"))
            .count();
        assert_eq!(wavs, MAX_AUDIO);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_delete_and_clear() {
        let dir = temp_app_dir("edit");
        let h = History::load(&dir);
        let e = h.record("old", &[0.0; 160], "small", "audio").unwrap();
        let updated = h.update_text(e.id, "new", "large-v3-turbo").unwrap();
        assert_eq!((updated.text.as_str(), updated.model.as_str()), ("new", "large-v3-turbo"));
        assert_eq!(History::load(&dir).get(e.id).unwrap().text, "new");
        assert_eq!(h.last_text().as_deref(), Some("new"));

        h.delete(e.id);
        assert!(h.get(e.id).is_none());
        assert!(!h.audio_path(e.id).exists());

        h.record("x", &[], "small", "text");
        h.clear();
        assert!(h.list().is_empty());
        assert!(h.last_text().is_none());
        assert!(!dir.join("history").exists());
    }
}
