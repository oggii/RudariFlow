//! Recording a meeting: the microphone and WASAPI loopback of Windows'
//! default output (what the PC plays), each its own shared-mode cpal
//! stream. The callbacks only copy into a buffer; the "rf-meeting-capture"
//! thread converts both to 16 kHz mono and appends them to `you.wav` and
//! `others.wav` every second, fills silence where a track fell behind the
//! clock (the loopback sends nothing while the PC is quiet), moves the
//! loopback to a new default output, and reopens a lost device every 3 s.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

use super::store::Track;
use super::wav::{TrackFile, RATE};
use crate::audio::lock;
use crate::soundboard::engine::{boost_this_thread, find_device, MmcssGuard};
use crate::startup_log;

const TICK: Duration = Duration::from_millis(250);
const WRITE_EVERY: Duration = Duration::from_secs(1);
/// A lost device is tried again this often, and the default output is
/// looked at as often.
pub const RETRY: Duration = Duration::from_secs(3);
/// The callbacks' buffer holds this much, so a slow write or a device that
/// takes long to open loses nothing.
const INBOX_SECS: u32 = 30;
/// A track further behind the clock than this gets silence.
const SLACK: u64 = RATE as u64 / 2;
/// No PC sound by then: the bar asks whether the call plays on this PC.
pub const NO_PC_SOUND_AFTER: Duration = Duration::from_secs(30);
/// Quieter than this is silence.
const HEARD: f32 = 0.001;

/// What the meeting bar warns about while it records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Warning {
    /// "Microphone lost — retrying"
    MicLost,
    /// "PC sound lost — retrying"
    PcLost,
    /// "No sound from the PC yet — is the call playing on this PC?"
    NoPcSound,
    /// "The recording can't be saved — is the disk full?" (a track's file
    /// refused audio; that track ends there, the other one goes on).
    WriteFailed,
}

fn lost_warning(track: Track) -> Warning {
    match track {
        Track::You => Warning::MicLost,
        Track::Others => Warning::PcLost,
    }
}

/// Linear interpolation from one rate to another, in chunks: the position
/// carries over from one chunk to the next, so a track cut into seconds
/// comes out as long as it would in one go.
pub struct Resampler {
    ratio: f64,
    /// Where the next output sample lies, in input samples from the start
    /// of the next chunk (-1 … 0: between the last chunk's end and it).
    pos: f64,
    prev: f32,
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Resampler {
        Resampler { ratio: from as f64 / to as f64, pos: 0.0, prev: 0.0 }
    }

    /// Convert the next `input` and append it to `out`.
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        let last = (input.len() - 1) as f64;
        while self.pos <= last {
            let i = self.pos.floor();
            let frac = (self.pos - i) as f32;
            let a = if i < 0.0 { self.prev } else { input[i as usize] };
            let b = input.get((i + 1.0) as usize).copied().unwrap_or(a);
            out.push(a + (b - a) * frac);
            self.pos += self.ratio;
        }
        self.pos -= input.len() as f64;
        self.prev = input[input.len() - 1];
    }
}

/// What one write appends to a track: its new audio, then silence up to
/// the clock when it is more than `SLACK` behind, never past `max`.
pub fn to_append(new: &mut Vec<f32>, written: u64, expected: u64, max: u64) -> Vec<f32> {
    let mut out = std::mem::take(new);
    let have = written + out.len() as u64;
    if expected > have + SLACK {
        out.resize(out.len() + (expected - have) as usize, 0.0);
    }
    out.truncate(max.saturating_sub(written) as usize);
    out
}

/// The test-only stand-in for "what the PC plays": the output device
/// `RUDARIFLOW_MEETING_LOOPBACK` names, honoured only with
/// RUDARIFLOW_TEST_COMMANDS=1. The live checks point it at the virtual
/// cable, so their test audio never plays on the user's speakers.
pub fn loopback_override() -> Option<String> {
    override_from(
        std::env::var("RUDARIFLOW_TEST_COMMANDS").ok().as_deref(),
        std::env::var("RUDARIFLOW_MEETING_LOOPBACK").ok().as_deref(),
    )
}

pub fn override_from(test_commands: Option<&str>, device: Option<&str>) -> Option<String> {
    let device = device.map(str::trim).filter(|d| !d.is_empty())?;
    (test_commands == Some("1")).then(|| device.to_string())
}

/// How many samples of each track are on disk.
#[derive(Debug, Default)]
pub struct Written([AtomicU64; 2]);

impl Written {
    pub fn get(&self, track: Track) -> u64 {
        self.0[track.index()].load(SeqCst)
    }

    fn set(&self, track: Track, samples: u64) {
        self.0[track.index()].store(samples, SeqCst);
    }
}

/// What to record where.
pub struct Setup {
    /// The Recording setting's microphone ("default" = Windows' default).
    pub microphone: String,
    /// `loopback_override()`; `None` = Windows' default output.
    pub loopback: Option<String>,
    pub you: PathBuf,
    pub others: PathBuf,
    /// The meeting stops at this many samples (4 hours).
    pub max_samples: u64,
}

/// A warning comes (`true`) or goes (`false`).
pub type Report = Box<dyn Fn(Warning, bool) + Send>;

pub struct Capture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<u64>>,
    pub written: Arc<Written>,
}

impl Capture {
    /// Create both WAV files and start recording. A device that does not
    /// open is reported and tried again; the other track records anyway.
    /// `on_limit` is called once `max_samples` are recorded.
    pub fn start(setup: Setup, report: Report, on_limit: Box<dyn FnOnce() + Send>) -> Result<Capture, String> {
        let files = [TrackFile::create(&setup.you)?, TrackFile::create(&setup.others)?];
        let stop = Arc::new(AtomicBool::new(false));
        let written = Arc::new(Written::default());
        let (s, w) = (stop.clone(), written.clone());
        let thread = std::thread::Builder::new()
            .name("rf-meeting-capture".into())
            .spawn(move || run(setup, files, s, w, report, on_limit))
            .map_err(|e| e.to_string())?;
        Ok(Capture { stop, thread: Some(thread), written })
    }

    /// Stop, write what is left and the WAV headers. Returns the samples of
    /// the longer track.
    pub fn stop(mut self) -> u64 {
        self.stop.store(true, SeqCst);
        self.thread.take().map_or(0, |t| t.join().unwrap_or(0))
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// The callbacks' side: mono samples at the device's rate.
struct Inbox {
    samples: Mutex<Vec<f32>>,
    failed: AtomicBool,
}

/// An open stream of one track.
struct Input {
    _stream: cpal::Stream,
    inbox: Arc<Inbox>,
    /// Swapped with the inbox's buffer, so neither side allocates.
    spare: Vec<f32>,
    resampler: Resampler,
    device: String,
}

impl Input {
    /// Move what the callbacks collected to `out` at 16 kHz.
    fn drain(&mut self, out: &mut Vec<f32>) {
        std::mem::swap(&mut *lock(&self.inbox.samples), &mut self.spare);
        self.resampler.push(&self.spare, out);
        self.spare.clear();
    }
}

/// A track's file. Its first failed append ends it: part of that append
/// may be on disk without being counted, so anything appended after it
/// would sit at the wrong place.
struct Sink {
    file: TrackFile,
    failed: bool,
}

impl Sink {
    /// Append `new` (and silence up to the clock, see `to_append`). `Err`
    /// only for the append that fails; after it `new` is dropped.
    fn write(&mut self, new: &mut Vec<f32>, expected: u64, max: u64) -> Result<(), String> {
        if self.failed {
            new.clear();
            return Ok(());
        }
        let append = to_append(new, self.file.samples(), expected, max);
        self.file.append(&append).inspect_err(|_| self.failed = true)
    }
}

fn mic_device(host: &cpal::Host, name: &str) -> Result<cpal::Device, String> {
    let device = if name.is_empty() || name == "default" { host.default_input_device() } else { find_device(host, name, true) };
    device.ok_or_else(|| format!("microphone '{}' not found", name))
}

fn pc_device(host: &cpal::Host, name: Option<&str>) -> Result<cpal::Device, String> {
    match name {
        Some(name) => find_device(host, name, false).ok_or_else(|| format!("output '{}' not found", name)),
        None => host.default_output_device().ok_or_else(|| "no default output".to_string()),
    }
}

fn default_output_name(host: &cpal::Host) -> Option<String> {
    host.default_output_device().and_then(|d| d.name().ok())
}

/// Open a track's stream: the microphone, or loopback of the output.
fn open(host: &cpal::Host, track: Track, setup: &Setup) -> Result<Input, String> {
    let (device, loopback) = match track {
        Track::You => (mic_device(host, &setup.microphone)?, false),
        Track::Others => (pc_device(host, setup.loopback.as_deref())?, true),
    };
    let name = device.name().unwrap_or_default();
    let config = if loopback { device.default_output_config() } else { device.default_input_config() }
        .map_err(|e| format!("{}: {}", name, e))?;
    if config.sample_format() != cpal::SampleFormat::F32 {
        return Err(format!("{}: unsupported sample format {:?}", name, config.sample_format()));
    }
    let channels = config.channels().max(1) as usize;
    let rate = config.sample_rate().0;
    let capacity = (rate * INBOX_SECS) as usize;
    let inbox = Arc::new(Inbox { samples: Mutex::new(Vec::with_capacity(capacity)), failed: AtomicBool::new(false) });
    let (data, errors) = (inbox.clone(), inbox.clone());
    let mut boost: Option<Option<MmcssGuard>> = None;
    let stream = device
        .build_input_stream(
            &config.config(),
            move |input: &[f32], _: &cpal::InputCallbackInfo| {
                // Real time: no allocation (the buffer has its capacity), no
                // logging, no file I/O; a full buffer drops the rest.
                if boost.is_none() {
                    boost = Some(boost_this_thread().1);
                }
                let mut buf = lock(&data.samples);
                let room = buf.capacity() - buf.len();
                for frame in input.chunks_exact(channels).take(room) {
                    buf.push(frame.iter().sum::<f32>() / channels as f32);
                }
            },
            move |_| errors.failed.store(true, SeqCst),
            None,
        )
        .map_err(|e| format!("{}: {}", name, e))?;
    stream.play().map_err(|e| format!("{}: {}", name, e))?;
    Ok(Input { _stream: stream, inbox, spare: Vec::with_capacity(capacity), resampler: Resampler::new(rate, RATE), device: name })
}

fn run(
    setup: Setup,
    files: [TrackFile; 2],
    stop: Arc<AtomicBool>,
    written: Arc<Written>,
    report: Report,
    on_limit: Box<dyn FnOnce() + Send>,
) -> u64 {
    let host = cpal::default_host();
    let started = Instant::now();
    let mut inputs: [Option<Input>; 2] = [None, None];
    let mut retry_at = [started; 2];
    let mut lost = [false; 2];
    let mut new: [Vec<f32>; 2] = [Vec::new(), Vec::new()];
    let mut next_write = started + WRITE_EVERY;
    let mut next_default_check = started + RETRY;
    let mut heard_pc = false;
    let mut no_pc_shown = false;
    let mut sinks = files.map(|file| Sink { file, failed: false });
    let mut on_limit = Some(on_limit);
    let tracks = [Track::You, Track::Others];
    loop {
        let stopping = stop.load(SeqCst);
        let now = Instant::now();
        if !stopping {
            let moved_to = if setup.loopback.is_none() && now >= next_default_check {
                next_default_check = now + RETRY;
                default_output_name(&host)
            } else {
                None
            };
            for track in tracks {
                let i = track.index();
                if sinks[i].failed {
                    continue;
                }
                let failed = inputs[i].as_ref().is_some_and(|input| input.inbox.failed.load(SeqCst));
                let moved = track == Track::Others
                    && moved_to.as_ref().is_some_and(|name| inputs[i].as_ref().is_some_and(|input| &input.device != name));
                if failed || moved {
                    if let Some(mut input) = inputs[i].take() {
                        input.drain(&mut new[i]);
                        startup_log::log(&format!(
                            "[meeting] {} {}",
                            input.device,
                            if failed { "failed" } else { "is no longer the default output" }
                        ));
                    }
                    if failed {
                        retry_at[i] = now + RETRY;
                        if !lost[i] {
                            lost[i] = true;
                            report(lost_warning(track), true);
                        }
                    } else {
                        retry_at[i] = now;
                    }
                }
                if inputs[i].is_none() && now >= retry_at[i] {
                    match open(&host, track, &setup) {
                        Ok(input) => {
                            startup_log::log(&format!("[meeting] {:?} track: {}", track, input.device));
                            inputs[i] = Some(input);
                            if lost[i] {
                                lost[i] = false;
                                report(lost_warning(track), false);
                            }
                        }
                        Err(e) => {
                            retry_at[i] = now + RETRY;
                            if !lost[i] {
                                lost[i] = true;
                                startup_log::log(&format!("[meeting] {:?} track not open: {}", track, e));
                                report(lost_warning(track), true);
                            }
                        }
                    }
                }
            }
        }
        if stopping || now >= next_write {
            next_write = now + WRITE_EVERY;
            let expected = ((now - started).as_millis() as u64 * RATE as u64 / 1000).min(setup.max_samples);
            for track in tracks {
                let i = track.index();
                if sinks[i].failed {
                    continue;
                }
                if let Some(input) = inputs[i].as_mut() {
                    input.drain(&mut new[i]);
                }
                if track == Track::Others && !heard_pc {
                    heard_pc = new[i].iter().any(|s| s.abs() > HEARD);
                }
                if let Err(e) = sinks[i].write(&mut new[i], expected, setup.max_samples) {
                    startup_log::log(&format!("[meeting] writing the {:?} track failed, it ends here: {}", track, e));
                    // The track's device closes; its warnings give way to this one.
                    inputs[i] = None;
                    if sinks.iter().filter(|s| s.failed).count() == 1 {
                        report(Warning::WriteFailed, true);
                    }
                    if std::mem::take(&mut lost[i]) {
                        report(lost_warning(track), false);
                    }
                }
                written.set(track, sinks[i].file.samples());
            }
            let silent_too_long =
                !heard_pc && !sinks[Track::Others.index()].failed && now - started >= NO_PC_SOUND_AFTER;
            if silent_too_long != no_pc_shown {
                no_pc_shown = silent_too_long;
                report(Warning::NoPcSound, silent_too_long);
            }
            if expected >= setup.max_samples {
                if let Some(limit) = on_limit.take() {
                    startup_log::log("[meeting] 4 hours recorded: stopping");
                    limit();
                }
            }
        }
        if stopping {
            break;
        }
        std::thread::sleep(TICK);
    }
    drop(inputs);
    let mut longest = 0;
    for (track, sink) in tracks.iter().zip(sinks.iter_mut()) {
        if let Err(e) = sink.file.finish() {
            startup_log::log(&format!("[meeting] {:?} header not written: {}", track, e));
        }
        longest = longest.max(sink.file.samples());
    }
    longest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn whole(input: &[f32], from: u32, to: u32) -> Vec<f32> {
        let mut out = Vec::new();
        Resampler::new(from, to).push(input, &mut out);
        out
    }

    #[test]
    fn a_track_resampled_in_seconds_is_the_track_resampled_at_once() {
        let input: Vec<f32> = (0..48_000 * 3).map(|i| ((i as f32) * 0.01).sin()).collect();
        let at_once = whole(&input, 48_000, 16_000);
        assert_eq!(at_once.len(), 48_000);
        let mut chunked = Vec::new();
        let mut r = Resampler::new(48_000, 16_000);
        // Uneven chunks, as the callbacks deliver them.
        for chunk in input.chunks(47_917) {
            r.push(chunk, &mut chunked);
        }
        assert_eq!(chunked.len(), at_once.len());
        for (a, b) in chunked.iter().zip(&at_once) {
            assert!((a - b).abs() < 1e-5, "{} vs {}", a, b);
        }
        // 44.1 kHz: 3 s become 3 s.
        let mut out = Vec::new();
        let mut r = Resampler::new(44_100, 16_000);
        for chunk in vec![0.5f32; 44_100 * 3].chunks(4_410) {
            r.push(chunk, &mut out);
        }
        assert!((out.len() as i64 - 48_000).abs() <= 1, "{}", out.len());
        assert!(out.iter().all(|&s| (s - 0.5).abs() < 1e-6), "a level stays");
        assert_eq!(whole(&[0.1, 0.2, 0.3], 16_000, 16_000), [0.1, 0.2, 0.3], "same rate");
    }

    #[test]
    fn a_track_behind_the_clock_gets_silence_and_none_past_the_limit() {
        // On time (a little behind is normal): only the new audio.
        let mut new = vec![0.2; 16_000];
        assert_eq!(to_append(&mut new, 16_000, 32_100, 1_000_000).len(), 16_000);
        assert!(new.is_empty(), "taken");
        // The loopback sent nothing for 2 s: silence up to the clock.
        let mut new = Vec::new();
        let out = to_append(&mut new, 16_000, 48_000, 1_000_000);
        assert_eq!(out.len(), 32_000);
        assert!(out.iter().all(|&s| s == 0.0));
        // Half a second of sound, then the rest silent.
        let mut new = vec![0.2; 8_000];
        let out = to_append(&mut new, 0, 32_000, 1_000_000);
        assert_eq!((out.len(), out[7_999], out[8_000]), (32_000, 0.2, 0.0));
        // Ahead of the clock: nothing is cut.
        let mut new = vec![0.2; 16_000];
        assert_eq!(to_append(&mut new, 40_000, 48_000, 1_000_000).len(), 16_000);
        // At 4 hours the track ends.
        let mut new = vec![0.2; 16_000];
        assert_eq!(to_append(&mut new, 990_000, 1_006_000, 1_000_000).len(), 10_000);
        let mut new = vec![0.2; 16_000];
        assert!(to_append(&mut new, 1_000_000, 1_016_000, 1_000_000).is_empty());
    }

    #[test]
    fn the_loopback_override_is_for_test_instances_only() {
        let cable = Some("CABLE Input (VB-Audio Virtual Cable)");
        assert_eq!(override_from(Some("1"), cable).as_deref(), cable);
        assert_eq!(override_from(None, cable), None, "a normal start ignores it");
        assert_eq!(override_from(Some("0"), cable), None);
        assert_eq!(override_from(Some("1"), Some("  ")), None);
        assert_eq!(override_from(Some("1"), None), None);
    }

    #[test]
    fn lost_devices_name_their_track() {
        assert_eq!(lost_warning(Track::You), Warning::MicLost);
        assert_eq!(lost_warning(Track::Others), Warning::PcLost);
        assert_eq!(serde_json::to_string(&Warning::NoPcSound).unwrap(), "\"noPcSound\"");
    }

    // The lock that makes the append fail is mandatory on Windows only.
    #[cfg(windows)]
    #[test]
    fn a_track_ends_at_its_first_failed_write() {
        let dir = std::env::temp_dir().join("rudariflow_meeting_capture_fail");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("you.wav");
        let mut sink = Sink { file: TrackFile::create(&path).unwrap(), failed: false };
        sink.write(&mut vec![0.2; 16_000], 16_000, 1_000_000).unwrap();
        // Another handle locks the file: the next append fails.
        let locker = std::fs::File::open(&path).unwrap();
        locker.lock().unwrap();
        assert!(sink.write(&mut vec![0.2; 16_000], 32_000, 1_000_000).is_err());
        locker.unlock().unwrap();
        // The file would take audio again, but the track has ended there.
        let mut new = vec![0.2; 16_000];
        assert_eq!(sink.write(&mut new, 48_000, 1_000_000), Ok(()), "reported once");
        assert!(new.is_empty(), "dropped");
        assert_eq!(sink.file.samples(), 16_000);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 44 + 32_000);
        assert_eq!(serde_json::to_string(&Warning::WriteFailed).unwrap(), "\"writeFailed\"");
    }
}
