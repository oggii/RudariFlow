//! The soundboard's library and settings in `soundboard.json` (sounds,
//! categories, volumes, devices, hotkeys, the pop-out window). Saved
//! through a temp file and a rename, so a crash never leaves half a file.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::startup_log;

pub const FILE: &str = "soundboard.json";

fn version() -> u32 {
    1
}

fn full() -> f32 {
    1.0
}

fn me_default() -> f32 {
    0.7
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    #[serde(default = "version")]
    pub version: u32,
    /// The Virtual microphone switch, remembered across restarts.
    #[serde(default)]
    pub enabled: bool,
    /// "Others hear": the sounds in the virtual cable.
    #[serde(default = "full")]
    pub others_volume: f32,
    /// "You hear": the sounds on the headphones.
    #[serde(default = "me_default")]
    pub me_volume: f32,
    /// "Play sounds over each other"; off, a new sound replaces the others.
    #[serde(default)]
    pub layer: bool,
    #[serde(default)]
    pub devices: Devices,
    /// Stops every sound; empty = off.
    #[serde(default)]
    pub stop_hotkey: String,
    #[serde(default)]
    pub window: WindowPrefs,
    #[serde(default)]
    pub categories: Vec<Category>,
    #[serde(default)]
    pub sounds: Vec<Sound>,
}

/// Device names; "" = automatic.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Devices {
    #[serde(default)]
    pub microphone: String,
    #[serde(default)]
    pub cable: String,
    #[serde(default)]
    pub headphones: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPrefs {
    #[serde(default)]
    pub popped_out: bool,
    #[serde(default)]
    pub always_on_top: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sound {
    pub id: String,
    pub name: String,
    /// The copied original, relative to the soundboard folder: "sounds/<id>.<ext>".
    pub file: String,
    /// A category id; "" = no category.
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub hotkey: String,
    #[serde(default = "full")]
    pub volume: f32,
    #[serde(default)]
    pub duration_ms: u64,
}

impl Default for Board {
    fn default() -> Self {
        Board {
            version: 1,
            enabled: false,
            others_volume: 1.0,
            me_volume: 0.7,
            layer: false,
            devices: Devices::default(),
            stop_hotkey: String::new(),
            window: WindowPrefs::default(),
            categories: Vec::new(),
            sounds: Vec::new(),
        }
    }
}

impl Board {
    /// The board in `dir`. Missing: an empty board. Damaged: an empty board,
    /// and the damaged file is kept as `soundboard.json.bad`.
    pub fn load(dir: &Path) -> Board {
        let path = dir.join(FILE);
        let Ok(text) = std::fs::read_to_string(&path) else {
            return Board::default();
        };
        match serde_json::from_str::<Board>(&text) {
            Ok(mut board) => {
                board.tidy();
                board
            }
            Err(e) => {
                startup_log::log(&format!("[soundboard] {} is damaged ({}); kept as {}.bad", FILE, e, FILE));
                let _ = std::fs::rename(&path, dir.join(format!("{}.bad", FILE)));
                Board::default()
            }
        }
    }

    /// Values a hand edit or an older version may leave out of range.
    fn tidy(&mut self) {
        self.version = 1;
        self.others_volume = self.others_volume.clamp(0.0, 1.0);
        self.me_volume = self.me_volume.clamp(0.0, 1.0);
        // No pop-out window exists when the app starts.
        self.window.popped_out = false;
        let categories: Vec<String> = self.categories.iter().map(|c| c.id.clone()).collect();
        for sound in &mut self.sounds {
            sound.volume = sound.volume.clamp(0.0, 1.0);
            if !sound.category.is_empty() && !categories.contains(&sound.category) {
                sound.category.clear();
            }
        }
    }

    /// Write `soundboard.json` in `dir` through a temp file.
    pub fn save(&self, dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!("{}.tmp", FILE));
        std::fs::write(&tmp, json)
            .and_then(|_| std::fs::rename(&tmp, dir.join(FILE)))
            .map_err(|e| e.to_string())
    }

    pub fn sound(&self, id: &str) -> Option<&Sound> {
        self.sounds.iter().find(|s| s.id == id)
    }

    fn sound_mut(&mut self, id: &str) -> Result<&mut Sound, String> {
        self.sounds.iter_mut().find(|s| s.id == id).ok_or_else(|| "no_sound".to_string())
    }

    pub fn add_sound(&mut self, sound: Sound) {
        self.sounds.push(sound);
    }

    pub fn remove_sound(&mut self, id: &str) -> Option<Sound> {
        let at = self.sounds.iter().position(|s| s.id == id)?;
        Some(self.sounds.remove(at))
    }

    /// Only the name changes, never the files.
    pub fn rename_sound(&mut self, id: &str, name: &str) -> Result<(), String> {
        let name = clean_name(name)?;
        self.sound_mut(id)?.name = name;
        Ok(())
    }

    /// `category` "" = no category.
    pub fn set_category(&mut self, id: &str, category: &str) -> Result<(), String> {
        if !category.is_empty() && !self.categories.iter().any(|c| c.id == category) {
            return Err("no_category".to_string());
        }
        self.sound_mut(id)?.category = category.to_string();
        Ok(())
    }

    pub fn set_sound_volume(&mut self, id: &str, volume: f32) -> Result<(), String> {
        self.sound_mut(id)?.volume = volume.clamp(0.0, 1.0);
        Ok(())
    }

    pub fn set_sound_hotkey(&mut self, id: &str, hotkey: &str) -> Result<(), String> {
        self.sound_mut(id)?.hotkey = hotkey.to_string();
        Ok(())
    }

    /// A new category; returns its id.
    pub fn add_category(&mut self, name: &str) -> Result<String, String> {
        let name = clean_name(name)?;
        self.check_free(&name, None)?;
        let id = new_id("c");
        self.categories.push(Category { id: id.clone(), name });
        Ok(id)
    }

    pub fn rename_category(&mut self, id: &str, name: &str) -> Result<(), String> {
        let name = clean_name(name)?;
        self.check_free(&name, Some(id))?;
        let category = self.categories.iter_mut().find(|c| c.id == id).ok_or("no_category")?;
        category.name = name;
        Ok(())
    }

    /// Its sounds move to "No category".
    pub fn remove_category(&mut self, id: &str) -> Result<(), String> {
        let at = self.categories.iter().position(|c| c.id == id).ok_or("no_category")?;
        self.categories.remove(at);
        for sound in &mut self.sounds {
            if sound.category == id {
                sound.category.clear();
            }
        }
        Ok(())
    }

    /// "exists" when another category has this name (any capitalisation).
    fn check_free(&self, name: &str, except: Option<&str>) -> Result<(), String> {
        let taken = self
            .categories
            .iter()
            .any(|c| Some(c.id.as_str()) != except && c.name.to_lowercase() == name.to_lowercase());
        if taken {
            Err("exists".to_string())
        } else {
            Ok(())
        }
    }
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        Err("empty_name".to_string())
    } else {
        Ok(name.to_string())
    }
}

/// A new id: `prefix` and 12 random hex digits ("s-3fa2c9d01b7e").
pub fn new_id(prefix: &str) -> String {
    let mut bytes = [0u8; 6];
    if getrandom::fill(&mut bytes).is_err() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        bytes.copy_from_slice(&nanos.to_le_bytes()[..6]);
    }
    format!("{}-{}", prefix, bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>())
}

/// A sound's name before it is renamed: the file name without extension.
pub fn default_name(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rudariflow_sb_library_{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn sound(id: &str, name: &str) -> Sound {
        Sound {
            id: id.into(),
            name: name.into(),
            file: format!("sounds/{}.mp3", id),
            category: String::new(),
            hotkey: String::new(),
            volume: 1.0,
            duration_ms: 1000,
        }
    }

    #[test]
    fn a_missing_file_is_an_empty_board_with_the_defaults() {
        let board = Board::load(&temp("missing"));
        assert_eq!(board, Board::default());
        assert_eq!(board.version, 1);
        assert!(!board.enabled && !board.layer);
        assert_eq!((board.others_volume, board.me_volume), (1.0, 0.7));
        assert_eq!(board.devices, Devices::default());
        assert!(board.stop_hotkey.is_empty() && board.sounds.is_empty() && board.categories.is_empty());
    }

    #[test]
    fn the_board_survives_a_save_and_a_load() {
        let dir = temp("roundtrip");
        let mut board = Board::default();
        board.enabled = true;
        board.layer = true;
        board.stop_hotkey = "F14".into();
        board.devices.cable = "Speakers (VB-Audio Virtual Cable)".into();
        board.window.always_on_top = true;
        let memes = board.add_category("Memes").unwrap();
        let mut s = sound("s-1", "airhorn");
        s.category = memes;
        s.hotkey = "Numpad1".into();
        s.volume = 0.5;
        board.add_sound(s);
        board.save(&dir).unwrap();
        assert!(!dir.join("soundboard.json.tmp").exists(), "written through a temp file");
        assert_eq!(Board::load(&dir), board);
        let json = std::fs::read_to_string(dir.join(FILE)).unwrap();
        for key in ["\"othersVolume\"", "\"meVolume\"", "\"stopHotkey\"", "\"poppedOut\"", "\"alwaysOnTop\"", "\"durationMs\""] {
            assert!(json.contains(key), "{} in {}", key, json);
        }
    }

    #[test]
    fn a_damaged_file_is_kept_aside_and_the_board_starts_empty() {
        let dir = temp("damaged");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), "{ not json").unwrap();
        assert_eq!(Board::load(&dir), Board::default());
        assert_eq!(std::fs::read_to_string(dir.join("soundboard.json.bad")).unwrap(), "{ not json");
        assert!(!dir.join(FILE).exists());
    }

    #[test]
    fn values_out_of_range_are_tidied_at_load() {
        let dir = temp("tidy");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(FILE),
            r#"{"othersVolume": 3, "meVolume": -1, "window": {"poppedOut": true},
                "sounds": [{"id": "s-1", "name": "a", "file": "sounds/s-1.wav", "category": "c-gone", "volume": 2}]}"#,
        )
        .unwrap();
        let board = Board::load(&dir);
        assert_eq!((board.others_volume, board.me_volume), (1.0, 0.0));
        assert!(!board.window.popped_out, "no pop-out window exists at start");
        assert_eq!(board.sounds[0].category, "", "a category that is gone");
        assert_eq!(board.sounds[0].volume, 1.0);
        assert_eq!(board.version, 1);
    }

    #[test]
    fn sounds_are_renamed_sorted_and_removed() {
        let mut board = Board::default();
        board.add_sound(sound("s-1", "airhorn"));
        board.add_sound(sound("s-2", "airhorn"));
        assert_eq!(board.rename_sound("s-1", "  horn  "), Ok(()));
        assert_eq!(board.sound("s-1").unwrap().name, "horn");
        assert_eq!(board.rename_sound("s-1", "  "), Err("empty_name".into()));
        assert_eq!(board.rename_sound("s-9", "x"), Err("no_sound".into()));
        let c = board.add_category("Memes").unwrap();
        assert_eq!(board.set_category("s-2", &c), Ok(()));
        assert_eq!(board.set_category("s-2", "c-nope"), Err("no_category".into()));
        assert_eq!(board.set_sound_volume("s-2", 1.5), Ok(()));
        assert_eq!(board.sound("s-2").unwrap().volume, 1.0);
        assert_eq!(board.set_sound_hotkey("s-2", "F13"), Ok(()));
        assert_eq!(board.remove_sound("s-1").unwrap().name, "horn");
        assert!(board.remove_sound("s-1").is_none());
        assert_eq!(board.sounds.len(), 1);
    }

    #[test]
    fn deleting_a_category_moves_its_sounds_to_no_category() {
        let mut board = Board::default();
        let memes = board.add_category("Memes").unwrap();
        assert!(memes.starts_with("c-"));
        assert_eq!(board.add_category(" memes "), Err("exists".into()));
        assert_eq!(board.add_category(""), Err("empty_name".into()));
        let music = board.add_category("Music").unwrap();
        assert_eq!(board.rename_category(&music, "memes"), Err("exists".into()));
        assert_eq!(board.rename_category(&music, "music"), Ok(()), "its own name in other letters");
        board.add_sound(sound("s-1", "a"));
        board.set_category("s-1", &memes).unwrap();
        board.add_sound(sound("s-2", "b"));
        board.set_category("s-2", &music).unwrap();
        assert_eq!(board.remove_category(&memes), Ok(()));
        assert_eq!(board.sound("s-1").unwrap().category, "");
        assert_eq!(board.sound("s-2").unwrap().category, music);
        assert_eq!(board.categories.len(), 1);
        assert_eq!(board.remove_category(&memes), Err("no_category".into()));
    }

    #[test]
    fn ids_are_random_and_names_come_from_the_file() {
        let (a, b) = (new_id("s"), new_id("s"));
        assert_ne!(a, b);
        assert!(a.starts_with("s-") && a.len() == 14, "{}", a);
        assert_eq!(default_name(Path::new("C:/sounds/Air Horn.mp3")), "Air Horn");
    }
}
