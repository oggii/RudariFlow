use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::startup_log;

/// Lock a mutex even if a previous holder panicked. A poisoned lock would
/// otherwise make every later hotkey press panic silently.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Upper bound for opening the input stream. USB audio interfaces that Windows
/// has selectively suspended can take seconds to wake, or never answer.
const MIC_OPEN_TIMEOUT: Duration = Duration::from_secs(6);
const MIC_RETRY_DELAY: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, serde::Serialize)]
pub struct MicDevice {
    pub name: String,
    pub is_default: bool,
}

pub fn list_microphones() -> Vec<MicDevice> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();

    let mut devices = Vec::new();
    if let Ok(input_devices) = host.input_devices() {
        for device in input_devices {
            if let Ok(name) = device.name() {
                devices.push(MicDevice {
                    is_default: name == default_name,
                    name,
                });
            }
        }
    }
    devices
}

/// Wrapper to make cpal::Stream usable across threads.
/// SAFETY: cpal::Stream on macOS (CoreAudio) is thread-safe in practice;
/// we only access it behind a Mutex to start/stop recording.
struct SendStream(#[allow(dead_code)] cpal::Stream);
unsafe impl Send for SendStream {}
unsafe impl Sync for SendStream {}

pub struct AudioRecorder {
    samples: Arc<Mutex<Vec<f32>>>,
    stream: Option<SendStream>,
    source_sample_rate: u32,
    source_channels: u16,
}

impl AudioRecorder {
    pub fn new() -> Self {
        Self {
            samples: Arc::new(Mutex::new(Vec::new())),
            stream: None,
            source_sample_rate: 48000,
            source_channels: 1,
        }
    }

    /// Open the microphone and start capturing. The device work runs on a
    /// dedicated thread bounded by MIC_OPEN_TIMEOUT so a sleeping or wedged
    /// audio device can never block the hotkey path indefinitely.
    pub fn start(&mut self, app: &AppHandle, mic_name: &str) -> Result<(), String> {
        self.release_stream();
        // Fresh buffer per recording: a late callback from a previous stream
        // that is still shutting down cannot leak into this one.
        self.samples = Arc::new(Mutex::new(Vec::new()));

        let (tx, rx) = std::sync::mpsc::channel();
        let samples = self.samples.clone();
        let app_handle = app.clone();
        let mic = mic_name.to_string();
        std::thread::Builder::new()
            .name("rf-mic-open".into())
            .spawn(move || {
                let mut result = open_stream(&app_handle, &mic, samples.clone());
                if let Err(e) = &result {
                    startup_log::log(&format!("[audio] open failed ({}), retrying", e));
                    std::thread::sleep(MIC_RETRY_DELAY);
                    result = open_stream(&app_handle, &mic, samples.clone());
                }
                if result.is_err() && mic != "default" {
                    startup_log::log(&format!(
                        "[audio] '{}' unavailable, falling back to default input",
                        mic
                    ));
                    result = open_stream(&app_handle, "default", samples);
                }
                // If the caller already timed out, the stream comes back in the
                // send error and is dropped here, closing the device.
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;

        let opened = match rx.recv_timeout(MIC_OPEN_TIMEOUT) {
            Ok(r) => r?,
            Err(_) => {
                return Err(format!(
                    "Microphone '{}' did not respond within {} s",
                    mic_name,
                    MIC_OPEN_TIMEOUT.as_secs()
                ))
            }
        };

        self.source_sample_rate = opened.sample_rate;
        self.source_channels = opened.channels;
        self.stream = Some(opened.stream);
        startup_log::log(&format!(
            "[audio] recording started on '{}' ({} Hz, {} ch)",
            opened.device_name, opened.sample_rate, opened.channels
        ));
        Ok(())
    }

    /// Close the input stream off-thread. Dropping a WASAPI stream joins its
    /// audio thread, which can stall on a misbehaving device.
    fn release_stream(&mut self) {
        if let Some(stream) = self.stream.take() {
            let _ = std::thread::Builder::new()
                .name("rf-mic-close".into())
                .spawn(move || drop(stream));
        }
    }

    pub fn discard(&mut self) {
        self.release_stream();
        lock(&self.samples).clear();
        println!("[RudariFlow] Audio recording discarded");
    }

    /// Mono 16 kHz audio recorded from source frame `from` on, while the
    /// recording goes on (a long dictation is transcribed in pieces).
    pub fn peek_16k(&self, from: usize) -> Vec<f32> {
        let channels = self.source_channels.max(1) as usize;
        let samples = lock(&self.samples);
        let start = (from * channels).min(samples.len());
        let end = samples.len() - (samples.len() - start) % channels;
        mono_16k(&samples[start..end], channels, self.source_sample_rate)
    }

    /// Source frames per 16 kHz sample (3.0 at 48 kHz).
    pub fn frames_per_16k(&self) -> f64 {
        self.source_sample_rate as f64 / 16_000.0
    }

    /// `stop_and_take_samples`, plus the audio from source frame `from` on
    /// (mono, 16 kHz, silence at both ends trimmed, empty when silent): the
    /// part of a long dictation not transcribed yet.
    pub fn stop_and_take_with_rest(&mut self, from: usize) -> (Result<Vec<f32>, String>, Vec<f32>) {
        self.release_stream();
        let rest = self.peek_16k(from);
        let rest = match trim_silence(&rest, 16_000) {
            Some((start, end)) => rest[start..end].to_vec(),
            None => Vec::new(),
        };
        (self.process_samples(), rest)
    }

    /// Stop the stream, dedup channels to mono, trim leading/trailing silence,
    /// and resample to 16 kHz. Returns the prepared sample buffer or
    /// `Err("no_speech")` if the entire recording was silence.
    pub fn stop_and_take_samples(&mut self) -> Result<Vec<f32>, String> {
        self.release_stream();
        self.process_samples()
    }

    fn process_samples(&mut self) -> Result<Vec<f32>, String> {
        println!("[RudariFlow] Audio recording stopped");

        let samples = lock(&self.samples);
        if samples.is_empty() {
            return Err("No audio captured".to_string());
        }
        println!("[RudariFlow] Captured {} raw samples", samples.len());

        let mono: Vec<f32> = if self.source_channels > 1 {
            samples
                .chunks(self.source_channels as usize)
                .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
                .collect()
        } else {
            samples.clone()
        };
        drop(samples);
        lock(&self.samples).clear();

        let trimmed: Vec<f32> = match trim_silence(&mono, self.source_sample_rate) {
            Some((start, end)) => mono[start..end].to_vec(),
            None => {
                println!("[RudariFlow] trim_silence: no speech detected");
                return Err("no_speech".to_string());
            }
        };
        println!(
            "[RudariFlow] Trimmed {} -> {} samples ({:.1}% kept)",
            mono.len(),
            trimmed.len(),
            100.0 * trimmed.len() as f32 / mono.len() as f32
        );

        let resampled = resample(&trimmed, self.source_sample_rate, 16_000);
        println!("[RudariFlow] Resampled to {} samples at 16kHz", resampled.len());
        Ok(resampled)
    }
}

struct OpenedStream {
    stream: SendStream,
    device_name: String,
    sample_rate: u32,
    channels: u16,
}

fn open_stream(
    app: &AppHandle,
    mic_name: &str,
    samples: Arc<Mutex<Vec<f32>>>,
) -> Result<OpenedStream, String> {
    let host = cpal::default_host();

    let device = if mic_name == "default" {
        host.default_input_device()
            .ok_or("No default input device found")?
    } else {
        host.input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().map(|n| n == mic_name).unwrap_or(false))
            .ok_or(format!("Microphone '{}' not found", mic_name))?
    };
    let device_name = device.name().unwrap_or_else(|_| mic_name.to_string());

    // Use the device's default config instead of forcing 16kHz
    let default_config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get default input config: {}", e))?;

    let sample_rate = default_config.sample_rate().0;
    let channels = default_config.channels();

    let config = cpal::StreamConfig {
        channels,
        sample_rate: cpal::SampleRate(sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    let app_handle = app.clone();
    let last_emit_ms = Arc::new(AtomicU64::new(0));
    let start = std::time::Instant::now();
    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                lock(&samples).extend_from_slice(data);

                let now_ms = start.elapsed().as_millis() as u64;
                let last = last_emit_ms.load(Ordering::Relaxed);
                if now_ms.saturating_sub(last) >= 33 {
                    last_emit_ms.store(now_ms, Ordering::Relaxed);
                    // RMS over this chunk (mono mix if multi-channel).
                    let sum_sq: f32 = data.iter().map(|s| s * s).sum();
                    let rms = (sum_sq / data.len().max(1) as f32).sqrt();
                    // Boost so quiet voice still moves the meter; cap at 1.
                    let level = (rms * 4.0).min(1.0);
                    let _ = app_handle.emit("audio-level", level);
                }
            },
            |err| {
                startup_log::log(&format!("[audio] stream error: {}", err));
            },
            None,
        )
        .map_err(|e| e.to_string())?;

    stream.play().map_err(|e| e.to_string())?;
    Ok(OpenedStream {
        stream: SendStream(stream),
        device_name,
        sample_rate,
        channels,
    })
}

/// Interleaved frames at `rate` as mono 16 kHz.
fn mono_16k(samples: &[f32], channels: usize, rate: u32) -> Vec<f32> {
    let mono: Vec<f32> = if channels > 1 {
        samples.chunks(channels).map(|f| f.iter().sum::<f32>() / f.len() as f32).collect()
    } else {
        samples.to_vec()
    };
    resample(&mono, rate, 16_000)
}

/// Where to cut a long recording (16 kHz mono): the middle of the quietest
/// 300 ms between `from_s` and `to_s` seconds, so no word is split.
pub fn quiet_cut(audio: &[f32], from_s: f32, to_s: f32) -> usize {
    const WINDOW: usize = 4_800; // 300 ms
    const STEP: usize = 800; // 50 ms
    let from = (from_s * 16_000.0) as usize;
    let to = ((to_s * 16_000.0) as usize).min(audio.len());
    if to < from + WINDOW {
        return to;
    }
    let mut best = (f32::MAX, to);
    let mut i = from;
    while i + WINDOW <= to {
        let energy: f32 = audio[i..i + WINDOW].iter().map(|s| s * s).sum();
        if energy < best.0 {
            best = (energy, i + WINDOW / 2);
        }
        i += STEP;
    }
    best.1
}

/// Write a `Vec<f32>` of 16 kHz mono samples as a 16-bit PCM WAV.
pub fn samples_to_wav(samples: &[f32], output_path: &PathBuf) -> Result<PathBuf, String> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = WavWriter::create(output_path, spec).map_err(|e| e.to_string())?;
    for &sample in samples {
        let amplitude = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer.write_sample(amplitude).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    println!("[RudariFlow] WAV saved to {:?}", output_path);
    Ok(output_path.clone())
}

/// Simple linear interpolation resampler
pub fn resample(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate {
        return samples.to_vec();
    }

    let ratio = from_rate as f64 / to_rate as f64;
    let output_len = (samples.len() as f64 / ratio) as usize;
    let mut output = Vec::with_capacity(output_len);

    for i in 0..output_len {
        let src_idx = i as f64 * ratio;
        let idx = src_idx as usize;
        let frac = src_idx - idx as f64;

        let sample = if idx + 1 < samples.len() {
            samples[idx] as f64 * (1.0 - frac) + samples[idx + 1] as f64 * frac
        } else {
            samples[idx.min(samples.len() - 1)] as f64
        };

        output.push(sample as f32);
    }

    output
}

const TRIM_RMS_THRESHOLD: f32 = 0.005;
const TRIM_PAD_MS: u32 = 200;

/// Find the speech bounds in `samples` using a 20 ms RMS window.
/// Returns `Some((start, end))` indices into `samples`, padded ±TRIM_PAD_MS.
/// Returns `None` if every window is below TRIM_RMS_THRESHOLD.
pub fn trim_silence(samples: &[f32], sample_rate: u32) -> Option<(usize, usize)> {
    if samples.is_empty() {
        return None;
    }
    let window = (sample_rate / 50) as usize; // 20 ms
    let pad = ((TRIM_PAD_MS as u64 * sample_rate as u64) / 1000) as usize;

    if window == 0 || samples.len() < window {
        let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
        let rms = (sum_sq / samples.len() as f32).sqrt();
        return if rms >= TRIM_RMS_THRESHOLD {
            Some((0, samples.len()))
        } else {
            None
        };
    }

    let mut first_loud: Option<usize> = None;
    let mut last_loud: Option<usize> = None;
    let mut i = 0;
    while i + window <= samples.len() {
        let chunk = &samples[i..i + window];
        let sum_sq: f32 = chunk.iter().map(|s| s * s).sum();
        let rms = (sum_sq / window as f32).sqrt();
        if rms >= TRIM_RMS_THRESHOLD {
            if first_loud.is_none() {
                first_loud = Some(i);
            }
            last_loud = Some(i + window);
        }
        i += window;
    }

    let (start, end) = match (first_loud, last_loud) {
        (Some(s), Some(e)) => (s, e),
        _ => return None,
    };

    let padded_start = start.saturating_sub(pad);
    let padded_end = (end + pad).min(samples.len());
    Some((padded_start, padded_end))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synth(silent_secs: f32, tone_secs: f32, trail_secs: f32, sr: u32) -> Vec<f32> {
        let n_silent = (silent_secs * sr as f32) as usize;
        let n_tone = (tone_secs * sr as f32) as usize;
        let n_trail = (trail_secs * sr as f32) as usize;
        let mut v = Vec::with_capacity(n_silent + n_tone + n_trail);
        v.extend(std::iter::repeat(0.0_f32).take(n_silent));
        v.extend(std::iter::repeat(0.5_f32).take(n_tone));
        v.extend(std::iter::repeat(0.0_f32).take(n_trail));
        v
    }

    #[test]
    fn trim_silence_finds_tone_in_silence() {
        let sr = 16_000;
        let buf = synth(1.0, 1.0, 1.0, sr);
        let bounds = trim_silence(&buf, sr).expect("should detect speech");
        let expected_start = (0.8 * sr as f32) as usize;
        let expected_end = (2.2 * sr as f32) as usize;
        let win = (sr / 50) as usize;
        assert!(
            bounds.0 <= expected_start + win && bounds.0 + win >= expected_start,
            "start {} not near {}",
            bounds.0,
            expected_start
        );
        assert!(
            bounds.1 <= expected_end + win && bounds.1 + win >= expected_end,
            "end {} not near {}",
            bounds.1,
            expected_end
        );
    }

    #[test]
    fn long_recordings_are_cut_in_the_quietest_spot() {
        let sr = 16_000;
        // Speech everywhere except a pause at 25.0-25.5 s.
        let mut audio = vec![0.3_f32; 30 * sr];
        for s in &mut audio[25 * sr..25 * sr + sr / 2] {
            *s = 0.0;
        }
        let cut = quiet_cut(&audio, 22.0, 29.0);
        assert!(cut > 25 * sr && cut < 25 * sr + sr / 2, "cut at {}", cut);
        // Too short for the window: cut at the end.
        assert_eq!(quiet_cut(&audio[..sr], 22.0, 29.0), sr);
    }

    #[test]
    fn stereo_48k_becomes_mono_16k() {
        let stereo: Vec<f32> = (0..48_000).flat_map(|_| [0.2_f32, 0.4]).collect();
        let mono = mono_16k(&stereo, 2, 48_000);
        assert_eq!(mono.len(), 16_000);
        assert!((mono[100] - 0.3).abs() < 1e-6);
    }

    #[test]
    fn trim_silence_returns_none_for_all_silence() {
        let sr = 16_000;
        let buf = vec![0.0_f32; sr as usize * 2];
        assert!(trim_silence(&buf, sr).is_none());
    }

    #[test]
    fn trim_silence_returns_full_range_for_all_speech() {
        let sr = 16_000;
        let buf = vec![0.5_f32; sr as usize * 2];
        let bounds = trim_silence(&buf, sr).expect("should detect speech");
        assert_eq!(bounds.0, 0);
        assert_eq!(bounds.1, buf.len());
    }

    #[test]
    fn trim_silence_handles_short_buffers() {
        let sr = 16_000;
        let short_loud = vec![0.5_f32; 100];
        assert!(trim_silence(&short_loud, sr).is_some());

        let short_quiet = vec![0.0_f32; 100];
        assert!(trim_silence(&short_quiet, sr).is_none());
    }

    #[test]
    fn samples_to_wav_roundtrips() {
        let dir = std::env::temp_dir().join("rudariflow_samples_to_wav_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.wav");

        let samples: Vec<f32> = (0..16_000).map(|i| (i as f32 / 16_000.0) * 0.5).collect();
        samples_to_wav(&samples, &path).expect("write wav");

        let mut reader = hound::WavReader::open(&path).expect("open written wav");
        let spec = reader.spec();
        assert_eq!(spec.channels, 1);
        assert_eq!(spec.sample_rate, 16_000);
        assert_eq!(spec.bits_per_sample, 16);
        let count = reader.samples::<i16>().count();
        assert_eq!(count, samples.len());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
