//! The soundboard's devices. While the virtual microphone is on, three
//! cpal streams (WASAPI shared mode, each device's own format) run on the
//! "rf-soundboard" thread: the microphone in, the virtual cable out
//! (microphone + sounds) and the headphones out (sounds only). Every
//! playing sound has a reader thread that keeps about a second of it in
//! memory, so no audio callback touches a file.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

use super::drift::{mic_frames, DriftBuffer, DriftStats};
use super::library::Devices;
use super::mixer::{Mixer, Output, PlayingVoice, VoiceShared, NO_END, SOURCE_RATE};
use crate::audio::lock;
use crate::startup_log;

/// Opening the three devices may take this long (a USB device waking up).
const OPEN_TIMEOUT: Duration = Duration::from_secs(8);
/// How often the playing sounds are reported.
const TICK: Duration = Duration::from_millis(100);
/// A reader keeps this much of its sound ahead of the slower output (1 s).
const AHEAD: u64 = SOURCE_RATE as u64;
/// It reads this much at a time (100 ms).
const CHUNK: usize = 4_800;
/// Read before the sound starts, so it starts at once (200 ms).
const FIRST: usize = 9_600;
/// A frame with a sample of at least -60 dBFS (about 33 LSB of 16 bit) is
/// sound; quieter ones at the start or end of a file are codec padding and
/// encoder ramps (an MP3: about 1100 frames before, 950 after), which a
/// loop leaves out.
const QUIET: f32 = 0.001;
/// The crossfade at a loop's seam (10 ms); a tenth of the loop when the
/// loop is shorter than 100 ms.
const XFADE: u64 = 480;
/// The padding is looked for in the first and the last 2 s of a file.
const EDGE_SCAN: u64 = 2 * SOURCE_RATE as u64;
/// A sound up to 1.5 s long is read into memory once (a "1 s" sound from a
/// compressed file is a little longer).
const IN_MEMORY: u64 = SOURCE_RATE as u64 * 3 / 2;

/// The audio devices Windows has now, by name.
#[derive(Debug, Clone, Default)]
pub struct DeviceList {
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub default_input: Option<String>,
    pub default_output: Option<String>,
}

pub fn device_list() -> DeviceList {
    let host = cpal::default_host();
    DeviceList {
        inputs: host.input_devices().map(|d| d.filter_map(|d| d.name().ok()).collect()).unwrap_or_default(),
        outputs: host.output_devices().map(|d| d.filter_map(|d| d.name().ok()).collect()).unwrap_or_default(),
        default_input: host.default_input_device().and_then(|d| d.name().ok()),
        default_output: host.default_output_device().and_then(|d| d.name().ok()),
    }
}

/// A VB-Audio cable endpoint: "… (VB-Audio Virtual Cable)", "CABLE Input",
/// "CABLE Output".
fn is_cable(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.contains("vb-audio virtual cable") || n.contains("cable input") || n.contains("cable output")
}

/// The cable's 16-channel endpoint: "CABLE In 16 Ch" or, as Windows
/// names it on some PCs, "CABLE In 16ch".
fn is_16_channel(name: &str) -> bool {
    name.to_ascii_lowercase().replace(' ', "").contains("16ch")
}

/// The VB-Audio cable's input: a name with "VB-Audio Virtual Cable" or
/// "CABLE Input", preferring the stereo endpoint over "CABLE In 16 Ch"
/// (both feed "CABLE Output").
pub fn auto_cable(outputs: &[String]) -> Option<String> {
    let cables: Vec<&String> = outputs.iter().filter(|n| is_cable(n)).collect();
    cables
        .iter()
        .find(|n| !is_16_channel(n))
        .or(cables.first())
        .map(|n| n.to_string())
}

/// What "Automatic" means for each device now.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picks {
    pub microphone: Option<String>,
    pub cable: Option<String>,
    pub headphones: Option<String>,
}

/// The Recording setting's microphone while it is connected, else Windows'
/// default input; the cable; Windows' default output.
pub fn automatic(recording_mic: &str, list: &DeviceList) -> Picks {
    let microphone = if recording_mic != "default" && list.inputs.iter().any(|n| n == recording_mic) {
        Some(recording_mic.to_string())
    } else {
        list.default_input.clone()
    };
    Picks { microphone, cable: auto_cable(&list.outputs), headphones: list.default_output.clone() }
}

/// For the Devices area: every device and the automatic picks.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceChoices {
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub automatic: Picks,
}

pub fn choices(recording_mic: &str) -> DeviceChoices {
    let list = device_list();
    let automatic = automatic(recording_mic, &list);
    DeviceChoices { inputs: list.inputs, outputs: list.outputs, automatic }
}

/// The three devices the engine opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineDevices {
    pub microphone: String,
    pub cable: String,
    pub headphones: String,
}

/// Why the virtual microphone is not on. `reason`: "no_cable" (none
/// found), "no_device" (no microphone or headphones found),
/// "not_connected" (a chosen device is missing), "mic_is_cable" (the
/// microphone is the cable's own output), "open_failed", "lost" (it failed
/// while on). `device`: "microphone", "cable" or "headphones".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub reason: String,
    pub device: String,
    pub name: String,
    pub detail: String,
}

impl Problem {
    pub fn new(reason: &str, device: &str, name: &str, detail: &str) -> Problem {
        Problem { reason: reason.into(), device: device.into(), name: name.into(), detail: detail.into() }
    }
}

/// The saved devices ("" = automatic) as names that are connected now.
pub fn resolve(saved: &Devices, recording_mic: &str, list: &DeviceList) -> Result<EngineDevices, Problem> {
    let auto = automatic(recording_mic, list);
    let one = |kind: &str, saved: &str, auto: Option<String>, available: &[String]| -> Result<String, Problem> {
        if saved.is_empty() {
            auto.ok_or_else(|| Problem::new(if kind == "cable" { "no_cable" } else { "no_device" }, kind, "", ""))
        } else if available.iter().any(|n| n == saved) {
            Ok(saved.to_string())
        } else {
            Err(Problem::new("not_connected", kind, saved, ""))
        }
    };
    // The cable first: without it nothing works.
    let cable = one("cable", &saved.cable, auto.cable, &list.outputs)?;
    let microphone = one("microphone", &saved.microphone, auto.microphone, &list.inputs)?;
    // "CABLE Output" as the microphone: the cable would hear itself, louder
    // every round.
    if is_cable(&microphone) {
        return Err(Problem::new("mic_is_cable", "microphone", &microphone, ""));
    }
    let headphones = one("headphones", &saved.headphones, auto.headphones, &list.outputs)?;
    Ok(EngineDevices { microphone, cable, headphones })
}

/// How the engine reports back; both run off the audio threads.
pub struct Callbacks {
    /// The playing voices, every 100 ms while something plays, and once
    /// more when the last one ends.
    pub on_tick: Box<dyn FnMut(Vec<PlayingVoice>) + Send>,
    /// A device failed while on; the engine has stopped.
    pub on_lost: Box<dyn FnOnce(Problem) + Send>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub microphone: String,
    pub cable: String,
    pub headphones: String,
    pub mic_rate: u32,
    pub mic_channels: u16,
    pub cable_rate: u32,
    pub cable_channels: u16,
    pub headphones_rate: u32,
    pub headphones_channels: u16,
}

/// For the live checks: the devices, their formats and the microphone
/// buffer's stats.
#[derive(Debug, Clone, Serialize)]
pub struct EngineStats {
    #[serde(flatten)]
    pub info: EngineInfo,
    #[serde(flatten)]
    pub drift: DriftStats,
}

enum Control {
    Stop,
    Lost(Problem),
}

pub struct Engine {
    /// Tells a lost-device report of an older engine apart.
    pub generation: u64,
    control: Sender<Control>,
    stopped: Receiver<()>,
    mixer: Arc<Mutex<Mixer>>,
    drift: Arc<Mutex<DriftBuffer>>,
    /// The engine thread is past its streams (stopped or lost); set under
    /// the mixer's lock, so no voice starts that nothing would play.
    ended: Arc<AtomicBool>,
    info: EngineInfo,
}

impl Engine {
    /// Open the devices and start the streams on a thread of their own.
    pub fn start(generation: u64, devices: EngineDevices, mixer: Mixer, callbacks: Callbacks) -> Result<Engine, Problem> {
        let mixer = Arc::new(Mutex::new(mixer));
        let drift = Arc::new(Mutex::new(DriftBuffer::new(SOURCE_RATE, SOURCE_RATE)));
        let (control, control_rx) = mpsc::channel::<Control>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<EngineInfo, Problem>>();
        let (stopped_tx, stopped) = mpsc::channel::<()>();
        let ended = Arc::new(AtomicBool::new(false));
        let (m, d, c, e, open) = (mixer.clone(), drift.clone(), control.clone(), ended.clone(), devices.clone());
        std::thread::Builder::new()
            .name("rf-soundboard".into())
            .spawn(move || {
                // cpal streams stay on the thread that made them.
                let streams = match open_streams(&open, &m, &d, &c) {
                    Ok((streams, info)) => {
                        let _ = ready_tx.send(Ok(info));
                        streams
                    }
                    Err(problem) => {
                        let _ = ready_tx.send(Err(problem));
                        return;
                    }
                };
                serve(streams, &control_rx, &m, &e, callbacks, stopped_tx);
            })
            .map_err(|e| Problem::new("open_failed", "cable", &devices.cable, &e.to_string()))?;
        match ready_rx.recv_timeout(OPEN_TIMEOUT) {
            Ok(Ok(info)) => Ok(Engine { generation, control, stopped, mixer, drift, ended, info }),
            Ok(Err(problem)) => Err(problem),
            Err(_) => {
                // Streams that open later close at once.
                let _ = control.send(Control::Stop);
                Err(Problem::new("open_failed", "cable", &devices.cable, "the audio devices did not answer"))
            }
        }
    }

    pub fn info(&self) -> &EngineInfo {
        &self.info
    }

    pub fn stats(&self) -> EngineStats {
        EngineStats { info: self.info.clone(), drift: lock(&self.drift).stats() }
    }

    pub fn with_mixer<R>(&self, f: impl FnOnce(&mut Mixer) -> R) -> R {
        f(&mut lock(&self.mixer))
    }

    /// Start playing a prepared WAV (the first 200 ms are read before it
    /// starts; the rest on a reader thread), `looping` until it is stopped.
    /// "engine_stopped" once the engine has ended (a device was lost).
    pub fn start_voice(&self, sound_id: &str, volume: f32, wav: &Path, looping: bool) -> Result<(), String> {
        const STOPPED: &str = "engine_stopped";
        if self.ended.load(Ordering::Acquire) {
            return Err(STOPPED.to_string());
        }
        let (shared, frames) = spawn_reader(wav, looping)?;
        let mut mixer = lock(&self.mixer);
        // Checked again under the lock the engine thread sets it under.
        if self.ended.load(Ordering::Acquire) {
            drop(mixer);
            shared.done.store(true, Ordering::Relaxed);
            return Err(STOPPED.to_string());
        }
        mixer.start(sound_id, volume, frames, shared);
        Ok(())
    }

    /// Close the streams. Dropping a WASAPI stream joins its thread; a
    /// wedged device must not hang the caller for long.
    pub fn stop(self) {
        let _ = self.control.send(Control::Stop);
        let _ = self.stopped.recv_timeout(Duration::from_secs(3));
        // A wedged stream may still hold the mixer: end the voices anyway, so
        // no reader thread outlives the engine.
        end_voices(&self.mixer, &self.ended);
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.control.send(Control::Stop);
    }
}

/// The engine thread once its streams are open: run until Stop or a lost
/// device, end every voice, close the streams, report a lost device once.
fn serve<S>(
    streams: S,
    control: &Receiver<Control>,
    mixer: &Mutex<Mixer>,
    ended: &AtomicBool,
    callbacks: Callbacks,
    stopped: Sender<()>,
) {
    let Callbacks { mut on_tick, on_lost } = callbacks;
    let lost = run_until_stopped(control, mixer, &mut *on_tick);
    // Before closing the streams (a wedged device may hang that): from now
    // on no voice starts, and the playing ones end, so their readers stop.
    end_voices(mixer, ended);
    drop(streams);
    let _ = stopped.send(());
    if let Some(problem) = lost {
        // Off this thread: the handler takes the engine out of the board
        // and waits for it to stop.
        std::thread::spawn(move || on_lost(problem));
    }
}

/// Mark the engine ended and end every voice, under the mixer's lock.
fn end_voices(mixer: &Mutex<Mixer>, ended: &AtomicBool) {
    let mut mixer = lock(mixer);
    ended.store(true, Ordering::Release);
    mixer.clear();
}

/// Wait for Stop or a lost device, reporting the playing voices every
/// 100 ms while something plays. Returns the problem when a device was lost.
fn run_until_stopped(
    control: &Receiver<Control>,
    mixer: &Mutex<Mixer>,
    on_tick: &mut dyn FnMut(Vec<PlayingVoice>),
) -> Option<Problem> {
    let mut was_playing = false;
    loop {
        match control.recv_timeout(TICK) {
            Ok(Control::Stop) | Err(RecvTimeoutError::Disconnected) => return None,
            Ok(Control::Lost(problem)) => return Some(problem),
            Err(RecvTimeoutError::Timeout) => {
                let playing = lock(mixer).playing();
                if !playing.is_empty() || was_playing {
                    was_playing = !playing.is_empty();
                    on_tick(playing);
                }
            }
        }
    }
}

fn find_device(host: &cpal::Host, name: &str, input: bool) -> Option<cpal::Device> {
    let devices: Vec<cpal::Device> =
        if input { host.input_devices().ok()?.collect() } else { host.output_devices().ok()?.collect() };
    devices.into_iter().find(|d| d.name().is_ok_and(|n| n == name))
}

fn open_failed(kind: &str, name: &str, error: impl std::fmt::Display) -> Problem {
    Problem::new("open_failed", kind, name, &error.to_string())
}

/// The device's own shared-mode format; WASAPI mixes in 32-bit float.
fn float_config(
    kind: &str,
    name: &str,
    config: Result<cpal::SupportedStreamConfig, cpal::DefaultStreamConfigError>,
) -> Result<cpal::StreamConfig, Problem> {
    let config = config.map_err(|e| open_failed(kind, name, e))?;
    if config.sample_format() != cpal::SampleFormat::F32 {
        return Err(open_failed(kind, name, format!("unsupported sample format {:?}", config.sample_format())));
    }
    Ok(config.config())
}

/// A stream's error callback: any error stops the engine with the device's name.
fn on_error(kind: &'static str, name: &str, control: &Sender<Control>) -> impl FnMut(cpal::StreamError) + Send + 'static {
    let (name, control) = (name.to_string(), control.clone());
    move |error| {
        let _ = control.send(Control::Lost(Problem::new("lost", kind, &name, &error.to_string())));
    }
}

/// The ms since `last` (0 the first time), and now becomes `last`.
fn since(last: &mut Option<Instant>) -> f32 {
    let now = Instant::now();
    let gap = last.map_or(0.0, |t| now.duration_since(t).as_secs_f32() * 1000.0);
    *last = Some(now);
    gap
}

fn clip(data: &mut [f32]) {
    for s in data {
        *s = s.clamp(-1.0, 1.0);
    }
}

/// Open and start the three streams.
fn open_streams(
    devices: &EngineDevices,
    mixer: &Arc<Mutex<Mixer>>,
    drift: &Arc<Mutex<DriftBuffer>>,
    control: &Sender<Control>,
) -> Result<(Vec<cpal::Stream>, EngineInfo), Problem> {
    let host = cpal::default_host();
    let missing = |kind: &str, name: &str| Problem::new("not_connected", kind, name, "");
    let cable = find_device(&host, &devices.cable, false).ok_or_else(|| missing("cable", &devices.cable))?;
    let headphones =
        find_device(&host, &devices.headphones, false).ok_or_else(|| missing("headphones", &devices.headphones))?;
    let mic = find_device(&host, &devices.microphone, true).ok_or_else(|| missing("microphone", &devices.microphone))?;
    let cable_config = float_config("cable", &devices.cable, cable.default_output_config())?;
    let headphones_config = float_config("headphones", &devices.headphones, headphones.default_output_config())?;
    let mic_config = float_config("microphone", &devices.microphone, mic.default_input_config())?;
    let (cable_rate, cable_channels) = (cable_config.sample_rate.0, cable_config.channels as usize);
    let (headphones_rate, headphones_channels) = (headphones_config.sample_rate.0, headphones_config.channels as usize);
    let mic_channels = mic_config.channels as usize;
    *lock(drift) = DriftBuffer::new(mic_config.sample_rate.0, cable_rate);

    // The cable: the microphone and the sounds at "Others hear".
    let (m, d) = (mixer.clone(), drift.clone());
    let mut last_read: Option<Instant> = None;
    let cable_stream = cable
        .build_output_stream(
            &cable_config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                data.fill(0.0);
                let gap = since(&mut last_read);
                let mut drift = lock(&d);
                drift.note_read_gap(gap);
                drift.read_into(data, cable_channels);
                drop(drift);
                lock(&m).render(Output::Cable, data, cable_channels, cable_rate);
                clip(data);
            },
            on_error("cable", &devices.cable, control),
            None,
        )
        .map_err(|e| open_failed("cable", &devices.cable, e))?;

    // The headphones: the sounds at "You hear", never the user's voice.
    let m = mixer.clone();
    let headphones_stream = headphones
        .build_output_stream(
            &headphones_config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                data.fill(0.0);
                lock(&m).render(Output::Headphones, data, headphones_channels, headphones_rate);
                clip(data);
            },
            on_error("headphones", &devices.headphones, control),
            None,
        )
        .map_err(|e| open_failed("headphones", &devices.headphones, e))?;

    // The microphone: stereo, into the drift buffer (which converts it to
    // the cable's rate).
    let mut frames = Vec::with_capacity(8_192);
    let mut last_push: Option<Instant> = None;
    let d = drift.clone();
    let mic_stream = mic
        .build_input_stream(
            &mic_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                frames.clear();
                mic_frames(data, mic_channels, &mut frames);
                let gap = since(&mut last_push);
                let mut drift = lock(&d);
                drift.note_push_gap(gap);
                drift.push(&frames);
            },
            on_error("microphone", &devices.microphone, control),
            None,
        )
        .map_err(|e| open_failed("microphone", &devices.microphone, e))?;

    for (stream, kind, name) in [
        (&cable_stream, "cable", &devices.cable),
        (&headphones_stream, "headphones", &devices.headphones),
        (&mic_stream, "microphone", &devices.microphone),
    ] {
        stream.play().map_err(|e| open_failed(kind, name, e))?;
    }
    let info = EngineInfo {
        microphone: devices.microphone.clone(),
        cable: devices.cable.clone(),
        headphones: devices.headphones.clone(),
        mic_rate: mic_config.sample_rate.0,
        mic_channels: mic_config.channels,
        cable_rate,
        cable_channels: cable_config.channels,
        headphones_rate,
        headphones_channels: headphones_config.channels,
    };
    Ok((vec![mic_stream, cable_stream, headphones_stream], info))
}

/// Open a prepared WAV (48 kHz stereo 16-bit), read its first 200 ms and
/// keep reading ahead on a thread of its own; `looping`, it goes round (see
/// `Stream`) until the voice ends or the loop is switched off. Returns the
/// shared buffer and the sound's length in frames.
pub fn spawn_reader(wav: &Path, looping: bool) -> Result<(Arc<VoiceShared>, u64), String> {
    let reader = hound::WavReader::open(wav).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    if spec.channels != 2 || spec.sample_rate != SOURCE_RATE || spec.bits_per_sample != 16 {
        return Err("not a prepared sound".to_string());
    }
    let frames = reader.duration() as u64;
    let shared = Arc::new(VoiceShared::default());
    shared.looping.store(looping, Ordering::Relaxed);
    let mut stream = Stream::new(Source::open(reader)?);
    let mut chunk = Vec::with_capacity(FIRST + XFADE as usize);
    let finished = stream.fill(FIRST, &mut chunk, &shared)?;
    {
        let mut buffer = lock(&shared.buffer);
        buffer.push(&chunk);
        if finished {
            buffer.finish();
        }
    }
    if !finished {
        let s = shared.clone();
        std::thread::Builder::new()
            .name("rf-sound-reader".into())
            .spawn(move || read_ahead(stream, s))
            .map_err(|e| e.to_string())?;
    }
    Ok((shared, frames))
}

/// A prepared sound's frames: from its file, or from memory for a sound up
/// to 1.5 s long (looping, it would seek and read every round).
enum Source {
    File { reader: hound::WavReader<BufReader<File>>, pos: u64 },
    Memory { frames: Vec<[f32; 2]>, pos: u64 },
}

impl Source {
    fn open(mut reader: hound::WavReader<BufReader<File>>) -> Result<Source, String> {
        let len = reader.duration() as u64;
        if len > IN_MEMORY {
            return Ok(Source::File { reader, pos: 0 });
        }
        let mut frames = Vec::with_capacity(len as usize);
        read_frames(&mut reader, len as usize, &mut frames)?;
        Ok(Source::Memory { frames, pos: 0 })
    }

    fn len(&self) -> u64 {
        match self {
            Source::File { reader, .. } => reader.duration() as u64,
            Source::Memory { frames, .. } => frames.len() as u64,
        }
    }

    /// The file frame read next.
    fn pos(&self) -> u64 {
        match self {
            Source::File { pos, .. } | Source::Memory { pos, .. } => *pos,
        }
    }

    fn seek(&mut self, to: u64) -> Result<(), String> {
        match self {
            Source::File { reader, pos } => {
                if *pos != to {
                    reader.seek(to as u32).map_err(|e| e.to_string())?;
                    *pos = to;
                }
            }
            Source::Memory { frames, pos } => *pos = to.min(frames.len() as u64),
        }
        Ok(())
    }

    /// Add up to `n` frames to `out`; how many (0 at the end of the file).
    fn read(&mut self, n: usize, out: &mut Vec<[f32; 2]>) -> Result<usize, String> {
        match self {
            Source::File { reader, pos } => {
                let before = out.len();
                read_frames(reader, before + n, out)?;
                *pos += (out.len() - before) as u64;
                Ok(out.len() - before)
            }
            Source::Memory { frames, pos } => {
                let from = *pos as usize;
                let to = (from + n).min(frames.len());
                out.extend_from_slice(&frames[from..to]);
                *pos = to as u64;
                Ok(to - from)
            }
        }
    }
}

/// Where a looping sound goes round: from its first frame of sound to past
/// its last, with a crossfade of `fade` frames at each seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LoopRange {
    start: u64,
    end: u64,
    fade: u64,
}

impl LoopRange {
    /// The frames of each round after the first.
    fn round(&self) -> u64 {
        self.end - self.start - self.fade
    }
}

fn is_sound(frame: &[f32; 2]) -> bool {
    frame[0].abs() >= QUIET || frame[1].abs() >= QUIET
}

/// The loop of `src`: its last frame of sound within its last 2 s and its
/// first within its first 2 s (a quieter edge longer than that is part of
/// the sound, not padding). The position stays where it was. None for a
/// file without frames.
fn find_loop(src: &mut Source, scratch: &mut Vec<[f32; 2]>) -> Result<Option<LoopRange>, String> {
    let back = src.pos();
    let from = src.len().saturating_sub(EDGE_SCAN);
    src.seek(from)?;
    scratch.clear();
    src.read(EDGE_SCAN as usize, scratch)?;
    let read_to = from + scratch.len() as u64;
    let end = scratch.iter().rposition(is_sound).map_or(read_to, |i| from + i as u64 + 1);
    // From the start: padding is short, so this reads a chunk or two.
    src.seek(0)?;
    let (limit, mut start) = (end.min(EDGE_SCAN), 0);
    while src.pos() < limit {
        let at = src.pos();
        scratch.clear();
        if src.read(CHUNK.min((limit - at) as usize), scratch)? == 0 {
            break;
        }
        if let Some(i) = scratch.iter().position(is_sound) {
            start = at + i as u64;
            break;
        }
    }
    src.seek(back)?;
    if end <= start {
        return Ok(None);
    }
    let range = end - start;
    let fade = if range >= 10 * XFADE { XFADE } else { range / 10 };
    Ok(Some(LoopRange { start, end, fade }))
}

/// A voice's frames in the order its buffer numbers them. Not looping: the
/// file. Looping: the first round from frame 0, then round after round
/// between the first and the last frame of sound (a compressed original's
/// padding left out). At each seam the last `fade` frames before the end
/// blend (equal power) into the first after the start, and the round goes
/// on after those; the buffer's numbering stays continuous.
struct Stream {
    src: Source,
    /// The buffer frame made next.
    made: u64,
    lp: Option<LoopRange>,
    /// The loop was looked for.
    searched: bool,
    /// The file frame where the next seam starts.
    seam: u64,
    /// A seam was passed by (the loop is off): the rest of the file, then
    /// the end, whatever the loop switch says from then on.
    to_end: bool,
    head: Vec<[f32; 2]>,
}

impl Stream {
    fn new(src: Source) -> Stream {
        Stream { src, made: 0, lp: None, searched: false, seam: 0, to_end: false, head: Vec::new() }
    }

    /// Make about `n` frames into `out` (a seam's crossfade may add a few
    /// more); true at the end of the sound.
    fn fill(&mut self, n: usize, out: &mut Vec<[f32; 2]>, shared: &VoiceShared) -> Result<bool, String> {
        out.clear();
        while out.len() < n {
            if !self.searched && !self.to_end && shared.looping.load(Ordering::Acquire) {
                self.start_looping(shared)?;
            }
            let seam = match self.lp {
                Some(_) if !self.to_end => self.seam,
                _ => u64::MAX,
            };
            let pos = self.src.pos();
            if pos < seam {
                let want = (seam - pos).min((n - out.len()) as u64) as usize;
                let read = self.src.read(want, out)?;
                if read == 0 {
                    return Ok(true);
                }
                self.made += read as u64;
                continue;
            }
            // At a seam: go round while the loop is on; switched off, until
            // the end the mixer set is read (`end` is set before the loop
            // goes off, so it is seen here with it).
            let looping = shared.looping.load(Ordering::Acquire);
            let end = shared.end.load(Ordering::Acquire);
            if looping || (end != NO_END && self.made < end) {
                self.cross(out)?;
            } else {
                self.to_end = true;
            }
        }
        Ok(false)
    }

    /// Find the loop and tell the mixer where the rounds are, before the
    /// first seam.
    fn start_looping(&mut self, shared: &VoiceShared) -> Result<(), String> {
        self.searched = true;
        let Some(lp) = find_loop(&mut self.src, &mut self.head)? else {
            return Ok(());
        };
        let pos = self.src.pos();
        // Switched on during the fade or the padding at the end: the seam is here.
        self.seam = (lp.end - lp.fade).max(pos);
        self.lp = Some(lp);
        shared.round.store(lp.round(), Ordering::Release);
        shared.first_seam.store(self.made + (self.seam - pos), Ordering::Release);
        Ok(())
    }

    /// A seam: the next `fade` frames fade out while the first after the
    /// loop's start fade in; the round goes on after those.
    fn cross(&mut self, out: &mut Vec<[f32; 2]>) -> Result<(), String> {
        let Some(lp) = self.lp else {
            return Ok(());
        };
        let fade = lp.fade as usize;
        let at = out.len();
        self.src.read(fade, out)?;
        // Past the end of the file: silence.
        out.resize(at + fade, [0.0; 2]);
        self.src.seek(lp.start)?;
        self.head.clear();
        self.src.read(fade, &mut self.head)?;
        self.head.resize(fade, [0.0; 2]);
        for (j, (tail, head)) in out[at..].iter_mut().zip(&self.head).enumerate() {
            let x = (j as f32 + 0.5) / fade as f32 * std::f32::consts::FRAC_PI_2;
            let (fade_out, fade_in) = (x.cos(), x.sin());
            *tail = [tail[0] * fade_out + head[0] * fade_in, tail[1] * fade_out + head[1] * fade_in];
        }
        self.made += lp.fade;
        self.seam = lp.end - lp.fade;
        Ok(())
    }
}

/// Add frames to `out` until it holds `n`; true at the end of the file.
fn read_frames<R: Read>(reader: &mut hound::WavReader<R>, n: usize, out: &mut Vec<[f32; 2]>) -> Result<bool, String> {
    let mut samples = reader.samples::<i16>();
    while out.len() < n {
        let (Some(l), Some(r)) = (samples.next(), samples.next()) else {
            return Ok(true);
        };
        let (l, r) = (l.map_err(|e| e.to_string())?, r.map_err(|e| e.to_string())?);
        out.push([l as f32 / 32768.0, r as f32 / 32768.0]);
    }
    Ok(false)
}

/// Keep about a second ahead of the slower output until the sound ends (a
/// looping sound: the end of the file once the loop is off and the end the
/// mixer set is read) or the voice is over.
fn read_ahead(mut stream: Stream, shared: Arc<VoiceShared>) {
    // Whichever way this thread ends (the end of the file, a read error, the
    // voice or the engine stopping, a panic), the buffer is finished, so the
    // voice can end. A looping sound is never finished while it loops.
    struct Finish(Arc<VoiceShared>);
    impl Drop for Finish {
        fn drop(&mut self) {
            lock(&self.0.buffer).finish();
        }
    }
    let _finish = Finish(shared.clone());
    let mut chunk = Vec::with_capacity(CHUNK + XFADE as usize);
    while !shared.done.load(Ordering::Relaxed) {
        let slowest = shared.slowest();
        let end = {
            let mut buffer = lock(&shared.buffer);
            buffer.trim_before(slowest.saturating_sub(1));
            buffer.end()
        };
        if end >= slowest + AHEAD {
            std::thread::sleep(Duration::from_millis(20));
            continue;
        }
        match stream.fill(CHUNK, &mut chunk, &shared) {
            Ok(finished) => {
                let mut buffer = lock(&shared.buffer);
                buffer.push(&chunk);
                if finished {
                    buffer.finish();
                    return;
                }
            }
            Err(e) => {
                startup_log::log(&format!("[soundboard] reading a sound failed: {}", e));
                return;
            }
        }
    }
}

/// What a capture heard.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Levels {
    /// RMS of the loudest channel.
    pub rms: f32,
    pub peak: f32,
    pub frames: u64,
    pub rate: u32,
    pub channels: u16,
    /// The longest run of frames quieter than -60 dBFS on every channel
    /// between two louder ones (a gap in a sound), in ms.
    pub longest_gap_ms: f32,
    /// The biggest change from one sample to the next on any channel (a
    /// click or a jump).
    pub max_step: f32,
}

/// What `capture_levels` adds up while it records.
#[derive(Clone, Default)]
struct Measure {
    squares: Vec<f64>,
    peak: f32,
    frames: u64,
    last: Vec<f32>,
    heard: bool,
    quiet: u64,
    longest_gap: u64,
    max_step: f32,
}

impl Measure {
    fn add(&mut self, frame: &[f32]) {
        if self.squares.len() < frame.len() {
            self.squares.resize(frame.len(), 0.0);
        }
        let mut loud = false;
        for (c, &v) in frame.iter().enumerate() {
            self.squares[c] += (v as f64).powi(2);
            self.peak = self.peak.max(v.abs());
            loud |= v.abs() >= 0.001;
            if let Some(&before) = self.last.get(c) {
                self.max_step = self.max_step.max((v - before).abs());
            }
        }
        self.last.clear();
        self.last.extend_from_slice(frame);
        if loud {
            if self.heard {
                self.longest_gap = self.longest_gap.max(self.quiet);
            }
            self.heard = true;
            self.quiet = 0;
        } else {
            self.quiet += 1;
        }
        self.frames += 1;
    }
}

/// Record `ms` from an input device, or with `loopback` what an output
/// plays (WASAPI loopback), and measure it. For the live checks.
pub fn capture_levels(device: &str, ms: u64, loopback: bool) -> Result<Levels, String> {
    let host = cpal::default_host();
    let dev = find_device(&host, device, !loopback).ok_or_else(|| format!("'{}' not found", device))?;
    let config = if loopback { dev.default_output_config() } else { dev.default_input_config() }.map_err(|e| e.to_string())?;
    if config.sample_format() != cpal::SampleFormat::F32 {
        return Err(format!("unsupported sample format {:?}", config.sample_format()));
    }
    let channels = config.channels() as usize;
    let sums = Arc::new(Mutex::new(Measure::default()));
    let s = sums.clone();
    let stream = dev
        .build_input_stream(
            &config.config(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let mut sums = lock(&s);
                for frame in data.chunks_exact(channels) {
                    sums.add(frame);
                }
            },
            |e| startup_log::log(&format!("[soundboard] capture test: {}", e)),
            None,
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(ms));
    drop(stream);
    let m = lock(&sums).clone();
    let rms = m.squares.iter().map(|s| (s / m.frames.max(1) as f64).sqrt() as f32).fold(0.0, f32::max);
    let rate = config.sample_rate().0;
    Ok(Levels {
        rms,
        peak: m.peak,
        frames: m.frames,
        rate,
        channels: channels as u16,
        longest_gap_ms: m.longest_gap as f32 * 1000.0 / rate.max(1) as f32,
        max_step: m.max_step,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::soundboard::mixer::FADE_IN_MS;

    fn list() -> DeviceList {
        DeviceList {
            inputs: vec![
                "Microphone (Scarlett Solo USB)".into(),
                "Headset Microphone (USB Headset)".into(),
                "CABLE Output (VB-Audio Virtual Cable)".into(),
            ],
            outputs: vec![
                "Speakers (Scarlett Solo USB)".into(),
                "CABLE In 16 Ch (VB-Audio Virtual Cable)".into(),
                "Speakers (VB-Audio Virtual Cable)".into(),
            ],
            default_input: Some("Microphone (Scarlett Solo USB)".into()),
            default_output: Some("Speakers (Scarlett Solo USB)".into()),
        }
    }

    #[test]
    fn the_cable_is_found_under_its_current_and_older_names() {
        assert_eq!(auto_cable(&list().outputs).as_deref(), Some("Speakers (VB-Audio Virtual Cable)"));
        let older = ["Speakers (Realtek)".to_string(), "CABLE Input (VB-Audio Virtual Cable)".to_string()];
        assert_eq!(auto_cable(&older).as_deref(), Some("CABLE Input (VB-Audio Virtual Cable)"));
        let only_16 = ["CABLE In 16 Ch (VB-Audio Virtual Cable)".to_string()];
        assert_eq!(auto_cable(&only_16).as_deref(), Some("CABLE In 16 Ch (VB-Audio Virtual Cable)"));
        assert_eq!(auto_cable(&["Speakers (Realtek)".to_string()]), None);
        // This PC's names: "16ch", no space, listed after "CABLE Input" or before it.
        let here = ["CABLE In 16ch (VB-Audio Virtual Cable)".to_string(), "CABLE Input (VB-Audio Virtual Cable)".to_string()];
        assert_eq!(auto_cable(&here).as_deref(), Some("CABLE Input (VB-Audio Virtual Cable)"));
    }

    #[test]
    fn saved_devices_win_and_missing_ones_are_named() {
        let automatic = resolve(&Devices::default(), "default", &list()).unwrap();
        assert_eq!(
            automatic,
            EngineDevices {
                microphone: "Microphone (Scarlett Solo USB)".into(),
                cable: "Speakers (VB-Audio Virtual Cable)".into(),
                headphones: "Speakers (Scarlett Solo USB)".into(),
            }
        );
        // The Recording setting's microphone, while it is connected.
        let headset = resolve(&Devices::default(), "Headset Microphone (USB Headset)", &list()).unwrap();
        assert_eq!(headset.microphone, "Headset Microphone (USB Headset)");
        let unplugged = resolve(&Devices::default(), "Old Webcam Mic", &list()).unwrap();
        assert_eq!(unplugged.microphone, "Microphone (Scarlett Solo USB)");
        let chosen = Devices { cable: "CABLE In 16 Ch (VB-Audio Virtual Cable)".into(), ..Devices::default() };
        assert_eq!(resolve(&chosen, "default", &list()).unwrap().cable, "CABLE In 16 Ch (VB-Audio Virtual Cable)");
        let gone = Devices { microphone: "USB Mic".into(), ..Devices::default() };
        assert_eq!(resolve(&gone, "default", &list()), Err(Problem::new("not_connected", "microphone", "USB Mic", "")));
        let mut no_cable = list();
        no_cable.outputs.retain(|n| !n.contains("VB-Audio"));
        assert_eq!(resolve(&Devices::default(), "default", &no_cable), Err(Problem::new("no_cable", "cable", "", "")));
        let mut no_mic = list();
        no_mic.inputs.clear();
        no_mic.default_input = None;
        assert_eq!(resolve(&Devices::default(), "default", &no_mic), Err(Problem::new("no_device", "microphone", "", "")));
        // Windows' default recording device is the cable itself: it would hear itself.
        let mut looped = list();
        looped.default_input = Some("CABLE Output (VB-Audio Virtual Cable)".into());
        assert_eq!(
            resolve(&Devices::default(), "default", &looped),
            Err(Problem::new("mic_is_cable", "microphone", "CABLE Output (VB-Audio Virtual Cable)", ""))
        );
    }

    fn write_wav(path: &Path, frames: u32) {
        let spec = hound::WavSpec { channels: 2, sample_rate: 48_000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for k in 0..frames {
            let v = (k % 1000) as i16 * 16;
            writer.write_sample(v).unwrap();
            writer.write_sample(-v).unwrap();
        }
        writer.finalize().unwrap();
    }

    #[test]
    fn a_long_sound_is_read_ahead_and_played_to_the_end() {
        let dir = std::env::temp_dir().join("rudariflow_sb_reader");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("long.wav");
        write_wav(&wav, 144_000);
        let (shared, frames) = spawn_reader(&wav, false).unwrap();
        assert_eq!(frames, 144_000);
        assert!(lock(&shared.buffer).end() >= FIRST as u64, "the first part is read before it starts");
        let mut mixer = Mixer::new(false, 1.0, 1.0);
        mixer.start("s-long", 1.0, frames, shared.clone());
        let (mut got, mut most) = (Vec::new(), 0usize);
        let mut out = vec![0f32; 960];
        while !mixer.is_idle() {
            let want = shared.slowest() + 480;
            let waited = Instant::now();
            loop {
                let buffer = lock(&shared.buffer);
                most = most.max(buffer.len());
                if buffer.end() >= want || buffer.is_finished() {
                    break;
                }
                drop(buffer);
                assert!(waited.elapsed() < Duration::from_secs(2), "the reader fell behind");
                std::thread::sleep(Duration::from_millis(1));
            }
            out.fill(0.0);
            mixer.render(Output::Cable, &mut out, 2, 48_000);
            got.extend_from_slice(&out);
            out.fill(0.0);
            mixer.render(Output::Headphones, &mut out, 2, 48_000);
        }
        assert!(shared.done.load(Ordering::Relaxed));
        assert!(most as u64 <= AHEAD + (CHUNK + FIRST) as u64, "{} frames held", most);
        // The mixer's 5 ms fade-in (FADE_IN_MS) ramps the first frames.
        let fade_in = (SOURCE_RATE * FADE_IN_MS / 1000) as usize;
        for (k, f) in got.chunks(2).take(144_000).enumerate() {
            let mut v = ((k % 1000) as i16 * 16) as f32 / 32768.0;
            if k < fade_in {
                v *= k as f32 / fade_in as f32;
            }
            assert!((f[0] - v).abs() < 1e-6 && (f[1] + v).abs() < 1e-6, "frame {}: {:?}", k, f);
        }
        assert!(spawn_reader(&dir.join("missing.wav"), false).is_err());
    }

    #[test]
    fn a_lost_device_ends_the_engine_and_ticks_report_the_voices() {
        let mixer = Arc::new(Mutex::new(Mixer::new(false, 1.0, 1.0)));
        let shared = Arc::new(VoiceShared::default());
        lock(&shared.buffer).push(&vec![[0.1, 0.1]; 48_000]);
        lock(&mixer).start("s-a", 1.0, 48_000, shared);
        let (tx, rx) = mpsc::channel();
        let m = mixer.clone();
        let driver = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(350));
            lock(&m).stop_all();
            std::thread::sleep(Duration::from_millis(350));
            tx.send(Control::Lost(Problem::new("lost", "cable", "CABLE", "gone"))).unwrap();
        });
        let mut ticks = Vec::new();
        let lost = run_until_stopped(&rx, &mixer, &mut |voices: Vec<PlayingVoice>| ticks.push(voices.len()));
        driver.join().unwrap();
        assert_eq!(lost, Some(Problem::new("lost", "cable", "CABLE", "gone")));
        // While it plays: one voice per tick; after stop all: one empty tick, then none.
        assert!(ticks.len() >= 3 && ticks[0] == 1, "{:?}", ticks);
        assert_eq!(ticks.iter().filter(|&&n| n == 0).count(), 1, "{:?}", ticks);
        assert_eq!(*ticks.last().unwrap(), 0);
        let (tx, rx) = mpsc::channel();
        tx.send(Control::Stop).unwrap();
        assert_eq!(run_until_stopped(&rx, &mixer, &mut |_| {}), None);
    }

    /// An engine with no devices: `serve` runs exactly as after the streams
    /// opened, with `()` for the streams.
    fn engine_without_devices(on_lost: Box<dyn FnOnce(Problem) + Send>) -> Engine {
        let mixer = Arc::new(Mutex::new(Mixer::new(false, 1.0, 1.0)));
        let ended = Arc::new(AtomicBool::new(false));
        let (control, control_rx) = mpsc::channel();
        let (stopped_tx, stopped) = mpsc::channel();
        let (m, e) = (mixer.clone(), ended.clone());
        let callbacks = Callbacks { on_tick: Box::new(|_| {}), on_lost };
        std::thread::spawn(move || serve((), &control_rx, &m, &e, callbacks, stopped_tx));
        let info = EngineInfo {
            microphone: String::new(),
            cable: String::new(),
            headphones: String::new(),
            mic_rate: 48_000,
            mic_channels: 2,
            cable_rate: 48_000,
            cable_channels: 2,
            headphones_rate: 48_000,
            headphones_channels: 2,
        };
        let drift = Arc::new(Mutex::new(DriftBuffer::new(48_000, 48_000)));
        Engine { generation: 1, control, stopped, mixer, drift, ended, info }
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let since = Instant::now();
        while !done() {
            assert!(since.elapsed() < Duration::from_secs(2), "{}", what);
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn no_sound_starts_after_the_engine_ended() {
        let dir = std::env::temp_dir().join("rudariflow_sb_ended");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("long.wav");
        write_wav(&wav, 144_000);

        // A device is lost: on_lost runs once, the playing voice ends and
        // no new one starts.
        let (lost_tx, lost_rx) = mpsc::channel();
        let engine = engine_without_devices(Box::new(move |p| lost_tx.send(p).unwrap()));
        engine.start_voice("s-a", 1.0, &wav, false).unwrap();
        let playing = engine.with_mixer(|m| m.playing().len());
        assert_eq!(playing, 1);
        engine.control.send(Control::Lost(Problem::new("lost", "cable", "CABLE", "gone"))).unwrap();
        let problem = lost_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(problem, Problem::new("lost", "cable", "CABLE", "gone"));
        assert!(engine.with_mixer(|m| m.is_idle()), "the voices end with the engine");
        assert_eq!(engine.start_voice("s-b", 1.0, &wav, true), Err("engine_stopped".to_string()));
        assert!(engine.with_mixer(|m| m.is_idle()));
        assert!(lost_rx.recv_timeout(Duration::from_millis(200)).is_err(), "on_lost runs once");
        engine.stop();

        // Stopped (the thread ended): the same.
        let engine = engine_without_devices(Box::new(|_| panic!("not lost")));
        engine.control.send(Control::Stop).unwrap();
        wait_until("the engine thread ends", || engine.ended.load(Ordering::Relaxed));
        assert_eq!(engine.start_voice("s-c", 1.0, &wav, false), Err("engine_stopped".to_string()));
        engine.stop();
    }

    #[test]
    fn a_reader_finishes_when_its_voice_or_the_engine_ends() {
        let dir = std::env::temp_dir().join("rudariflow_sb_reader_exit");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("five_seconds.wav");
        write_wav(&wav, 240_000);

        // The voice is over: its reader stops and finishes the buffer.
        let (shared, frames) = spawn_reader(&wav, false).unwrap();
        assert_eq!(frames, 240_000);
        assert!(!lock(&shared.buffer).is_finished(), "5 s do not fit in the first chunk");
        shared.done.store(true, Ordering::Relaxed);
        wait_until("the reader finishes after done", || lock(&shared.buffer).is_finished());
        assert!(lock(&shared.buffer).end() < frames, "it stopped before the end of the file");

        // The engine ends: Mixer::clear marks every voice done.
        let (shared, frames) = spawn_reader(&wav, false).unwrap();
        let mut mixer = Mixer::new(false, 1.0, 1.0);
        mixer.start("s-long", 1.0, frames, shared.clone());
        assert!(!lock(&shared.buffer).is_finished());
        mixer.clear();
        wait_until("the reader finishes after clear", || lock(&shared.buffer).is_finished());

        // Dropping the mixer does the same.
        let (shared, frames) = spawn_reader(&wav, false).unwrap();
        let mut mixer = Mixer::new(false, 1.0, 1.0);
        mixer.start("s-long", 1.0, frames, shared.clone());
        drop(mixer);
        wait_until("the reader finishes after the mixer is dropped", || lock(&shared.buffer).is_finished());
    }

    fn write_frames(path: &Path, frames: &[[i16; 2]]) {
        let spec = hound::WavSpec { channels: 2, sample_rate: 48_000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for f in frames {
            writer.write_sample(f[0]).unwrap();
            writer.write_sample(f[1]).unwrap();
        }
        writer.finalize().unwrap();
    }

    /// `frames` frames of [16 k, -16 k] (k up to 2000): every frame differs,
    /// and frames 0 to 2 are quieter than -60 dBFS.
    fn ramp(frames: u32) -> Vec<[i16; 2]> {
        (0..frames).map(|k| [((k % 2_000) * 16) as i16, -(((k % 2_000) * 16) as i16)]).collect()
    }

    fn write_ramp(path: &Path, frames: u32) {
        write_frames(path, &ramp(frames));
    }

    fn as_f32(frames: &[[i16; 2]]) -> Vec<[f32; 2]> {
        frames.iter().map(|f| [f[0] as f32 / 32768.0, f[1] as f32 / 32768.0]).collect()
    }

    /// What a looping sound plays, worked out here on its own: the file up
    /// to `end - fade`, then rounds of an equal-power crossfade from the
    /// `fade` frames before `end` into those from `start`, and the frames up
    /// to `end - fade` again. With the mixer's fade-in.
    fn looped_stream(file: &[[f32; 2]], start: usize, end: usize, fade: usize, len: usize) -> Vec<[f32; 2]> {
        let mut out = file[..end - fade].to_vec();
        while out.len() < len {
            for j in 0..fade {
                let x = (j as f32 + 0.5) / fade as f32 * std::f32::consts::FRAC_PI_2;
                let (t, h) = (file[end - fade + j], file[start + j]);
                out.push([t[0] * x.cos() + h[0] * x.sin(), t[1] * x.cos() + h[1] * x.sin()]);
            }
            out.extend_from_slice(&file[start + fade..end - fade]);
        }
        out.truncate(len);
        let fade_in = (SOURCE_RATE * FADE_IN_MS / 1000) as usize;
        for (k, f) in out.iter_mut().enumerate().take(fade_in) {
            let g = k as f32 / fade_in as f32;
            *f = [f[0] * g, f[1] * g];
        }
        out
    }

    /// The frames of interleaved stereo `got` match `want` from frame `from` to `to`.
    fn matches(got: &[f32], want: &[[f32; 2]], from: usize, to: usize, what: &str) {
        for k in from..to {
            let (g, w) = ([got[2 * k], got[2 * k + 1]], want[k]);
            assert!((g[0] - w[0]).abs() < 1e-5 && (g[1] - w[1]).abs() < 1e-5, "{}: frame {}: {:?} vs {:?}", what, k, g, w);
        }
    }

    /// Render both outputs 10 ms at a time, as the devices would, waiting
    /// for the reader; the cable's frames are added to `got`. Stops after
    /// `frames` frames or when the voice ended.
    fn play_for(mixer: &mut Mixer, shared: &VoiceShared, frames: usize, got: &mut Vec<f32>) {
        let mut out = vec![0f32; 960];
        let until = got.len() / 2 + frames;
        while got.len() / 2 < until && !mixer.is_idle() {
            let want = shared.slowest() + 480;
            wait_until("the reader keeps up", || {
                let buffer = lock(&shared.buffer);
                buffer.end() >= want || buffer.is_finished()
            });
            out.fill(0.0);
            mixer.render(Output::Cable, &mut out, 2, 48_000);
            got.extend_from_slice(&out);
            out.fill(0.0);
            mixer.render(Output::Headphones, &mut out, 2, 48_000);
        }
    }

    /// Render 10 ms of one output once the reader has them; added to `got`.
    fn block(mixer: &mut Mixer, shared: &VoiceShared, output: Output, got: &mut Vec<f32>) {
        let want = shared.played[output as usize].load(Ordering::Relaxed) + 481;
        wait_until("the reader keeps up", || {
            let buffer = lock(&shared.buffer);
            buffer.end() >= want || buffer.is_finished()
        });
        let mut out = vec![0f32; 960];
        mixer.render(output, &mut out, 2, 48_000);
        got.extend_from_slice(&out);
    }

    #[test]
    fn a_short_looping_sound_repeats_without_a_gap_until_its_loop_is_off() {
        let dir = std::env::temp_dir().join("rudariflow_sb_loop_short");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("short.wav");
        // 1100 frames (about 23 ms): shorter than a chunk and the first read.
        const LEN: usize = 1_100;
        write_ramp(&wav, LEN as u32);
        let (shared, frames) = spawn_reader(&wav, true).unwrap();
        assert_eq!(frames, LEN as u64);
        assert!(lock(&shared.buffer).end() >= FIRST as u64, "the first read goes round the sound");
        // Frames 0 to 2 are quiet: the loop is frames 3 to 1099, crossfaded
        // over a tenth of that (109 frames). The first seam is at 1100 - 109.
        let (start, end, fade) = (3, LEN, 109);
        assert_eq!(shared.first_seam.load(Ordering::Relaxed), (end - fade) as u64);
        assert_eq!(shared.round.load(Ordering::Relaxed), (end - start - fade) as u64);
        let mut mixer = Mixer::new(false, 1.0, 1.0);
        mixer.start("s-short", 1.0, frames, shared.clone());
        let mut got = Vec::new();
        // 3 s: far more than the read-ahead, so the buffer is trimmed as it plays.
        play_for(&mut mixer, &shared, 144_000, &mut got);
        assert_eq!(got.len() / 2, 144_000, "it never ended");
        assert!(!lock(&shared.buffer).is_finished(), "never finished while it loops");
        let most = lock(&shared.buffer).len();
        assert!(most as u64 <= AHEAD + (CHUNK + FIRST) as u64 + XFADE, "{} frames held", most);
        let want = looped_stream(&as_f32(&ramp(LEN as u32)), start, end, fade, 200_000);
        matches(&got, &want, 0, 144_000, "looping");
        let progress = mixer.playing()[0].clone();
        let round = (end - start - fade) as u64;
        let within = (144_000 - (end - fade) as u64) % round;
        assert_eq!((progress.duration_ms, progress.pos_ms), (round * 1000 / 48_000, within * 1000 / 48_000), "the progress wraps per round");

        // The loop is switched off: the round that plays is the last.
        let played = got.len() / 2;
        mixer.set_sound_loop("s-short", false);
        let stop = shared.end.load(Ordering::Relaxed) as usize;
        assert_eq!(stop, played + (round - within) as usize, "the end of this round");
        play_for(&mut mixer, &shared, 96_000, &mut got);
        assert!(mixer.is_idle(), "it ended");
        // Up to the 15 ms fade-out into that end, then silence.
        matches(&got, &want, played, stop - 720, "the last round");
        for k in stop - 720..stop {
            assert!(got[2 * k].abs() <= want[k][0].abs() + 1e-6, "frame {} fades", k);
        }
        assert!(got[2 * stop..].iter().all(|&s| s == 0.0));
        wait_until("its reader finishes", || lock(&shared.buffer).is_finished());
    }

    #[test]
    fn padding_is_left_out_of_the_loop_and_the_seam_is_crossfaded() {
        let dir = std::env::temp_dir().join("rudariflow_sb_loop_padding");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("padded.wav");
        // As an MP3 decodes: 1355 silent frames, 0.5 s of a 440 Hz tone (not whole periods) that
        // starts at -0.37, 950 silent frames.
        let (lead, body, trail) = (1_355usize, 24_050usize, 950usize);
        let w = 2.0 * std::f64::consts::PI * 440.0 / 48_000.0;
        let phase = (-0.74f64).asin();
        let mut file = vec![[0i16; 2]; lead];
        for k in 0..body {
            let v = (0.5 * (phase + w * k as f64).sin() * 32_767.0) as i16;
            file.push([v, -v]);
        }
        file.extend(vec![[0i16; 2]; trail]);
        write_frames(&wav, &file);
        let pcm = as_f32(&file);
        let loud = |f: &[f32; 2]| f[0].abs() >= QUIET || f[1].abs() >= QUIET;
        let start = pcm.iter().position(loud).unwrap();
        let end = pcm.iter().rposition(loud).unwrap() + 1;
        assert_eq!(start, lead);
        assert!(end > lead + body - 3, "{}", end);
        assert!((pcm[end - 1][0] - pcm[start][0]).abs() > 0.3, "going round as it is would jump");

        let (shared, frames) = spawn_reader(&wav, true).unwrap();
        assert_eq!(shared.first_seam.load(Ordering::Relaxed), (end - 480) as u64);
        assert_eq!(shared.round.load(Ordering::Relaxed), (end - start - 480) as u64);
        let mut mixer = Mixer::new(false, 1.0, 1.0);
        mixer.start("s-padded", 1.0, frames, shared.clone());
        let mut got = Vec::new();
        play_for(&mut mixer, &shared, 144_000, &mut got);
        let want = looped_stream(&pcm, start, end, 480, 144_000);
        matches(&got, &want, 0, 144_000, "padded");
        // The first round starts at frame 0, its padding included; after it
        // no silence and no jump bigger than the tone's own steps and the
        // crossfade's (0.5 * w per frame, plus pi/2 / 480 of the amplitude).
        let (mut quiet_run, mut longest, mut jump) = (0, 0, 0f32);
        // (The file itself jumps at frame 1355, from its padding to -0.37.)
        for k in lead + 1..144_000 {
            quiet_run = if got[2 * k].abs() < QUIET { quiet_run + 1 } else { 0 };
            longest = longest.max(quiet_run);
            jump = jump.max((got[2 * k] - got[2 * k - 2]).abs());
        }
        assert!(longest <= 2, "{} silent frames in a row", longest);
        assert!(jump < 0.05, "a jump of {}", jump);
        mixer.stop_all();
        play_for(&mut mixer, &shared, 4_800, &mut got);
        assert!(mixer.is_idle());
    }

    #[test]
    fn a_loop_switched_off_with_the_outputs_in_different_rounds_ends_both_at_one_frame() {
        let dir = std::env::temp_dir().join("rudariflow_sb_loop_rounds");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("long.wav");
        // 1.6 s, read from the file a chunk at a time, never silent.
        const LEN: usize = 76_800;
        let file: Vec<[i16; 2]> = (0..LEN).map(|k| [((k % 1_000) as i16 + 100) * 16, -((k % 1_000) as i16 + 100) * 16]).collect();
        write_frames(&wav, &file);
        let (shared, frames) = spawn_reader(&wav, true).unwrap();
        let seam = LEN - 480;
        assert_eq!(shared.first_seam.load(Ordering::Relaxed), seam as u64);
        let mut mixer = Mixer::new(false, 1.0, 1.0);
        mixer.start("s-long", 1.0, frames, shared.clone());
        let (mut cable, mut phones) = (Vec::new(), Vec::new());
        // Both to 60000, then the cable on to 80000: the seam at 76320 is
        // between them (0.42 s apart, within the reader's second ahead).
        while shared.played[1].load(Ordering::Relaxed) < 60_000 {
            block(&mut mixer, &shared, Output::Cable, &mut cable);
            block(&mut mixer, &shared, Output::Headphones, &mut phones);
        }
        while shared.played[0].load(Ordering::Relaxed) < 80_000 {
            block(&mut mixer, &shared, Output::Cable, &mut cable);
        }
        mixer.set_sound_loop("s-long", false);
        // The end of the cable's round: the next seam, a round after the first.
        let stop = 2 * seam;
        assert_eq!(shared.end.load(Ordering::Relaxed), stop as u64);
        let mut blocks = 0;
        while !mixer.is_idle() {
            block(&mut mixer, &shared, Output::Cable, &mut cable);
            block(&mut mixer, &shared, Output::Headphones, &mut phones);
            blocks += 1;
            assert!(blocks < 300, "the voice never ended");
        }
        assert_eq!(shared.played[0].load(Ordering::Relaxed), stop as u64);
        assert_eq!(shared.played[1].load(Ordering::Relaxed), stop as u64);
        let want = looped_stream(&as_f32(&file), 0, LEN, 480, 2 * LEN);
        for (got, what) in [(&cable, "cable"), (&phones, "headphones")] {
            matches(got, &want, 0, stop - 720, what);
            assert!(got[2 * stop..].iter().all(|&s| s == 0.0), "{} is silent after the end", what);
        }
        wait_until("its reader finishes", || lock(&shared.buffer).is_finished());
    }

    #[test]
    fn a_loop_switched_on_while_it_plays_goes_round_from_the_next_seam() {
        let dir = std::env::temp_dir().join("rudariflow_sb_loop_on");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("long.wav");
        const LEN: usize = 76_800;
        let file: Vec<[i16; 2]> = (0..LEN).map(|k| [((k % 1_000) as i16 + 100) * 16, 0]).collect();
        write_frames(&wav, &file);
        let (shared, frames) = spawn_reader(&wav, false).unwrap();
        let mut mixer = Mixer::new(false, 1.0, 1.0);
        mixer.start("s-long", 1.0, frames, shared.clone());
        let mut got = Vec::new();
        play_for(&mut mixer, &shared, 9_600, &mut got);
        assert_eq!(shared.first_seam.load(Ordering::Relaxed), 0, "not looked for while it does not loop");
        mixer.set_sound_loop("s-long", true);
        play_for(&mut mixer, &shared, 3 * LEN, &mut got);
        assert!(!mixer.is_idle(), "it goes round");
        assert_eq!(shared.first_seam.load(Ordering::Relaxed), (LEN - 480) as u64);
        let want = looped_stream(&as_f32(&file), 0, LEN, 480, got.len() / 2);
        matches(&got, &want, 0, got.len() / 2, "switched on");
        mixer.stop_all();
        play_for(&mut mixer, &shared, 4_800, &mut got);
        assert!(mixer.is_idle());
    }

    #[test]
    fn a_looping_reader_stops_when_its_voice_or_the_engine_ends() {
        let dir = std::env::temp_dir().join("rudariflow_sb_loop_exit");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("short.wav");
        write_ramp(&wav, 2_000);

        // Nothing plays it: the reader fills a second ahead and waits there.
        let (shared, _) = spawn_reader(&wav, true).unwrap();
        wait_until("the reader reads ahead", || lock(&shared.buffer).end() >= AHEAD);
        std::thread::sleep(Duration::from_millis(100));
        assert!(!lock(&shared.buffer).is_finished());
        assert!(lock(&shared.buffer).end() < AHEAD + CHUNK as u64 + 2_000, "it waits a second ahead");
        shared.done.store(true, Ordering::Relaxed);
        wait_until("the reader finishes after done", || lock(&shared.buffer).is_finished());

        // Stopped, it fades out and ends, and its reader with it.
        let (shared, frames) = spawn_reader(&wav, true).unwrap();
        let mut mixer = Mixer::new(false, 1.0, 1.0);
        mixer.start("s-short", 1.0, frames, shared.clone());
        let mut got = Vec::new();
        play_for(&mut mixer, &shared, 9_600, &mut got);
        assert!(mixer.stop_sound("s-short"));
        play_for(&mut mixer, &shared, 4_800, &mut got);
        assert!(mixer.is_idle());
        wait_until("the reader finishes after stop", || lock(&shared.buffer).is_finished());

        // The engine ends (Mixer::clear), or the mixer is dropped.
        for drop_it in [false, true] {
            let (shared, frames) = spawn_reader(&wav, true).unwrap();
            let mut mixer = Mixer::new(false, 1.0, 1.0);
            mixer.start("s-short", 1.0, frames, shared.clone());
            if drop_it {
                drop(mixer);
            } else {
                mixer.clear();
            }
            wait_until("the reader finishes after the engine ends", || lock(&shared.buffer).is_finished());
        }

        // A sound read in its first chunk starts no reader; looping, it does
        // and finishes once its loop is off: at its next seam it reads the
        // rest of the file (frames 1801 to 1999) and ends.
        let (shared, _) = spawn_reader(&wav, false).unwrap();
        assert!(lock(&shared.buffer).is_finished());
        let (shared, _) = spawn_reader(&wav, true).unwrap();
        let (first, round) = (shared.first_seam.load(Ordering::Relaxed), shared.round.load(Ordering::Relaxed));
        assert_eq!((first, round), (1_801, 1_798), "frames 0 to 2 are quiet; a 199-frame crossfade");
        shared.looping.store(false, Ordering::Relaxed);
        wait_until("the reader finishes at the end of the file", || lock(&shared.buffer).is_finished());
        let end = lock(&shared.buffer).end();
        assert_eq!((end - first - 199) % round, 0, "the rest of the file after a seam: {}", end);
    }

    #[test]
    fn a_capture_measures_gaps_between_sounds_and_the_biggest_step() {
        let mut m = Measure::default();
        // Quiet before the sound starts and after it ends is no gap.
        for v in [0.0, 0.0, 0.5, 0.4, 0.0, 0.0, 0.0, 0.3, 0.0005, 0.0] {
            m.add(&[v, -v]);
        }
        assert_eq!((m.longest_gap, m.frames), (3, 10));
        assert!((m.max_step - 0.5).abs() < 1e-6, "0 to 0.5: {}", m.max_step);
    }

    #[test]
    fn a_short_sound_is_read_into_memory_and_a_long_one_from_its_file() {
        let dir = std::env::temp_dir().join("rudariflow_sb_memory");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (frames, memory) in [(72_000u32, true), (72_001, false)] {
            let wav = dir.join(format!("{}.wav", frames));
            write_ramp(&wav, frames);
            let source = Source::open(hound::WavReader::open(&wav).unwrap()).unwrap();
            assert_eq!(matches!(source, Source::Memory { .. }), memory, "{} frames", frames);
            assert_eq!(source.len(), frames as u64);
        }
    }
}
