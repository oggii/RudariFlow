//! The soundboard: sounds on hotkeys, played into a virtual microphone (a
//! VB-Audio Virtual Cable) together with the user's own voice, and on the
//! headphones. See docs/superpowers/specs/2026-09-29-soundboard-design.md.
//!
//! `Soundboard` holds the library, the engine while the "Virtual
//! microphone" is on, and reports every change as an `Event`. The Tauri
//! commands and the hotkeys are in main.rs.

pub mod drift;
pub mod engine;
pub mod library;
pub mod mixer;
pub mod prepare;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex, Weak};

use serde::Serialize;

use self::engine::{Callbacks, Engine, EngineStats, Problem};
use self::library::{Board, Devices, Sound};
use self::mixer::{Mixer, PlayingVoice};
use crate::audio::lock;
use crate::startup_log;

/// Whether the virtual microphone runs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Off,
    On { cable: String },
    Error { problem: Problem },
}

/// What the views need to hear about; main.rs turns them into events.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// The library or the settings changed ("soundboard-changed").
    Changed,
    /// The playing sounds ("soundboard-playing").
    Playing(Vec<PlayingVoice>),
    /// On, off or failed ("soundboard-status").
    Status(Status),
}

/// Everything a view renders.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardState {
    pub board: Board,
    pub status: Status,
    pub playing: Vec<PlayingVoice>,
    /// Sounds whose files were deleted by hand.
    pub missing: Vec<String>,
    /// Sound ids, "stopSounds" and "toggleSoundHotkeys", whose hotkey another
    /// program owns.
    pub hotkeys_taken: Vec<String>,
}

/// One file of an add.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddResult {
    pub path: String,
    pub name: String,
    pub id: Option<String>,
    /// "unsupported", "too_long", "no_audio", "unreadable: …" or "disk: …".
    pub error: Option<String>,
}

pub struct Soundboard {
    /// `<app data>\soundboard`.
    dir: PathBuf,
    board: Mutex<Board>,
    /// While the virtual microphone is on.
    engine: Mutex<Option<Engine>>,
    /// Serialises turning on/off, a device change and a lost-device report.
    /// Held while waiting for an engine thread, so the engine's callbacks
    /// (`on_tick`, `on_lost`) must not need it except `engine_lost`, which
    /// runs on a thread of its own.
    lifecycle: Mutex<()>,
    /// One `ensure_cache` / file removal at a time (shared temp file name).
    cache_lock: Mutex<()>,
    on: AtomicBool,
    generation: AtomicU64,
    status: Mutex<Status>,
    /// The last report of the engine, for `state`.
    playing: Mutex<Vec<PlayingVoice>>,
    hotkeys_taken: Mutex<Vec<String>>,
    events: Box<dyn Fn(Event) + Send + Sync>,
    this: Weak<Soundboard>,
}

impl Soundboard {
    /// The board in `<app_dir>\soundboard`, off. `events` gets every change.
    pub fn new(app_dir: &Path, events: Box<dyn Fn(Event) + Send + Sync>) -> Arc<Soundboard> {
        let dir = app_dir.join("soundboard");
        let mut board = Board::load(&dir);
        // The pop-out window is closed at start.
        board.window.popped_out = false;
        Arc::new_cyclic(|this| Soundboard {
            dir,
            board: Mutex::new(board),
            engine: Mutex::new(None),
            lifecycle: Mutex::new(()),
            cache_lock: Mutex::new(()),
            on: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            status: Mutex::new(Status::Off),
            playing: Mutex::new(Vec::new()),
            hotkeys_taken: Mutex::new(Vec::new()),
            events,
            this: this.clone(),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn board(&self) -> Board {
        lock(&self.board).clone()
    }

    pub fn is_on(&self) -> bool {
        self.on.load(SeqCst)
    }

    pub fn status(&self) -> Status {
        lock(&self.status).clone()
    }

    pub fn state(&self) -> BoardState {
        let board = self.board();
        let missing = board.sounds.iter().filter(|s| prepare::is_missing(&self.dir, s)).map(|s| s.id.clone()).collect();
        BoardState {
            board,
            status: self.status(),
            playing: lock(&self.playing).clone(),
            missing,
            hotkeys_taken: lock(&self.hotkeys_taken).clone(),
        }
    }

    /// Turn the virtual microphone on: open the saved devices, or the
    /// automatic ones (`recording_mic` is the Recording setting's
    /// microphone). A missing or failing device leaves it off, with the
    /// reason in the status.
    pub fn turn_on(&self, recording_mic: &str) -> Result<(), Problem> {
        let _life = lock(&self.lifecycle);
        self.turn_on_locked(recording_mic, true)
    }

    /// `turn_on` for the app start with the switch saved on. A failure shows
    /// in the status but keeps the saved switch on, so the next start tries
    /// again (a cable that is not connected yet must not turn it off for good).
    pub fn turn_on_at_start(&self, recording_mic: &str) -> Result<(), Problem> {
        let _life = lock(&self.lifecycle);
        self.turn_on_locked(recording_mic, false)
    }

    /// `turn_on` with `lifecycle` held. The engine slot is only locked to
    /// store the result, never while the devices open.
    fn turn_on_locked(&self, recording_mic: &str, save_failure: bool) -> Result<(), Problem> {
        if lock(&self.engine).is_some() {
            return Ok(());
        }
        let board = self.board();
        let generation = self.generation.fetch_add(1, SeqCst) + 1;
        let started = engine::resolve(&board.devices, recording_mic, &engine::device_list()).and_then(|devices| {
            let (ticks, lost) = (self.this.clone(), self.this.clone());
            let callbacks = Callbacks {
                on_tick: Box::new(move |voices| {
                    if let Some(sb) = ticks.upgrade() {
                        // A stopped or replaced engine's last report is stale.
                        if sb.is_on() && sb.generation.load(SeqCst) == generation {
                            sb.set_playing(voices);
                        }
                    }
                }),
                on_lost: Box::new(move |problem| {
                    if let Some(sb) = lost.upgrade() {
                        sb.engine_lost(generation, problem);
                    }
                }),
            };
            Engine::start(generation, devices, Mixer::new(board.layer, board.others_volume, board.me_volume), callbacks)
        });
        match started {
            Ok(engine) => {
                let info = engine.info().clone();
                *lock(&self.engine) = Some(engine);
                self.on.store(true, SeqCst);
                startup_log::log(&format!(
                    "[soundboard] on: {} + sounds -> {}, sounds -> {}",
                    info.microphone, info.cable, info.headphones
                ));
                self.save_enabled(true);
                self.set_status(Status::On { cable: info.cable });
                Ok(())
            }
            Err(problem) => {
                startup_log::log(&format!("[soundboard] not on: {:?}", problem));
                if save_failure {
                    self.save_enabled(false);
                }
                self.set_status(Status::Error { problem: problem.clone() });
                Err(problem)
            }
        }
    }

    /// The switch was turned off.
    pub fn turn_off(&self) {
        let _life = lock(&self.lifecycle);
        self.stop_engine();
        self.save_enabled(false);
        self.set_status(Status::Off);
        startup_log::log("[soundboard] off");
    }

    /// The app quits: stop without changing the saved switch.
    pub fn shutdown(&self) {
        let _life = lock(&self.lifecycle);
        self.stop_engine();
    }

    fn stop_engine(&self) {
        let engine = lock(&self.engine).take();
        self.on.store(false, SeqCst);
        if let Some(engine) = engine {
            engine.stop();
        }
        self.set_playing(Vec::new());
    }

    /// A device failed while on (from the engine, on a thread of its own).
    fn engine_lost(&self, generation: u64, problem: Problem) {
        // Waits for a turn_on/turn_off in progress; after it, a replaced or
        // stopped engine is no longer in the slot and the report is stale.
        let _life = lock(&self.lifecycle);
        let engine = {
            let mut slot = lock(&self.engine);
            if slot.as_ref().map(|e| e.generation) != Some(generation) {
                return;
            }
            slot.take()
        };
        self.on.store(false, SeqCst);
        if let Some(engine) = engine {
            engine.stop();
        }
        startup_log::log(&format!("[soundboard] device lost, off: {:?}", problem));
        self.set_playing(Vec::new());
        self.save_enabled(false);
        self.set_status(Status::Error { problem });
    }

    fn save_enabled(&self, enabled: bool) {
        if lock(&self.board).enabled != enabled {
            if let Err(e) = self.update(|b| {
                b.enabled = enabled;
                Ok(())
            }) {
                startup_log::log(&format!("[soundboard] could not save the switch: {}", e));
            }
        }
    }

    fn set_status(&self, status: Status) {
        *lock(&self.status) = status.clone();
        (self.events)(Event::Status(status));
    }

    fn set_playing(&self, voices: Vec<PlayingVoice>) {
        *lock(&self.playing) = voices.clone();
        (self.events)(Event::Playing(voices));
    }

    /// Change the board, save it and tell the views.
    fn update<R>(&self, change: impl FnOnce(&mut Board) -> Result<R, String>) -> Result<R, String> {
        let result = {
            let mut board = lock(&self.board);
            // Changed on a copy, kept only once it is saved.
            let mut changed = board.clone();
            let result = change(&mut changed)?;
            changed.save(&self.dir).map_err(|e| format!("disk: {}", e))?;
            *board = changed;
            result
        };
        (self.events)(Event::Changed);
        Ok(result)
    }

    /// `f` on the mixer while the engine runs.
    fn with_mixer(&self, f: impl FnOnce(&mut Mixer)) {
        if let Some(engine) = lock(&self.engine).as_ref() {
            engine.with_mixer(f);
        }
    }

    /// Save the chosen devices ("" = automatic). While on, the engine
    /// starts again on them; a missing one turns it off with the reason.
    pub fn set_devices(&self, devices: Devices, recording_mic: &str) -> Status {
        if let Err(e) = self.update(|b| {
            b.devices = devices;
            Ok(())
        }) {
            startup_log::log(&format!("[soundboard] could not save the devices: {}", e));
        }
        let _life = lock(&self.lifecycle);
        if self.is_on() {
            self.stop_engine();
            let _ = self.turn_on_locked(recording_mic, true);
        } else if matches!(self.status(), Status::Error { .. }) {
            // A new choice clears the old error.
            self.set_status(Status::Off);
        }
        self.status()
    }

    pub fn set_volumes(&self, others: f32, me: f32) -> Result<(), String> {
        let (others, me) = (others.clamp(0.0, 1.0), me.clamp(0.0, 1.0));
        self.update(|b| {
            b.others_volume = others;
            b.me_volume = me;
            Ok(())
        })?;
        self.with_mixer(|m| {
            m.others_volume = others;
            m.me_volume = me;
        });
        Ok(())
    }

    pub fn set_layer(&self, layer: bool) -> Result<(), String> {
        self.update(|b| {
            b.layer = layer;
            Ok(())
        })?;
        self.with_mixer(|m| m.layer = layer);
        Ok(())
    }

    /// Add files, one by one; each gets its result.
    pub fn add(&self, paths: &[String]) -> Vec<AddResult> {
        paths
            .iter()
            .map(|path| {
                let name = library::default_name(Path::new(path));
                let id = library::new_id("s");
                let added = prepare::prepare(&self.dir, Path::new(path), &id).and_then(|prepared| {
                    let sound = Sound {
                        id: id.clone(),
                        name: name.clone(),
                        file: prepared.file,
                        category: String::new(),
                        hotkey: String::new(),
                        volume: 1.0,
                        duration_ms: prepared.duration_ms,
                    };
                    let kept = sound.clone();
                    self.update(|b| {
                        b.add_sound(sound);
                        Ok(())
                    })
                    .inspect_err(|_| prepare::remove_files(&self.dir, &kept))
                });
                match &added {
                    Ok(()) => startup_log::log(&format!("[soundboard] added '{}' as {}", name, id)),
                    Err(e) => startup_log::log(&format!("[soundboard] '{}' not added: {}", name, e)),
                }
                AddResult { path: path.clone(), name, id: added.is_ok().then_some(id), error: added.err() }
            })
            .collect()
    }

    /// Delete a sound and both of its files.
    pub fn remove(&self, id: &str) -> Result<Sound, String> {
        self.with_mixer(|m| {
            m.stop_sound(id);
        });
        let _cache = lock(&self.cache_lock);
        let sound = self.update(|b| b.remove_sound(id).ok_or_else(|| "no_sound".to_string()))?;
        prepare::remove_files(&self.dir, &sound);
        Ok(sound)
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        self.update(|b| b.rename_sound(id, name))
    }

    pub fn set_category(&self, id: &str, category: &str) -> Result<(), String> {
        self.update(|b| b.set_category(id, category))
    }

    pub fn set_sound_volume(&self, id: &str, volume: f32) -> Result<(), String> {
        let volume = volume.clamp(0.0, 1.0);
        self.update(|b| b.set_sound_volume(id, volume))?;
        self.with_mixer(|m| m.set_sound_volume(id, volume));
        Ok(())
    }

    /// Saved as given; main.rs checks it and registers it.
    pub fn set_sound_hotkey(&self, id: &str, hotkey: &str) -> Result<(), String> {
        self.update(|b| b.set_sound_hotkey(id, hotkey))
    }

    pub fn set_stop_hotkey(&self, hotkey: &str) -> Result<(), String> {
        self.update(|b| {
            b.stop_hotkey = hotkey.to_string();
            Ok(())
        })
    }

    /// Turn the sounds' hotkeys on or off (they stay assigned); main.rs
    /// registers or releases them from the change event.
    pub fn set_sound_hotkeys(&self, enabled: bool) -> Result<(), String> {
        self.update(|b| {
            b.sound_hotkeys = enabled;
            Ok(())
        })
    }

    /// The toggle hotkey: flip the sounds' hotkeys; true when they are on now.
    pub fn toggle_sound_hotkeys(&self) -> Result<bool, String> {
        self.update(|b| {
            b.sound_hotkeys = !b.sound_hotkeys;
            Ok(b.sound_hotkeys)
        })
    }

    /// The hotkey that turns the sounds' hotkeys on and off ("" = none);
    /// saved as given, main.rs checks it.
    pub fn set_toggle_hotkey(&self, hotkey: &str) -> Result<(), String> {
        self.update(|b| {
            b.toggle_hotkey = hotkey.to_string();
            Ok(())
        })
    }

    /// The hotkeys another program owns (sound ids, "stopSounds",
    /// "toggleSoundHotkeys"); the views
    /// hear about it only when the list changes.
    pub fn set_hotkeys_taken(&self, taken: Vec<String>) {
        let changed = {
            let mut current = lock(&self.hotkeys_taken);
            let changed = *current != taken;
            *current = taken;
            changed
        };
        if changed {
            (self.events)(Event::Changed);
        }
    }

    /// Play a sound, or stop it when it plays. True when it started.
    /// Errors: "off", "no_sound", "missing" (its files are gone), or why the
    /// prepared file could not be read.
    pub fn play(&self, id: &str) -> Result<bool, String> {
        let sound = lock(&self.board).sound(id).cloned().ok_or("no_sound")?;
        // Playing a playing sound stops it (no file work needed).
        match lock(&self.engine).as_ref() {
            None => return Err("off".into()),
            Some(engine) => {
                if engine.with_mixer(|m| m.stop_sound(id)) {
                    return Ok(false);
                }
            }
        }
        // The decode runs without the engine slot, so stop/turn_off/stats do
        // not wait for it. A cache that exists is used at once; building one
        // is serialised (shared temp file) and only for a sound still in the
        // library (a removal holds the same lock).
        let wav = if prepare::cache_path(&self.dir, id).exists() {
            prepare::cache_path(&self.dir, id)
        } else {
            let _cache = lock(&self.cache_lock);
            if lock(&self.board).sound(id).is_none() {
                return Err("no_sound".into());
            }
            prepare::ensure_cache(&self.dir, &sound)?
        };
        // Toggle and start under one hold of the slot: two quick presses
        // cannot both start the sound.
        let slot = lock(&self.engine);
        let engine = slot.as_ref().ok_or("off")?;
        if engine.with_mixer(|m| m.stop_sound(id)) {
            return Ok(false);
        }
        match engine.start_voice(id, sound.volume, &wav) {
            Ok(()) => Ok(true),
            // The engine ended (a device was lost); the lost event follows.
            Err(e) if e == "engine_stopped" => Err("off".into()),
            // A removal deleted the file after the check above.
            Err(_) if !wav.exists() => Err("missing".into()),
            Err(e) => Err(e),
        }
    }

    pub fn stop_all(&self) {
        self.with_mixer(|m| m.stop_all());
    }

    pub fn category_add(&self, name: &str) -> Result<String, String> {
        self.update(|b| b.add_category(name))
    }

    pub fn category_rename(&self, id: &str, name: &str) -> Result<(), String> {
        self.update(|b| b.rename_category(id, name))
    }

    pub fn category_remove(&self, id: &str) -> Result<(), String> {
        self.update(|b| b.remove_category(id))
    }

    /// The pop-out window opened or closed, or its Always on top switch.
    pub fn set_window(&self, popped_out: Option<bool>, always_on_top: Option<bool>) {
        if let Err(e) = self.update(|b| {
            if let Some(popped_out) = popped_out {
                b.window.popped_out = popped_out;
            }
            if let Some(always_on_top) = always_on_top {
                b.window.always_on_top = always_on_top;
            }
            Ok(())
        }) {
            startup_log::log(&format!("[soundboard] could not save the window: {}", e));
        }
    }

    /// For the live checks; None while off.
    pub fn stats(&self) -> Option<EngineStats> {
        lock(&self.engine).as_ref().map(|e| e.stats())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn fixture(name: &str) -> String {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/soundboard")
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    /// A board in a fresh folder, with its events as short strings.
    fn board(name: &str) -> (Arc<Soundboard>, mpsc::Receiver<String>, PathBuf) {
        let app_dir = std::env::temp_dir().join(format!("rudariflow_sb_{}", name));
        let _ = std::fs::remove_dir_all(&app_dir);
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sb = Soundboard::new(
            &app_dir,
            Box::new(move |event| {
                let text = match event {
                    Event::Changed => "changed".to_string(),
                    Event::Playing(voices) => format!("playing:{}", voices.len()),
                    Event::Status(status) => format!("status:{:?}", status),
                };
                let _ = lock(&tx).send(text);
            }),
        );
        (sb, rx, app_dir)
    }

    fn drain(rx: &mpsc::Receiver<String>) -> Vec<String> {
        rx.try_iter().collect()
    }

    #[test]
    fn sounds_are_added_organised_and_removed() {
        let (sb, rx, app_dir) = board("library");
        let results = sb.add(&[fixture("tone.wav"), fixture("tone.ogg")]);
        assert!(results.iter().all(|r| r.error.is_none() && r.id.is_some()), "{:?}", results);
        assert_eq!(results[0].name, "tone");
        let ids: Vec<String> = results.iter().map(|r| r.id.clone().unwrap()).collect();
        assert_ne!(ids[0], ids[1]);
        assert_eq!(drain(&rx), ["changed", "changed"]);
        let memes = sb.category_add("Memes").unwrap();
        sb.rename(&ids[0], "airhorn").unwrap();
        sb.set_category(&ids[0], &memes).unwrap();
        sb.set_sound_volume(&ids[0], 0.5).unwrap();
        assert_eq!(sb.rename("s-none", "x"), Err("no_sound".to_string()));
        // Saved: the file on disk has it all.
        let saved = Board::load(&app_dir.join("soundboard"));
        let s = saved.sound(&ids[0]).unwrap();
        assert_eq!((s.name.as_str(), s.category.as_str(), s.volume), ("airhorn", memes.as_str(), 0.5));
        assert!((950..=1100).contains(&s.duration_ms), "{}", s.duration_ms);
        let removed = sb.remove(&ids[0]).unwrap();
        assert!(!sb.dir().join(&removed.file).exists());
        assert!(!prepare::cache_path(sb.dir(), &ids[0]).exists());
        assert_eq!(sb.board().sounds.len(), 1);
        sb.category_remove(&memes).unwrap();
        assert!(sb.board().categories.is_empty());
    }

    #[test]
    fn a_file_that_fails_is_reported_and_the_rest_are_added() {
        let (sb, _rx, app_dir) = board("failures");
        std::fs::create_dir_all(&app_dir).unwrap();
        let text = app_dir.join("notes.txt");
        std::fs::write(&text, "x").unwrap();
        let results = sb.add(&[text.to_string_lossy().into_owned(), fixture("tone.flac")]);
        assert_eq!(results[0].error.as_deref(), Some("unsupported"));
        assert_eq!((results[0].name.as_str(), results[0].id.as_deref()), ("notes", None));
        assert!(results[1].error.is_none());
        assert_eq!(sb.board().sounds.len(), 1);
    }

    #[test]
    fn playing_needs_the_virtual_microphone_and_missing_files_show() {
        let (sb, _rx, _) = board("off");
        let id = sb.add(&[fixture("tone.wav")])[0].id.clone().unwrap();
        assert_eq!(sb.play(&id), Err("off".to_string()));
        assert_eq!(sb.play("s-none"), Err("no_sound".to_string()));
        sb.stop_all();
        assert!(sb.state().missing.is_empty());
        let sound = sb.board().sound(&id).cloned().unwrap();
        prepare::remove_files(sb.dir(), &sound);
        assert_eq!(sb.state().missing, vec![id]);
        assert_eq!(sb.status(), Status::Off);
        assert!(sb.state().playing.is_empty());
    }

    #[test]
    fn a_missing_device_keeps_it_off_with_the_reason() {
        let (sb, rx, _) = board("device");
        let devices = Devices { cable: "No Such Cable (RudariFlow test)".into(), ..Devices::default() };
        assert_eq!(sb.set_devices(devices, "default"), Status::Off, "off: the devices are only saved");
        let problem = sb.turn_on("default").unwrap_err();
        assert_eq!(problem, Problem::new("not_connected", "cable", "No Such Cable (RudariFlow test)", ""));
        assert!(!sb.is_on());
        assert_eq!(sb.status(), Status::Error { problem });
        assert!(!sb.board().enabled);
        assert!(drain(&rx).iter().any(|e| e.starts_with("status:Error")));
        // Choosing devices again clears the old error (nothing is opened while off).
        assert_eq!(sb.set_devices(Devices::default(), "default"), Status::Off);
        assert!(drain(&rx).iter().any(|e| e == "status:Off"));
        sb.turn_off();
        assert_eq!(sb.status(), Status::Off);
        assert_eq!(serde_json::to_string(&Status::Off).unwrap(), r#"{"state":"off"}"#);
        assert_eq!(serde_json::to_string(&Status::On { cable: "C".into() }).unwrap(), r#"{"state":"on","cable":"C"}"#);
    }

    #[test]
    fn a_failed_turn_on_at_start_keeps_the_saved_switch_on() {
        let (sb, rx, app_dir) = board("atstart");
        let devices = Devices { cable: "No Such Cable (RudariFlow test)".into(), ..Devices::default() };
        sb.set_devices(devices, "default");
        sb.update(|b| {
            b.enabled = true;
            Ok(())
        })
        .unwrap();
        let problem = sb.turn_on_at_start("default").unwrap_err();
        assert_eq!(sb.status(), Status::Error { problem });
        assert!(!sb.is_on());
        assert!(sb.board().enabled, "retried at the next start");
        assert!(Board::load(&app_dir.join("soundboard")).enabled, "and saved so");
        assert!(drain(&rx).iter().any(|e| e.starts_with("status:Error")));
        // The switch itself still saves a failure as off.
        sb.turn_on("default").unwrap_err();
        assert!(!sb.board().enabled);
    }

    #[test]
    fn a_failed_save_changes_nothing() {
        let (sb, rx, app_dir) = board("savefail");
        let id = sb.add(&[fixture("tone.wav")])[0].id.clone().unwrap();
        let before = sb.board();
        // A folder where soundboard.json belongs: every save fails.
        let json = app_dir.join("soundboard").join(library::FILE);
        std::fs::remove_file(&json).unwrap();
        std::fs::create_dir(&json).unwrap();
        drain(&rx);
        let added = sb.add(&[fixture("tone.ogg")]);
        assert!(added[0].error.as_deref().unwrap_or("").starts_with("disk"), "{:?}", added);
        assert_eq!(sb.board(), before, "no ghost sound");
        assert_eq!(std::fs::read_dir(sb.dir().join("sounds")).unwrap().count(), 1, "its files are removed");
        let sound = before.sound(&id).unwrap().clone();
        assert!(sb.remove(&id).unwrap_err().starts_with("disk"));
        assert_eq!(sb.board(), before, "the sound stays");
        assert!(sb.dir().join(&sound.file).exists() && prepare::cache_path(sb.dir(), &id).exists());
        assert!(sb.rename(&id, "x").is_err());
        assert_eq!(sb.board(), before);
        assert!(drain(&rx).is_empty(), "no change event for a failed save");
        std::fs::remove_dir(&json).unwrap();
        assert!(sb.remove(&id).is_ok());
        assert!(!sb.dir().join(&sound.file).exists());
    }

    #[test]
    fn settings_are_saved_and_taken_hotkeys_announced_once() {
        let (sb, rx, app_dir) = board("settings");
        sb.set_volumes(0.5, 2.0).unwrap();
        sb.set_layer(true).unwrap();
        sb.set_stop_hotkey("F14").unwrap();
        sb.set_window(Some(true), Some(true));
        let saved = Board::load(&app_dir.join("soundboard"));
        assert_eq!((saved.others_volume, saved.me_volume, saved.layer), (0.5, 1.0, true));
        assert_eq!(saved.stop_hotkey, "F14");
        assert!(saved.window.always_on_top);
        assert!(sb.board().window.popped_out);
        drain(&rx);
        sb.set_hotkeys_taken(vec!["stopSounds".into()]);
        sb.set_hotkeys_taken(vec!["stopSounds".into()]);
        assert_eq!(drain(&rx), ["changed"]);
        assert_eq!(sb.state().hotkeys_taken, vec!["stopSounds".to_string()]);
    }

    #[test]
    fn sound_hotkeys_are_switched_and_their_toggle_saved() {
        let (sb, rx, app_dir) = board("toggle");
        assert!(sb.board().sound_hotkeys, "on by default");
        drain(&rx);
        sb.set_toggle_hotkey("F15").unwrap();
        assert_eq!(drain(&rx), ["changed"]);
        sb.set_sound_hotkeys(false).unwrap();
        assert_eq!(drain(&rx), ["changed"]);
        let saved = Board::load(&app_dir.join("soundboard"));
        assert_eq!((saved.sound_hotkeys, saved.toggle_hotkey.as_str()), (false, "F15"));
        // The toggle hotkey flips the switch and says where it is now.
        assert_eq!(sb.toggle_sound_hotkeys(), Ok(true));
        assert!(Board::load(&app_dir.join("soundboard")).sound_hotkeys);
        assert_eq!(sb.toggle_sound_hotkeys(), Ok(false));
        assert!(!sb.board().sound_hotkeys);
        assert_eq!(drain(&rx), ["changed", "changed"]);
        sb.set_toggle_hotkey("").unwrap();
        assert_eq!(Board::load(&app_dir.join("soundboard")).toggle_hotkey, "");
    }
}
