//! The soundboard's devices. While the virtual microphone is on, three
//! cpal streams (WASAPI shared mode, each device's own format) run on the
//! "rf-soundboard" thread: the microphone in, the virtual cable out
//! (microphone + sounds) and the headphones out (sounds only). Every
//! playing sound has a reader thread that keeps about a second of it in
//! memory, so no audio callback touches a file.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

use super::drift::{mic_frames, DriftBuffer, DriftStats, Resampler};
use super::library::Devices;
use super::mixer::{Mixer, Output, PlayingVoice, VoiceShared, SOURCE_RATE};
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
        let drift = Arc::new(Mutex::new(DriftBuffer::new(SOURCE_RATE)));
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
    /// starts; the rest on a reader thread).
    /// "engine_stopped" once the engine has ended (a device was lost).
    pub fn start_voice(&self, sound_id: &str, volume: f32, wav: &Path) -> Result<(), String> {
        const STOPPED: &str = "engine_stopped";
        if self.ended.load(Ordering::Acquire) {
            return Err(STOPPED.to_string());
        }
        let (shared, frames) = spawn_reader(wav)?;
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
    *lock(drift) = DriftBuffer::new(cable_rate);

    // The cable: the microphone and the sounds at "Others hear".
    let (m, d) = (mixer.clone(), drift.clone());
    let cable_stream = cable
        .build_output_stream(
            &cable_config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                data.fill(0.0);
                lock(&d).read_into(data, cable_channels);
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

    // The microphone: stereo at the cable's rate, into the drift buffer.
    let mut resampler = Resampler::new(mic_config.sample_rate.0, cable_rate);
    let (mut frames, mut converted) = (Vec::with_capacity(8_192), Vec::with_capacity(8_192));
    let d = drift.clone();
    let mic_stream = mic
        .build_input_stream(
            &mic_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                frames.clear();
                converted.clear();
                mic_frames(data, mic_channels, &mut frames);
                resampler.process(&frames, &mut converted);
                lock(&d).push(&converted);
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
/// keep reading ahead on a thread of its own. Returns the shared buffer and
/// the sound's length in frames.
pub fn spawn_reader(wav: &Path) -> Result<(Arc<VoiceShared>, u64), String> {
    let mut reader = hound::WavReader::open(wav).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    if spec.channels != 2 || spec.sample_rate != SOURCE_RATE || spec.bits_per_sample != 16 {
        return Err("not a prepared sound".to_string());
    }
    let frames = reader.duration() as u64;
    let shared = Arc::new(VoiceShared::default());
    let mut chunk = Vec::with_capacity(FIRST);
    let finished = read_frames(&mut reader, FIRST, &mut chunk)?;
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
            .spawn(move || read_ahead(reader, s))
            .map_err(|e| e.to_string())?;
    }
    Ok((shared, frames))
}

/// Read up to `n` frames into `out`; true at the end of the file.
fn read_frames<R: std::io::Read>(reader: &mut hound::WavReader<R>, n: usize, out: &mut Vec<[f32; 2]>) -> Result<bool, String> {
    out.clear();
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

/// Keep about a second ahead of the slower output until the file ends or
/// the voice is over.
fn read_ahead(mut reader: hound::WavReader<BufReader<File>>, shared: Arc<VoiceShared>) {
    // Whichever way this thread ends (the end of the file, a read error, the
    // voice or the engine stopping, a panic), the buffer is finished, so the
    // voice can end.
    struct Finish(Arc<VoiceShared>);
    impl Drop for Finish {
        fn drop(&mut self) {
            lock(&self.0.buffer).finish();
        }
    }
    let _finish = Finish(shared.clone());
    let mut chunk = Vec::with_capacity(CHUNK);
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
        match read_frames(&mut reader, CHUNK, &mut chunk) {
            Ok(finished) => {
                let mut buffer = lock(&shared.buffer);
                buffer.push(&chunk);
                if finished {
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
    let sums = Arc::new(Mutex::new((vec![0f64; channels], 0f32, 0u64)));
    let s = sums.clone();
    let stream = dev
        .build_input_stream(
            &config.config(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let mut sums = lock(&s);
                for frame in data.chunks_exact(channels) {
                    for (c, v) in frame.iter().enumerate() {
                        sums.0[c] += (*v as f64).powi(2);
                        sums.1 = sums.1.max(v.abs());
                    }
                    sums.2 += 1;
                }
            },
            |e| startup_log::log(&format!("[soundboard] capture test: {}", e)),
            None,
        )
        .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(ms));
    drop(stream);
    let (squares, peak, frames) = lock(&sums).clone();
    let rms = squares.iter().map(|s| (s / frames.max(1) as f64).sqrt() as f32).fold(0.0, f32::max);
    Ok(Levels { rms, peak, frames, rate: config.sample_rate().0, channels: channels as u16 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::soundboard::mixer::FADE_IN_MS;
    use std::time::Instant;

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
        let (shared, frames) = spawn_reader(&wav).unwrap();
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
        assert!(spawn_reader(&dir.join("missing.wav")).is_err());
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
        let drift = Arc::new(Mutex::new(DriftBuffer::new(48_000)));
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
        engine.start_voice("s-a", 1.0, &wav).unwrap();
        let playing = engine.with_mixer(|m| m.playing().len());
        assert_eq!(playing, 1);
        engine.control.send(Control::Lost(Problem::new("lost", "cable", "CABLE", "gone"))).unwrap();
        let problem = lost_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(problem, Problem::new("lost", "cable", "CABLE", "gone"));
        assert!(engine.with_mixer(|m| m.is_idle()), "the voices end with the engine");
        assert_eq!(engine.start_voice("s-b", 1.0, &wav), Err("engine_stopped".to_string()));
        assert!(engine.with_mixer(|m| m.is_idle()));
        assert!(lost_rx.recv_timeout(Duration::from_millis(200)).is_err(), "on_lost runs once");
        engine.stop();

        // Stopped (the thread ended): the same.
        let engine = engine_without_devices(Box::new(|_| panic!("not lost")));
        engine.control.send(Control::Stop).unwrap();
        wait_until("the engine thread ends", || engine.ended.load(Ordering::Relaxed));
        assert_eq!(engine.start_voice("s-c", 1.0, &wav), Err("engine_stopped".to_string()));
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
        let (shared, frames) = spawn_reader(&wav).unwrap();
        assert_eq!(frames, 240_000);
        assert!(!lock(&shared.buffer).is_finished(), "5 s do not fit in the first chunk");
        shared.done.store(true, Ordering::Relaxed);
        wait_until("the reader finishes after done", || lock(&shared.buffer).is_finished());
        assert!(lock(&shared.buffer).end() < frames, "it stopped before the end of the file");

        // The engine ends: Mixer::clear marks every voice done.
        let (shared, frames) = spawn_reader(&wav).unwrap();
        let mut mixer = Mixer::new(false, 1.0, 1.0);
        mixer.start("s-long", 1.0, frames, shared.clone());
        assert!(!lock(&shared.buffer).is_finished());
        mixer.clear();
        wait_until("the reader finishes after clear", || lock(&shared.buffer).is_finished());

        // Dropping the mixer does the same.
        let (shared, frames) = spawn_reader(&wav).unwrap();
        let mut mixer = Mixer::new(false, 1.0, 1.0);
        mixer.start("s-long", 1.0, frames, shared.clone());
        drop(mixer);
        wait_until("the reader finishes after the mixer is dropped", || lock(&shared.buffer).is_finished());
    }
}
