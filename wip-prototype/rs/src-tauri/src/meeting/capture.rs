//! Recording a meeting: the microphone and WASAPI loopback of Windows'
//! default output (what the PC plays), each its own shared-mode cpal
//! stream. Every track has a device thread ("rf-meeting-mic",
//! "rf-meeting-pc") that opens its device, reopens it every 3 s after a
//! failure, moves the loopback to a new default output and closes its own
//! stream: a USB interface may hang in an open or a close for good, and
//! then only that thread waits. The callbacks only copy into a buffer; the
//! writer thread ("rf-meeting-capture") converts both tracks to 16 kHz mono
//! and appends them to `you.wav` and `others.wav` every second, fills
//! silence where a track fell behind the clock (the loopback sends nothing
//! while the PC is quiet, a lost device nothing at all) and raises the
//! bar's warnings.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed, Ordering::SeqCst};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
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

const TRACKS: [Track; 2] = [Track::You, Track::Others];
/// How often the threads look at their stop flag and the devices' state.
const TICK: Duration = Duration::from_millis(100);
const WRITE_EVERY: Duration = Duration::from_secs(1);
/// A lost device is tried again this often, and the default output is
/// looked at as often.
pub const RETRY: Duration = Duration::from_secs(3);
/// An open running longer counts as a lost device (it may never return;
/// dictation gives the microphone as long).
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(6);
/// A microphone without a callback for this long has stalled: reopened.
const STALL: Duration = Duration::from_secs(3);
/// Stop waits this long for the device threads to close their streams; a
/// wedged one is left behind.
const CLOSE_WAIT: Duration = Duration::from_secs(3);
/// A write this much later than the last one: the clock jumped (the PC
/// slept) or the disk held the writer up. Logged.
const JUMP: Duration = Duration::from_secs(5);
/// The callbacks' buffer holds this much, so a slow write loses nothing.
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

/// What one write appends to a track, in this order: `before` samples of
/// the audio that continues the track, `silence`, `after` samples of the
/// audio that starts after a gap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Append {
    pub before: usize,
    pub silence: u64,
    pub after: usize,
}

/// Where silence goes when a track is behind the clock (`expected`
/// samples since the start). `before`: new audio that continues what is on
/// disk; `after`: new audio that starts after a gap (the last write got
/// nothing, or the device was opened again since). Ahead of audio after a
/// gap the track is filled up to the clock, so that audio is at its time.
/// Without a gap the silence follows the audio, once the track is more than
/// `SLACK` behind (a little behind is normal: devices deliver late).
/// Nothing past `max`.
pub fn to_append(written: u64, before: usize, after: usize, expected: u64, max: u64) -> Append {
    let behind = expected.saturating_sub(written + before as u64 + after as u64);
    let silence = if after > 0 || behind > SLACK { behind } else { 0 };
    let mut room = max.saturating_sub(written);
    let mut take = |n: u64| {
        let n = n.min(room);
        room -= n;
        n
    };
    Append { before: take(before as u64) as usize, silence: take(silence), after: take(after as u64) as usize }
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
        let slots: [Slot; 2] = std::array::from_fn(|_| Arc::new(Mutex::new(Device::Opening(Instant::now()))));
        let device_stops: [Arc<AtomicBool>; 2] = std::array::from_fn(|_| Arc::new(AtomicBool::new(false)));
        let stop_devices = |stops: &[Arc<AtomicBool>; 2]| stops.iter().for_each(|s| s.store(true, SeqCst));
        // Each device thread holds a sender; when both are gone, the
        // streams are closed.
        let (closed_tx, closed) = mpsc::channel::<()>();
        for track in TRACKS {
            let i = track.index();
            let want = Want { microphone: setup.microphone.clone(), loopback: setup.loopback.clone() };
            let (slot, s, done) = (slots[i].clone(), device_stops[i].clone(), closed_tx.clone());
            let name = if track == Track::You { "rf-meeting-mic" } else { "rf-meeting-pc" };
            let spawned = std::thread::Builder::new()
                .name(name.into())
                .spawn(move || device_thread(track, want, slot, s, done));
            if let Err(e) = spawned {
                stop_devices(&device_stops);
                return Err(e.to_string());
            }
        }
        drop(closed_tx);
        let devices = Devices { slots, stops: CloseDevices(device_stops.clone()), closed };
        let (s, w, max) = (stop.clone(), written.clone(), setup.max_samples);
        let thread = std::thread::Builder::new()
            .name("rf-meeting-capture".into())
            .spawn(move || write(files, devices, s, w, report, on_limit, max));
        match thread {
            Ok(thread) => Ok(Capture { stop, thread: Some(thread), written }),
            Err(e) => {
                stop_devices(&device_stops);
                Err(e.to_string())
            }
        }
    }

    /// Stop: close the streams (a wedged device is waited for up to 3 s),
    /// write what is left and the WAV headers. Returns the samples of the
    /// longer track.
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

/// The callbacks' side of a stream: mono samples at the device's rate.
struct Inbox {
    samples: Mutex<Vec<f32>>,
    rate: u32,
    /// The stream reported an error (it has ended).
    failed: AtomicBool,
    /// Callbacks so far (a microphone without them has stalled).
    callbacks: AtomicU64,
    /// Samples the full buffer had no room for, since the writer last looked.
    dropped: AtomicU64,
}

impl Inbox {
    fn new(rate: u32) -> Inbox {
        Inbox {
            samples: Mutex::new(Vec::with_capacity(Inbox::capacity(rate))),
            rate,
            failed: AtomicBool::new(false),
            callbacks: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
        }
    }

    fn capacity(rate: u32) -> usize {
        rate as usize * INBOX_SECS as usize
    }

    /// The data callback: `input`'s frames mixed to mono into the buffer.
    /// Real time: no allocation (the buffer has its capacity), no logging,
    /// no file I/O; a full buffer drops the rest and counts it.
    fn receive(&self, input: &[f32], channels: usize) {
        self.callbacks.fetch_add(1, Relaxed);
        let mut buf = lock(&self.samples);
        let room = buf.capacity() - buf.len();
        let frames = input.len() / channels;
        for frame in input.chunks_exact(channels).take(room) {
            buf.push(frame.iter().sum::<f32>() / channels as f32);
        }
        if frames > room {
            self.dropped.fetch_add((frames - room) as u64, Relaxed);
        }
    }
}

/// Move what the callbacks collected in `inbox` to `out` at 16 kHz. The
/// buffers are swapped (`spare` has the inbox's capacity), so neither side
/// allocates under the lock. Returns the samples the callbacks dropped.
fn drain(inbox: &Inbox, spare: &mut Vec<f32>, resampler: &mut Resampler, out: &mut Vec<f32>) -> u64 {
    std::mem::swap(&mut *lock(&inbox.samples), spare);
    resampler.push(spare, out);
    spare.clear();
    inbox.dropped.swap(0, Relaxed)
}

/// What a track's device thread tells the writer.
#[derive(Clone)]
enum Device {
    /// An open runs since then.
    Opening(Instant),
    /// A stream runs and fills this inbox.
    Open(Arc<Inbox>),
    /// The last open failed or the stream ended; it is tried again.
    Down,
}

type Slot = Arc<Mutex<Device>>;

/// A track's device as the warnings see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Health {
    Running,
    /// An open has been running this long.
    Opening(Duration),
    Down,
}

impl Health {
    fn of(device: &Device, now: Instant) -> Health {
        match device {
            Device::Open(_) => Health::Running,
            Device::Opening(since) => Health::Opening(now.saturating_duration_since(*since)),
            Device::Down => Health::Down,
        }
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
    /// `Err` only for the append that fails; nothing is appended after it.
    fn append(&mut self, samples: &[f32]) -> Result<(), String> {
        if self.failed || samples.is_empty() {
            return Ok(());
        }
        self.file.append(samples).inspect_err(|_| self.failed = true)
    }
}

/// The writer's side of a track: the inbox it drains and its file.
struct Feed {
    inbox: Option<Arc<Inbox>>,
    /// Swapped with the inbox's buffer.
    spare: Vec<f32>,
    resampler: Resampler,
    sink: Sink,
    /// The last write got no audio: the next audio starts after a gap.
    gap: bool,
    /// This write's audio that continues the track.
    before: Vec<f32>,
    /// This write's audio that starts after a gap.
    after: Vec<f32>,
}

impl Feed {
    fn new(file: TrackFile) -> Feed {
        Feed {
            inbox: None,
            spare: Vec::new(),
            resampler: Resampler::new(RATE, RATE),
            sink: Sink { file, failed: false },
            gap: true,
            before: Vec::new(),
            after: Vec::new(),
        }
    }

    /// Take what the callbacks delivered since the last write: the rest of
    /// a stream that ended, then the audio of the one running (`current`).
    /// A stream opened since, or any audio after a write that got none,
    /// starts after a gap. Returns the samples the callbacks dropped.
    fn collect(&mut self, current: Option<&Arc<Inbox>>) -> u64 {
        self.before.clear();
        self.after.clear();
        let mut dropped = 0;
        if let Some(inbox) = &self.inbox {
            let out = if self.gap { &mut self.after } else { &mut self.before };
            dropped += drain(inbox, &mut self.spare, &mut self.resampler, out);
        }
        if let Some(new) = current.filter(|c| !self.inbox.as_ref().is_some_and(|i| Arc::ptr_eq(i, *c))) {
            self.inbox = Some(new.clone());
            self.spare = Vec::with_capacity(Inbox::capacity(new.rate));
            self.resampler = Resampler::new(new.rate, RATE);
            dropped += drain(new, &mut self.spare, &mut self.resampler, &mut self.after);
        }
        self.gap = self.before.is_empty() && self.after.is_empty();
        dropped
    }

    fn heard(&self) -> bool {
        self.before.iter().chain(&self.after).any(|s| s.abs() > HEARD)
    }

    /// Append what `collect` took, with silence up to the clock as
    /// `to_append` places it, in blocks of at most `zeros` (one second), so
    /// a clock that jumped hours (the PC slept) needs no big buffer.
    fn write(&mut self, expected: u64, max: u64, zeros: &[f32]) -> Result<(), String> {
        if self.sink.failed {
            return Ok(());
        }
        let plan = to_append(self.sink.file.samples(), self.before.len(), self.after.len(), expected, max);
        self.sink.append(&self.before[..plan.before])?;
        let mut left = plan.silence;
        while left > 0 {
            let n = left.min(zeros.len() as u64) as usize;
            self.sink.append(&zeros[..n])?;
            left -= n as u64;
        }
        self.sink.append(&self.after[..plan.after])
    }
}

/// What one write saw, for the warnings and the limit.
struct Seen {
    health: [Health; 2],
    /// The track's file refused audio: the track has ended.
    ended: [bool; 2],
    /// The PC track had sound in this write.
    heard_pc: bool,
    since_start: Duration,
    expected: u64,
    max: u64,
}

/// The writer's decisions besides the audio: the bar's warnings and the
/// 4-hour limit, apart from the devices and files.
#[derive(Debug, Default)]
struct Alerts {
    lost: [bool; 2],
    write_failed: bool,
    heard_pc: bool,
    no_pc: bool,
    limit: bool,
}

impl Alerts {
    /// The warnings that come or go after this write, and whether the
    /// limit was reached with it (once).
    fn step(&mut self, seen: &Seen) -> (Vec<(Warning, bool)>, bool) {
        let mut changes = Vec::new();
        for track in TRACKS {
            let i = track.index();
            let lost = !seen.ended[i]
                && match seen.health[i] {
                    Health::Running => false,
                    Health::Down => true,
                    // An open may never return; a retry keeps the warning.
                    Health::Opening(running) => self.lost[i] || running >= OPEN_TIMEOUT,
                };
            if lost != self.lost[i] {
                self.lost[i] = lost;
                changes.push((lost_warning(track), lost));
            }
        }
        if seen.ended.contains(&true) && !self.write_failed {
            self.write_failed = true;
            changes.push((Warning::WriteFailed, true));
        }
        self.heard_pc |= seen.heard_pc;
        let no_pc = !self.heard_pc && !seen.ended[Track::Others.index()] && seen.since_start >= NO_PC_SOUND_AFTER;
        if no_pc != self.no_pc {
            self.no_pc = no_pc;
            changes.push((Warning::NoPcSound, no_pc));
        }
        let limit = !self.limit && seen.expected >= seen.max;
        self.limit |= limit;
        (changes, limit)
    }
}

/// The writer's side of the device threads.
struct Devices {
    slots: [Slot; 2],
    stops: CloseDevices,
    /// Disconnected once every device thread has ended.
    closed: Receiver<()>,
}

/// The flags that tell the device threads to close their streams and end.
/// Set when dropped: when the writer ends, also by a panic, no device stays
/// open.
struct CloseDevices([Arc<AtomicBool>; 2]);

impl CloseDevices {
    fn close(&self, track: Track) {
        self.0[track.index()].store(true, SeqCst);
    }

    fn close_all(&self) {
        TRACKS.into_iter().for_each(|track| self.close(track));
    }
}

impl Drop for CloseDevices {
    fn drop(&mut self) {
        self.close_all();
    }
}

fn write(
    files: [TrackFile; 2],
    devices: Devices,
    stop: Arc<AtomicBool>,
    written: Arc<Written>,
    report: Report,
    on_limit: Box<dyn FnOnce() + Send>,
    max: u64,
) -> u64 {
    let started = Instant::now();
    let mut feeds = files.map(Feed::new);
    let mut alerts = Alerts::default();
    let mut on_limit = Some(on_limit);
    let zeros = vec![0.0f32; RATE as usize];
    let mut last_write = started;
    loop {
        let stopping = stop.load(SeqCst);
        if stopping {
            // The streams close first, so the last callbacks' audio is in
            // the final write.
            devices.stops.close_all();
            if let Err(RecvTimeoutError::Timeout) = devices.closed.recv_timeout(CLOSE_WAIT) {
                startup_log::log("[meeting] a device did not close its stream; left behind");
            }
        }
        let now = Instant::now();
        if stopping || now >= last_write + WRITE_EVERY {
            let late = now - last_write;
            if late > JUMP {
                startup_log::log(&format!("[meeting] {} s since the last write (the PC slept?): filled with silence", late.as_secs()));
            }
            last_write = now;
            let since_start = now - started;
            let expected = (since_start.as_millis() as u64 * RATE as u64 / 1000).min(max);
            let mut health = [Health::Down; 2];
            let mut heard_pc = false;
            for track in TRACKS {
                let i = track.index();
                let device = lock(&devices.slots[i]).clone();
                health[i] = Health::of(&device, now);
                let feed = &mut feeds[i];
                let current = if let Device::Open(inbox) = &device { Some(inbox) } else { None };
                let dropped = feed.collect(current);
                if dropped > 0 {
                    startup_log::log(&format!("[meeting] {:?} track: {} samples dropped (the writer fell behind)", track, dropped));
                }
                if track == Track::Others {
                    heard_pc = feed.heard();
                }
                if let Err(e) = feed.write(expected, max, &zeros) {
                    startup_log::log(&format!("[meeting] writing the {:?} track failed, it ends here: {}", track, e));
                    devices.stops.close(track);
                }
                written.set(track, feed.sink.file.samples());
            }
            if !stopping {
                let ended = [0, 1].map(|i| feeds[i].sink.failed);
                let (changes, reached) = alerts.step(&Seen { health, ended, heard_pc, since_start, expected, max });
                for (warning, on) in changes {
                    report(warning, on);
                }
                if let Some(limit) = on_limit.take_if(|_| reached) {
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
    let mut longest = 0;
    for (track, feed) in TRACKS.iter().zip(feeds.iter_mut()) {
        if let Err(e) = feed.sink.file.finish() {
            startup_log::log(&format!("[meeting] {:?} header not written: {}", track, e));
        }
        longest = longest.max(feed.sink.file.samples());
    }
    longest
}

/// What a device thread opens.
struct Want {
    microphone: String,
    loopback: Option<String>,
}

/// A track's open stream. It stays on the device thread that made it
/// (cpal streams are not `Send`), which also closes it.
struct Opened {
    _stream: cpal::Stream,
    inbox: Arc<Inbox>,
    device: String,
}

/// Open `name` (empty or "default": Windows' default input); when a named
/// one does not open (unplugged, say), the default input instead, as
/// dictation does. Also returns why the named one did not open.
fn named_or_default<T>(name: &str, mut open: impl FnMut(Option<&str>) -> Result<T, String>) -> Result<(T, Option<String>), String> {
    let name = name.trim();
    if name.is_empty() || name == "default" {
        return open(None).map(|t| (t, None));
    }
    match open(Some(name)) {
        Ok(t) => Ok((t, None)),
        Err(e) => match open(None) {
            Ok(t) => Ok((t, Some(e))),
            Err(d) => Err(format!("{}; default input: {}", e, d)),
        },
    }
}

/// A stream that should run but had no callback for `quiet`. Only the
/// microphone: the loopback gets none while the PC is silent.
fn stalled(track: Track, quiet: Duration) -> bool {
    track == Track::You && quiet >= STALL
}

fn default_output_name(host: &cpal::Host) -> Option<String> {
    host.default_output_device().and_then(|d| d.name().ok())
}

/// Open a track's stream: the microphone, or loopback of the output.
fn open(host: &cpal::Host, track: Track, want: &Want) -> Result<(Opened, Option<String>), String> {
    match track {
        Track::You => named_or_default(&want.microphone, |name| {
            let device = match name {
                Some(name) => find_device(host, name, true).ok_or_else(|| format!("microphone '{}' not found", name))?,
                None => host.default_input_device().ok_or_else(|| "no default input".to_string())?,
            };
            open_stream(device, false)
        }),
        Track::Others => {
            let device = match &want.loopback {
                Some(name) => find_device(host, name, false).ok_or_else(|| format!("output '{}' not found", name))?,
                None => host.default_output_device().ok_or_else(|| "no default output".to_string())?,
            };
            open_stream(device, true).map(|opened| (opened, None))
        }
    }
}

fn open_stream(device: cpal::Device, loopback: bool) -> Result<Opened, String> {
    let name = device.name().unwrap_or_default();
    let config = if loopback { device.default_output_config() } else { device.default_input_config() }
        .map_err(|e| format!("{}: {}", name, e))?;
    if config.sample_format() != cpal::SampleFormat::F32 {
        return Err(format!("{}: unsupported sample format {:?}", name, config.sample_format()));
    }
    let channels = config.channels().max(1) as usize;
    let inbox = Arc::new(Inbox::new(config.sample_rate().0));
    let (data, errors) = (inbox.clone(), inbox.clone());
    let mut boost: Option<Option<MmcssGuard>> = None;
    let stream = device
        .build_input_stream(
            &config.config(),
            move |input: &[f32], _: &cpal::InputCallbackInfo| {
                // Real time: raised once (the registration ends with the
                // callback, on this thread), then only the copy.
                if boost.is_none() {
                    boost = Some(boost_this_thread().1);
                }
                data.receive(input, channels);
            },
            move |_| errors.failed.store(true, SeqCst),
            None,
        )
        .map_err(|e| format!("{}: {}", name, e))?;
    stream.play().map_err(|e| format!("{}: {}", name, e))?;
    Ok(Opened { _stream: stream, inbox, device: name })
}

/// Why a running stream is let go.
enum End {
    Stop,
    Failed(String),
    /// The default output changed (the loopback follows it).
    Moved,
}

/// A track's device thread: open, watch, close, again until stopped. The
/// slot says what it is doing, so a hang here shows as a lost device.
/// `_closed` goes when the thread ends.
fn device_thread(track: Track, want: Want, slot: Slot, stop: Arc<AtomicBool>, _closed: Sender<()>) {
    let host = cpal::default_host();
    let mut failing = false;
    // Set when the old stream's close counts toward the next open's time.
    let mut opening_since: Option<Instant> = None;
    while !stop.load(SeqCst) {
        *lock(&slot) = Device::Opening(opening_since.take().unwrap_or_else(Instant::now));
        let opened = open(&host, track, &want);
        if stop.load(SeqCst) {
            // Stopped while it opened (perhaps long ago): closed at once.
            break;
        }
        let end = match opened {
            Ok((opened, fell_back)) => {
                failing = false;
                let note = fell_back.map(|e| format!(" (the setting's microphone did not open: {})", e));
                startup_log::log(&format!("[meeting] {:?} track: {}{}", track, opened.device, note.unwrap_or_default()));
                *lock(&slot) = Device::Open(opened.inbox.clone());
                let end = watch(&host, track, &want, &opened, &stop);
                match &end {
                    End::Failed(why) => {
                        startup_log::log(&format!("[meeting] {:?} track: {} {}", track, opened.device, why));
                        *lock(&slot) = Device::Down;
                    }
                    End::Moved => {
                        startup_log::log(&format!("[meeting] {} is no longer the default output", opened.device));
                        // From now on the track waits for the new stream: a
                        // close that hangs is a lost device after 6 s.
                        let now = Instant::now();
                        *lock(&slot) = Device::Opening(now);
                        opening_since = Some(now);
                    }
                    End::Stop => {}
                }
                // Closing joins the stream's thread and may hang on a wedged
                // device; the slot already tells the writer.
                drop(opened);
                end
            }
            Err(e) => {
                if !failing {
                    failing = true;
                    startup_log::log(&format!("[meeting] {:?} track not open: {}", track, e));
                }
                *lock(&slot) = Device::Down;
                End::Failed(e)
            }
        };
        match end {
            End::Stop => break,
            End::Moved => {}
            End::Failed(_) => {
                let retry_at = Instant::now() + RETRY;
                while !stop.load(SeqCst) && Instant::now() < retry_at {
                    std::thread::sleep(TICK);
                }
            }
        }
    }
}

/// Watch a running stream until it is stopped, fails, stalls (microphone)
/// or the default output moves (loopback of the default output).
fn watch(host: &cpal::Host, track: Track, want: &Want, opened: &Opened, stop: &AtomicBool) -> End {
    // (A device without a readable name cannot be compared.)
    let follow = track == Track::Others && want.loopback.is_none() && !opened.device.is_empty();
    let mut next_check = Instant::now() + RETRY;
    let mut callbacks = opened.inbox.callbacks.load(Relaxed);
    let mut last_callback = Instant::now();
    loop {
        std::thread::sleep(TICK);
        if stop.load(SeqCst) {
            return End::Stop;
        }
        if opened.inbox.failed.load(SeqCst) {
            return End::Failed("failed".into());
        }
        let now = Instant::now();
        let count = opened.inbox.callbacks.load(Relaxed);
        if count != callbacks {
            (callbacks, last_callback) = (count, now);
        } else if stalled(track, now - last_callback) {
            return End::Failed(format!("sent no audio for {} s", STALL.as_secs()));
        }
        if follow && now >= next_check {
            next_check = now + RETRY;
            if default_output_name(host).is_some_and(|name| name != opened.device) {
                return End::Moved;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn whole(input: &[f32], from: u32, to: u32) -> Vec<f32> {
        let mut out = Vec::new();
        Resampler::new(from, to).push(input, &mut out);
        out
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rudariflow_meeting_capture_{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
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

    fn append(before: usize, silence: u64, after: usize) -> Append {
        Append { before, silence, after }
    }

    #[test]
    fn a_track_behind_the_clock_gets_silence_and_none_past_the_limit() {
        // On time (a little behind is normal): only the new audio.
        assert_eq!(to_append(16_000, 16_000, 0, 32_100, 1_000_000), append(16_000, 0, 0));
        // The loopback sent nothing for 2 s: silence up to the clock.
        assert_eq!(to_append(16_000, 0, 0, 48_000, 1_000_000), append(0, 32_000, 0));
        // Half a second of sound, then the rest silent.
        assert_eq!(to_append(0, 8_000, 0, 32_000, 1_000_000), append(8_000, 24_000, 0));
        // Ahead of the clock: nothing is cut.
        assert_eq!(to_append(40_000, 16_000, 0, 48_000, 1_000_000), append(16_000, 0, 0));
        // At 4 hours the track ends.
        assert_eq!(to_append(990_000, 16_000, 0, 1_006_000, 1_000_000), append(10_000, 0, 0));
        assert_eq!(to_append(1_000_000, 16_000, 0, 1_016_000, 1_000_000), append(0, 0, 0));
    }

    #[test]
    fn audio_after_a_gap_comes_at_its_time() {
        // The PC was silent and sounds again 0.6 s into this second: the
        // silence comes first, however little is missing.
        assert_eq!(to_append(16_000, 0, 6_400, 32_000, 1_000_000), append(0, 9_600, 6_400));
        assert_eq!(to_append(16_000, 0, 15_000, 32_000, 1_000_000), append(0, 1_000, 15_000));
        // A device opened again: the old stream's rest, the gap, the new audio.
        assert_eq!(to_append(16_000, 4_000, 6_000, 32_000, 1_000_000), append(4_000, 6_000, 6_000));
        // On time: nothing to fill.
        assert_eq!(to_append(16_000, 0, 16_000, 32_000, 1_000_000), append(0, 0, 16_000));
        // The limit cuts the silence first, then the audio after it.
        assert_eq!(to_append(990_000, 2_000, 8_000, 1_010_000, 1_000_000), append(2_000, 8_000, 0));
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
        let path = temp("fail").join("you.wav");
        let mut sink = Sink { file: TrackFile::create(&path).unwrap(), failed: false };
        sink.append(&[0.2; 16_000]).unwrap();
        // Another handle locks the file: the next append fails.
        let locker = std::fs::File::open(&path).unwrap();
        locker.lock().unwrap();
        assert!(sink.append(&[0.2; 16_000]).is_err());
        locker.unlock().unwrap();
        // The file would take audio again, but the track has ended there.
        assert_eq!(sink.append(&[0.2; 16_000]), Ok(()), "reported once");
        assert_eq!(sink.file.samples(), 16_000);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 44 + 32_000);
        assert_eq!(serde_json::to_string(&Warning::WriteFailed).unwrap(), "\"writeFailed\"");
    }

    #[test]
    fn the_callbacks_never_allocate_and_count_what_they_drop() {
        let inbox = Inbox::new(100); // 30 s: 3 000 samples of room
        let capacity = lock(&inbox.samples).capacity();
        assert!(capacity >= 3_000);
        // Stereo: frames are mixed to mono.
        inbox.receive(&[0.25, 0.75, 0.5, 1.0], 2);
        assert_eq!(*lock(&inbox.samples), [0.5f32, 0.75]);
        inbox.receive(&[0.1; 4_000], 1);
        assert_eq!(lock(&inbox.samples).len(), capacity, "full");
        assert_eq!(lock(&inbox.samples).capacity(), capacity, "no allocation");
        let dropped = (4_002 - capacity) as u64;
        assert_eq!((inbox.callbacks.load(Relaxed), inbox.dropped.load(Relaxed)), (2, dropped));
        // The writer swaps in a buffer as large: the callbacks have room
        // again, still without allocating.
        let (mut spare, mut out) = (Vec::with_capacity(Inbox::capacity(100)), Vec::new());
        assert_eq!(drain(&inbox, &mut spare, &mut Resampler::new(100, 100), &mut out), dropped);
        assert_eq!((out.len(), inbox.dropped.load(Relaxed)), (capacity, 0));
        assert!(lock(&inbox.samples).is_empty() && lock(&inbox.samples).capacity() >= Inbox::capacity(100));
        assert!(spare.is_empty() && spare.capacity() >= Inbox::capacity(100));
    }

    #[test]
    fn a_new_stream_and_sound_after_silence_start_after_a_gap() {
        let path = temp("feed").join("others.wav");
        let mut feed = Feed::new(TrackFile::create(&path).unwrap());
        let zeros = vec![0.0; RATE as usize];
        let max = 1_000_000;
        let (first, second) = (Arc::new(Inbox::new(RATE)), Arc::new(Inbox::new(RATE)));
        // Second 1: the device opened late, 0.4 s of sound: silence first.
        first.receive(&[0.5; 6_400], 1);
        feed.collect(Some(&first));
        assert_eq!((feed.before.len(), feed.after.len()), (0, 6_400));
        feed.write(16_000, max, &zeros).unwrap();
        // Second 2: a whole second continues the track.
        first.receive(&[0.5; 16_000], 1);
        feed.collect(Some(&first));
        assert_eq!((feed.before.len(), feed.after.len()), (16_000, 0));
        feed.write(32_000, max, &zeros).unwrap();
        // Seconds 3 and 4: the PC is silent, then sounds again at 3.7 s.
        feed.collect(Some(&first));
        feed.write(48_000, max, &zeros).unwrap();
        first.receive(&[0.5; 4_800], 1);
        feed.collect(Some(&first));
        assert_eq!((feed.before.len(), feed.after.len()), (0, 4_800));
        feed.write(64_000, max, &zeros).unwrap();
        // Second 5: the default output moved: the old stream's rest
        // continues the track, the new stream's sound starts after a gap.
        first.receive(&[0.5; 3_000], 1);
        second.receive(&[0.5; 9_000], 1);
        assert_eq!(feed.collect(Some(&second)), 0, "nothing dropped");
        assert_eq!((feed.before.len(), feed.after.len()), (3_000, 9_000));
        feed.write(80_000, max, &zeros).unwrap();
        let samples = crate::meeting::wav::read_range(&path, 0, 80_000).unwrap();
        assert_eq!(samples.len(), 80_000);
        let sound = |from: usize, to: usize| samples[from..to].iter().all(|s| (s - 0.5).abs() < 1e-3);
        let quiet = |from: usize, to: usize| samples[from..to].iter().all(|&s| s == 0.0);
        assert!(quiet(0, 9_600) && sound(9_600, 32_000), "second 1 and 2");
        assert!(quiet(32_000, 59_200) && sound(59_200, 64_000), "seconds 3 and 4");
        assert!(sound(64_000, 67_000) && quiet(67_000, 71_000) && sound(71_000, 80_000), "second 5");
        // The PC slept a minute: filled up to the clock, in blocks.
        feed.collect(Some(&second));
        feed.write(80_000 + 60 * 16_000, max * 2, &zeros).unwrap();
        assert_eq!(feed.sink.file.samples(), 80_000 + 60 * 16_000);
    }

    const NONE: [(Warning, bool); 0] = [];

    fn seen(health: [Health; 2], secs: u64) -> Seen {
        let expected = secs * RATE as u64;
        Seen { health, ended: [false; 2], heard_pc: true, since_start: Duration::from_secs(secs), expected, max: 1_000_000 }
    }

    #[test]
    fn an_open_that_hangs_is_a_lost_device_after_six_seconds() {
        use Health::*;
        let mut alerts = Alerts::default();
        let opening = |secs: u64| Opening(Duration::from_secs(secs));
        assert_eq!(alerts.step(&seen([opening(1), Running], 1)).0, NONE);
        assert_eq!(alerts.step(&seen([opening(5), Running], 5)).0, NONE, "a slow open is no loss yet");
        assert_eq!(alerts.step(&seen([opening(6), Running], 6)).0, [(Warning::MicLost, true)]);
        assert_eq!(alerts.step(&seen([Running, Running], 7)).0, [(Warning::MicLost, false)]);
        // A failure shows at once; the retry's open keeps it until it runs.
        assert_eq!(alerts.step(&seen([Running, Down], 8)).0, [(Warning::PcLost, true)]);
        assert_eq!(alerts.step(&seen([Running, opening(0)], 11)).0, NONE);
        assert_eq!(alerts.step(&seen([Running, Running], 12)).0, [(Warning::PcLost, false)]);
        // The loopback moving to a new default output is no loss.
        assert_eq!(alerts.step(&seen([Running, opening(0)], 13)).0, NONE);
    }

    #[test]
    fn a_silent_pc_a_failed_write_and_the_limit_are_told_once() {
        use Health::*;
        let mut alerts = Alerts::default();
        let quiet = |secs: u64| Seen { heard_pc: false, ..seen([Running, Running], secs) };
        assert_eq!(alerts.step(&quiet(29)).0, NONE);
        assert_eq!(alerts.step(&quiet(30)).0, [(Warning::NoPcSound, true)]);
        assert_eq!(alerts.step(&quiet(31)).0, NONE);
        assert_eq!(alerts.step(&seen([Running, Running], 32)).0, [(Warning::NoPcSound, false)]);
        assert_eq!(alerts.step(&quiet(33)).0, NONE, "heard once is enough");
        // The PC track's file fails while its device is lost: one warning
        // for the file, none for a device it no longer needs.
        let mut alerts = Alerts::default();
        alerts.step(&quiet(30));
        alerts.step(&quiet(31));
        let lost = Seen { heard_pc: false, ..seen([Running, Down], 32) };
        assert_eq!(alerts.step(&lost).0, [(Warning::PcLost, true)]);
        let ended = Seen { ended: [false, true], heard_pc: false, ..seen([Running, Down], 33) };
        assert_eq!(alerts.step(&ended).0, [(Warning::PcLost, false), (Warning::WriteFailed, true), (Warning::NoPcSound, false)]);
        let both = Seen { ended: [true, true], ..seen([Running, Down], 34) };
        assert_eq!(alerts.step(&both).0, NONE, "the second file adds nothing");
        // The limit, once.
        let mut alerts = Alerts::default();
        let at = |expected: u64| Seen { expected, ..seen([Running, Running], 1) };
        assert!(!alerts.step(&at(999_999)).1);
        assert!(alerts.step(&at(1_000_000)).1);
        assert!(!alerts.step(&at(1_000_000)).1);
    }

    #[test]
    fn the_devices_close_when_the_writer_ends_even_by_a_panic() {
        let stops: [Arc<AtomicBool>; 2] = std::array::from_fn(|_| Arc::new(AtomicBool::new(false)));
        let close = CloseDevices(stops.clone());
        close.close(Track::Others);
        assert_eq!(stops.each_ref().map(|s| s.load(SeqCst)), [false, true], "one track's file failed");
        let writer = std::thread::spawn(move || {
            let _close = close;
            panic!("a bug in the writer");
        });
        assert!(writer.join().is_err());
        assert!(stops.iter().all(|s| s.load(SeqCst)));
    }

    #[test]
    fn only_a_microphone_without_callbacks_has_stalled() {
        assert!(!stalled(Track::You, Duration::from_millis(2_900)));
        assert!(stalled(Track::You, STALL));
        assert!(!stalled(Track::Others, Duration::from_secs(600)), "a silent PC sends nothing");
    }

    /// Opens the inputs in `present` (`None`: the default input).
    fn opener<'a>(present: &'a [Option<&'static str>]) -> impl FnMut(Option<&str>) -> Result<String, String> + 'a {
        move |name| match present.contains(&name) {
            true => Ok(name.unwrap_or("default").to_string()),
            false => Err(format!("{:?} not found", name)),
        }
    }

    #[test]
    fn a_missing_microphone_falls_back_to_the_default_input() {
        let both = [Some("Scarlett"), None];
        assert_eq!(named_or_default("Scarlett", opener(&both)), Ok(("Scarlett".into(), None)));
        assert_eq!(named_or_default("default", opener(&both)), Ok(("default".into(), None)));
        assert_eq!(named_or_default(" ", opener(&both)), Ok(("default".into(), None)));
        let fallback = named_or_default("Scarlett", opener(&[None])).unwrap();
        assert_eq!(fallback, ("default".into(), Some("Some(\"Scarlett\") not found".into())));
        // No input opens at all: that is a lost microphone.
        assert!(named_or_default("Scarlett", opener(&[])).unwrap_err().contains("default input"));
        assert!(named_or_default("default", opener(&[])).is_err());
    }
}
