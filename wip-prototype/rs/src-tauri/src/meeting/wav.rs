//! A meeting's tracks: 16 kHz mono 16-bit WAV files that grow every second
//! while the meeting records. The header's sizes are written when a track
//! is closed, and repaired from the file's length after a crash.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

pub const RATE: u32 = 16_000;
/// The canonical PCM header: RIFF, fmt (16 bytes), data.
const HEADER: u64 = 44;

/// A track being written.
pub struct TrackFile {
    file: File,
    samples: u64,
    bytes: Vec<u8>,
}

/// The 44-byte header of a file with `samples` samples.
fn header(samples: u64) -> [u8; 44] {
    let data = (samples * 2).min(u32::MAX as u64 - 36) as u32;
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
    h[24..28].copy_from_slice(&RATE.to_le_bytes());
    h[28..32].copy_from_slice(&(RATE * 2).to_le_bytes()); // bytes per second
    h[32..34].copy_from_slice(&2u16.to_le_bytes()); // block align
    h[34..36].copy_from_slice(&16u16.to_le_bytes()); // bits per sample
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data.to_le_bytes());
    h
}

impl TrackFile {
    /// A new, empty track at `path` (an existing file is replaced).
    pub fn create(path: &Path) -> Result<TrackFile, String> {
        let mut file = File::create(path).map_err(|e| format!("{}: {}", path.display(), e))?;
        file.write_all(&header(0)).map_err(|e| e.to_string())?;
        Ok(TrackFile { file, samples: 0, bytes: Vec::new() })
    }

    pub fn samples(&self) -> u64 {
        self.samples
    }

    /// Append samples (-1.0 … 1.0, clipped) as 16-bit PCM.
    pub fn append(&mut self, samples: &[f32]) -> Result<(), String> {
        self.bytes.clear();
        for &s in samples {
            let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            self.bytes.extend_from_slice(&v.to_le_bytes());
        }
        self.file.write_all(&self.bytes).map_err(|e| e.to_string())?;
        self.samples += samples.len() as u64;
        Ok(())
    }

    /// Write the sizes into the header (on stop).
    pub fn finish(&mut self) -> Result<(), String> {
        self.file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        self.file.write_all(&header(self.samples)).map_err(|e| e.to_string())?;
        self.file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
        self.file.flush().map_err(|e| e.to_string())
    }
}

/// How many samples the file holds, from its length (not its header).
pub fn sample_count(path: &Path) -> u64 {
    std::fs::metadata(path).map_or(0, |m| m.len().saturating_sub(HEADER) / 2)
}

/// Write the sizes into the header of a track a crash left open, and drop
/// an odd last byte. Returns the samples.
pub fn repair(path: &Path) -> Result<u64, String> {
    let samples = sample_count(path);
    let mut file = OpenOptions::new().write(true).open(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    file.set_len(HEADER + samples * 2).map_err(|e| e.to_string())?;
    file.write_all(&header(samples)).map_err(|e| e.to_string())?;
    Ok(samples)
}

/// Samples `from..to` of a track (fewer at its end; none past it).
pub fn read_range(path: &Path, from: u64, to: u64) -> Result<Vec<f32>, String> {
    // Clamp to what the file holds before allocating anything.
    let to = to.min(sample_count(path));
    if to <= from {
        return Ok(Vec::new());
    }
    let mut file = File::open(path).map_err(|e| format!("{}: {}", path.display(), e))?;
    file.seek(SeekFrom::Start(HEADER + from * 2)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(((to - from) * 2) as usize);
    file.take((to - from) * 2).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b) as f32 / i16::MAX as f32).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rudariflow_meeting_wav_{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ramp(n: usize) -> Vec<f32> {
        (0..n).map(|i| (i % 100) as f32 / 200.0).collect()
    }

    #[test]
    fn a_finished_track_is_a_wav_any_player_reads() {
        let path = temp("finished").join("you.wav");
        let mut track = TrackFile::create(&path).unwrap();
        track.append(&ramp(16_000)).unwrap();
        track.append(&[2.0, -2.0]).unwrap();
        track.finish().unwrap();
        assert_eq!(track.samples(), 16_002);
        let reader = hound::WavReader::open(&path).unwrap();
        let spec = reader.spec();
        assert_eq!((spec.channels, spec.sample_rate, spec.bits_per_sample), (1, 16_000, 16));
        assert_eq!(reader.duration(), 16_002);
        let samples: Vec<i16> = reader.into_samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(samples[16_000..], [i16::MAX, -i16::MAX], "clipped");
        assert_eq!(sample_count(&path), 16_002);
    }

    #[test]
    fn a_track_a_crash_left_open_is_repaired() {
        let path = temp("crash").join("others.wav");
        let mut track = TrackFile::create(&path).unwrap();
        track.append(&ramp(8_000)).unwrap();
        drop(track); // no finish(): the header still says 0 samples
        // A half-written last sample.
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(&[7]).unwrap();
        assert_eq!(repair(&path).unwrap(), 8_000);
        let reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.duration(), 8_000);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 44 + 16_000);
    }

    #[test]
    fn ranges_are_read_while_the_track_grows() {
        let path = temp("range").join("you.wav");
        let mut track = TrackFile::create(&path).unwrap();
        let audio = ramp(1_000);
        track.append(&audio).unwrap();
        let got = read_range(&path, 100, 200).unwrap();
        assert_eq!(got.len(), 100);
        for (g, want) in got.iter().zip(&audio[100..200]) {
            assert!((g - want).abs() < 1e-4, "{} vs {}", g, want);
        }
        assert_eq!(read_range(&path, 900, 5_000).unwrap().len(), 100, "clipped at the end");
        assert!(read_range(&path, 2_000, 3_000).unwrap().is_empty(), "past the end");
        assert!(read_range(&path, 10, 10).unwrap().is_empty());
        assert_eq!(read_range(&path, 900, u64::MAX).unwrap().len(), 100, "an absurd end is clamped");
        assert!(read_range(&path, u64::MAX - 1, u64::MAX).unwrap().is_empty());
        track.append(&audio).unwrap();
        assert_eq!(read_range(&path, 900, 1_100).unwrap().len(), 200, "the new part");
    }
}
