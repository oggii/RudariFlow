use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

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

    pub fn start(&mut self, app: &AppHandle, mic_name: &str) -> Result<(), String> {
        // Clear any leftover samples from previous recording
        self.samples.lock().unwrap().clear();

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

        // Use the device's default config instead of forcing 16kHz
        let default_config = device
            .default_input_config()
            .map_err(|e| format!("Failed to get default input config: {}", e))?;

        let sample_rate = default_config.sample_rate().0;
        let channels = default_config.channels();

        println!("[RudariFlow] Mic config: {}Hz, {} channels", sample_rate, channels);

        self.source_sample_rate = sample_rate;
        self.source_channels = channels;

        let config = cpal::StreamConfig {
            channels,
            sample_rate: cpal::SampleRate(sample_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        let samples = self.samples.clone();
        let app_handle = app.clone();
        let last_emit_ms = Arc::new(AtomicU64::new(0));
        let start = std::time::Instant::now();
        let stream = device
            .build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    let mut buf = samples.lock().unwrap();
                    buf.extend_from_slice(data);
                    drop(buf);

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
                    eprintln!("[RudariFlow] Audio stream error: {}", err);
                },
                None,
            )
            .map_err(|e| e.to_string())?;

        stream.play().map_err(|e| e.to_string())?;
        self.stream = Some(SendStream(stream));
        println!("[RudariFlow] Audio recording started");
        Ok(())
    }

    pub fn discard(&mut self) {
        self.stream = None;
        self.samples.lock().unwrap().clear();
        println!("[RudariFlow] Audio recording discarded");
    }

    /// Stop the stream, dedup channels to mono, trim leading/trailing silence,
    /// and resample to 16 kHz. Returns the prepared sample buffer or
    /// `Err("no_speech")` if the entire recording was silence.
    pub fn stop_and_take_samples(&mut self) -> Result<Vec<f32>, String> {
        self.stream = None;
        println!("[RudariFlow] Audio recording stopped");

        let samples = self.samples.lock().unwrap();
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
        self.samples.lock().unwrap().clear();

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

    /// Stop the stream and write a 16 kHz mono 16-bit WAV. Used by the Groq
    /// path which uploads a WAV file. Wraps `stop_and_take_samples`.
    pub fn stop_and_save(&mut self, output_path: &PathBuf) -> Result<PathBuf, String> {
        let samples = self.stop_and_take_samples()?;
        samples_to_wav(&samples, output_path)?;
        Ok(output_path.clone())
    }
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
