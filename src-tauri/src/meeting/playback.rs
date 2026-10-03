//! ▶ in a meeting: both tracks mixed, from a paragraph on, on Windows'
//! default output (in the live checks on the test override's device). A
//! reader thread keeps about a second ready; the callback only copies. The
//! thread also opens and closes the stream: neither may hang the caller
//! (a wedged USB device can hang both for good).

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::capture::{Resampler, OPEN_TIMEOUT};
use super::store::{OTHERS_WAV, YOU_WAV};
use super::wav::{self, RATE};
use crate::audio::lock;
use crate::soundboard::engine::{boost_this_thread, find_device, MmcssGuard};
use crate::startup_log;

/// 16 kHz mono audio, `n` samples at a time; `None` at the end.
pub type Source = Box<dyn FnMut(usize) -> Option<Vec<f32>> + Send>;

/// A quarter second per read.
const CHUNK: usize = RATE as usize / 4;
/// Stop waits this long for the stream to close; a wedged one is left behind.
const CLOSE_WAIT: Duration = Duration::from_secs(3);
/// Once all is queued and taken, the output still plays what it holds.
const TAIL: Duration = Duration::from_millis(50);

/// Two tracks played together (the shorter one ends in silence).
pub fn mix(a: &[f32], b: &[f32]) -> Vec<f32> {
    (0..a.len().max(b.len()))
        .map(|i| (a.get(i).copied().unwrap_or(0.0) + b.get(i).copied().unwrap_or(0.0)).clamp(-1.0, 1.0))
        .collect()
}

/// Both tracks of the meeting in `dir`, mixed, from `from_ms` on.
pub fn meeting_source(dir: &Path, from_ms: u64) -> Source {
    let (you, others) = (dir.join(YOU_WAV), dir.join(OTHERS_WAV));
    let mut at = from_ms * (RATE as u64 / 1000);
    Box::new(move |n| {
        let a = wav::read_range(&you, at, at + n as u64).unwrap_or_default();
        let b = wav::read_range(&others, at, at + n as u64).unwrap_or_default();
        if a.is_empty() && b.is_empty() {
            return None;
        }
        at += n as u64;
        Some(mix(&a, &b))
    })
}

/// Samples in memory (the test command plays a file this way).
pub fn samples_source(samples: Vec<f32>) -> Source {
    let mut at = 0;
    Box::new(move |n| {
        if at >= samples.len() {
            return None;
        }
        let end = (at + n).min(samples.len());
        let chunk = samples[at..end].to_vec();
        at = end;
        Some(chunk)
    })
}

pub struct Player {
    stop: Arc<AtomicBool>,
    /// Disconnected once the thread has closed the stream and ended.
    closed: mpsc::Receiver<()>,
    thread: Option<JoinHandle<()>>,
}

impl Player {
    /// Play `source` on the output `device` (`None`: Windows' default).
    /// `ended` is called once it played to the end (or the output was
    /// lost), not after `stop`.
    pub fn start(source: Source, device: Option<String>, ended: Box<dyn FnOnce() + Send>) -> Result<Player, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let (opened, wait) = mpsc::channel();
        let (closed_tx, closed) = mpsc::channel::<()>();
        let s = stop.clone();
        let thread = std::thread::Builder::new()
            .name("rf-meeting-play".into())
            .spawn(move || {
                let _closed = closed_tx;
                play(source, device, s, opened, ended)
            })
            .map_err(|e| e.to_string())?;
        match wait.recv_timeout(OPEN_TIMEOUT) {
            Ok(Ok(())) => Ok(Player { stop, closed, thread: Some(thread) }),
            // The thread ends by itself.
            Ok(Err(e)) => Err(e),
            Err(RecvTimeoutError::Timeout) => {
                // A stream that opens later closes at once.
                stop.store(true, SeqCst);
                Err("the output did not answer".to_string())
            }
            Err(RecvTimeoutError::Disconnected) => Err("playback stopped".to_string()),
        }
    }

    pub fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(|t| t.is_finished())
    }

    pub fn stop(mut self) {
        self.halt();
    }

    /// Stop and wait for the stream to close, up to `CLOSE_WAIT`.
    fn halt(&mut self) {
        self.stop.store(true, SeqCst);
        let _ = self.closed.recv_timeout(CLOSE_WAIT);
        if let Some(t) = self.thread.take() {
            if t.is_finished() {
                let _ = t.join();
            }
        }
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.halt();
    }
}

fn play(
    mut source: Source,
    device: Option<String>,
    stop: Arc<AtomicBool>,
    opened: mpsc::Sender<Result<(), String>>,
    ended: Box<dyn FnOnce() + Send>,
) {
    let host = cpal::default_host();
    let dev = match &device {
        Some(name) => find_device(&host, name, false),
        None => host.default_output_device(),
    };
    let Some(dev) = dev else {
        let _ = opened.send(Err(format!("output '{}' not found", device.unwrap_or_default())));
        return;
    };
    let config = match dev.default_output_config() {
        Ok(c) if c.sample_format() == cpal::SampleFormat::F32 => c,
        Ok(c) => {
            let _ = opened.send(Err(format!("unsupported sample format {:?}", c.sample_format())));
            return;
        }
        Err(e) => {
            let _ = opened.send(Err(e.to_string()));
            return;
        }
    };
    let channels = config.channels().max(1) as usize;
    let rate = config.sample_rate().0;
    let queue = Arc::new(Mutex::new(VecDeque::<f32>::with_capacity(rate as usize * 2)));
    let q = queue.clone();
    let failed = Arc::new(AtomicBool::new(false));
    let f = failed.clone();
    let mut boost: Option<Option<MmcssGuard>> = None;
    let stream = dev.build_output_stream(
        &config.config(),
        move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
            // Real time: only copies from the queue the reader fills.
            if boost.is_none() {
                boost = Some(boost_this_thread().1);
            }
            let mut q = lock(&q);
            for frame in data.chunks_exact_mut(channels) {
                frame.fill(q.pop_front().unwrap_or(0.0));
            }
        },
        // The stream is dead after an error: the reader ends playback.
        move |_| f.store(true, SeqCst),
        None,
    );
    let stream = match stream.map_err(|e| e.to_string()).and_then(|s| s.play().map(|_| s).map_err(|e| e.to_string())) {
        Ok(s) => s,
        Err(e) => {
            let _ = opened.send(Err(e));
            return;
        }
    };
    let _ = opened.send(Ok(()));
    let mut resampler = Resampler::new(RATE, rate);
    let mut out = Vec::new();
    let mut input_done = false;
    while !stop.load(SeqCst) {
        if failed.load(SeqCst) {
            startup_log::log("[meeting] the playback's output was lost");
            drop(stream);
            ended();
            return;
        }
        let queued = lock(&queue).len();
        if !input_done && queued < rate as usize {
            match source(CHUNK) {
                Some(chunk) => {
                    out.clear();
                    resampler.push(&chunk, &mut out);
                    lock(&queue).extend(out.iter().copied());
                }
                None => input_done = true,
            }
            continue;
        }
        if input_done && queued == 0 {
            std::thread::sleep(TAIL);
            drop(stream);
            ended();
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::wav::TrackFile;

    #[test]
    fn both_tracks_play_together_from_a_paragraph() {
        assert_eq!(mix(&[0.5, 0.5, 0.5], &[0.25, 0.75]), [0.75, 1.0, 0.5], "clipped, the shorter ends in silence");
        let dir = std::env::temp_dir().join("rudariflow_meeting_play");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut you = TrackFile::create(&dir.join(YOU_WAV)).unwrap();
        you.append(&vec![0.25; 32_000]).unwrap();
        you.finish().unwrap();
        let mut others = TrackFile::create(&dir.join(OTHERS_WAV)).unwrap();
        others.append(&vec![0.0; 16_000]).unwrap();
        others.append(&vec![0.5; 16_000]).unwrap();
        others.finish().unwrap();
        // From 1.5 s: half a second of both, then the end.
        let mut source = meeting_source(&dir, 1_500);
        let chunk = source(16_000).unwrap();
        assert_eq!(chunk.len(), 8_000);
        assert!(chunk.iter().all(|s| (s - 0.75).abs() < 1e-3), "{}", chunk[0]);
        assert_eq!(source(16_000), None);
    }

    #[test]
    fn samples_play_in_chunks_to_their_end() {
        let mut source = samples_source(vec![0.1; 10]);
        assert_eq!(source(4).unwrap().len(), 4);
        assert_eq!(source(4).unwrap().len(), 4);
        assert_eq!(source(4).unwrap().len(), 2);
        assert_eq!(source(4), None);
    }
}
