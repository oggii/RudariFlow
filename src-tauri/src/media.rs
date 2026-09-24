//! Audio from media files (MP3, M4A, WAV, FLAC, MP4, MOV, MKV, WebM, ...)
//! for file transcription, decoded by Windows Media Foundation: no extra
//! download, and every format Windows plays. Ogg Opus (WhatsApp voice
//! messages), which Windows cannot open, is decoded with libopus.

/// Longest file taken: 3 hours are about 700 MB of samples.
pub const MAX_SECS: u64 = 3 * 3600;

/// Decode the first audio track of `path` to 16 kHz mono.
/// `progress(done, total)` is called while reading (units vary: compare
/// the two).
pub fn decode_16k_mono(path: &std::path::Path, mut progress: impl FnMut(u64, u64)) -> Result<Vec<f32>, String> {
    let mut magic = [0u8; 4];
    let is_ogg = std::fs::File::open(path)
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut magic))
        .is_ok()
        && &magic == b"OggS";
    if is_ogg {
        // Ogg Vorbis and FLAC in Ogg go to Media Foundation, which opens them
        // where Windows has the codec (Web Media Extensions).
        match decode_ogg_opus(path, &mut progress) {
            Err(e) if e == NOT_OPUS => {}
            decoded => return decoded,
        }
    }
    imp::decode(path, progress)
}

const NOT_OPUS: &str = "only Opus audio is supported in Ogg files";

/// Ogg Opus, decoded by libopus straight to 16 kHz mono (it resamples and
/// downmixes itself).
fn decode_ogg_opus(path: &std::path::Path, mut progress: impl FnMut(u64, u64)) -> Result<Vec<f32>, String> {
    use std::io::Seek;
    let file = std::fs::File::open(path).map_err(|e| format!("cannot open the file: {}", e))?;
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut reader = ogg::PacketReader::new(std::io::BufReader::new(file));
    let bad = |e: ogg::OggReadError| format!("cannot read the file: {}", e);
    let head = reader.read_packet().map_err(bad)?.ok_or("the file is empty")?;
    if !head.data.starts_with(b"OpusHead") || head.data.len() < 19 {
        return Err(NOT_OPUS.to_string());
    }
    // Samples at 48 kHz to drop at the start (encoder delay).
    let pre_skip = u16::from_le_bytes([head.data[10], head.data[11]]) as usize / 3;
    let _tags = reader.read_packet().map_err(bad)?;
    let mut decoder =
        opus::Decoder::new(16_000, opus::Channels::Mono).map_err(|e| format!("Opus: {}", e))?;
    let serial = head.stream_serial();
    let max_samples = (MAX_SECS as usize + 60) * 16_000;
    let mut out = Vec::new();
    // 120 ms, the longest Opus frame, at 16 kHz.
    let mut frame = vec![0f32; 1920];
    let mut packets = 0u32;
    while let Some(packet) = reader.read_packet().map_err(bad)? {
        if packet.stream_serial() != serial {
            continue;
        }
        // A damaged packet is skipped instead of failing the whole file.
        if let Ok(n) = decoder.decode_float(&packet.data, &mut frame, false) {
            out.extend_from_slice(&frame[..n]);
        }
        if out.len() > max_samples {
            return Err(format!("longer than {} hours", MAX_SECS / 3600));
        }
        packets += 1;
        if packets.is_multiple_of(500) {
            let done = reader.get_mut().stream_position().unwrap_or(0);
            progress(done, total);
        }
    }
    progress(total, total);
    out.drain(..pre_skip.min(out.len()));
    Ok(out)
}

/// Mono from interleaved `channels`.
fn mix_down(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    samples.chunks(channels).map(|f| f.iter().sum::<f32>() / f.len() as f32).collect()
}

#[cfg(windows)]
mod imp {
    use std::path::Path;
    use windows::core::HSTRING;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::System::Variant::VT_UI8;

    /// MFStartup/MFShutdown around one decode.
    struct Mf;

    impl Mf {
        fn start() -> Result<Self, String> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).map_err(|e| format!("Media Foundation: {e}"))?;
            }
            Ok(Mf)
        }
    }

    impl Drop for Mf {
        fn drop(&mut self) {
            unsafe {
                let _ = MFShutdown();
            }
        }
    }

    const AUDIO: u32 = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;

    /// Ask the reader for float samples; with `channels`, also for 16 kHz
    /// (Windows' resampler, far better than resampling afterwards). The
    /// channels stay: Windows' downmix lowers the level by 3 dB.
    fn set_output(reader: &IMFSourceReader, channels: Option<u32>) -> windows::core::Result<()> {
        unsafe {
            let wanted = MFCreateMediaType()?;
            wanted.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            wanted.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float)?;
            if let Some(channels) = channels {
                wanted.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 16_000)?;
                wanted.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels)?;
                wanted.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 32)?;
                wanted.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4 * channels)?;
                wanted.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 64_000 * channels)?;
            }
            reader.SetCurrentMediaType(AUDIO, None, &wanted)
        }
    }

    fn duration_ms(reader: &IMFSourceReader) -> u64 {
        unsafe {
            match reader.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION) {
                Ok(pv) if pv.Anonymous.Anonymous.vt == VT_UI8 => pv.Anonymous.Anonymous.Anonymous.uhVal / 10_000,
                _ => 0,
            }
        }
    }

    pub fn decode(path: &Path, mut progress: impl FnMut(u64, u64)) -> Result<Vec<f32>, String> {
        let _mf = Mf::start()?;
        let reader = unsafe { MFCreateSourceReaderFromURL(&HSTRING::from(path.as_os_str()), None) }
            .map_err(|e| format!("cannot open the file: {}", e.message()))?;
        unsafe {
            let _ = reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false);
            reader.SetStreamSelection(AUDIO, true).map_err(|_| "the file has no audio".to_string())?;
        }
        let native_channels = unsafe { reader.GetNativeMediaType(AUDIO, 0) }
            .and_then(|t| unsafe { t.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS) })
            .unwrap_or(1)
            .clamp(1, 8);
        if set_output(&reader, Some(native_channels)).is_err() {
            set_output(&reader, None).map_err(|e| format!("cannot decode the audio: {}", e.message()))?;
        }
        let (rate, channels) = unsafe {
            let current = reader.GetCurrentMediaType(AUDIO).map_err(|e| e.message().to_string())?;
            (
                current.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(16_000),
                current.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(1).max(1) as usize,
            )
        };
        let total_ms = duration_ms(&reader);
        if total_ms / 1000 > super::MAX_SECS {
            return Err(format!("longer than {} hours", super::MAX_SECS / 3600));
        }
        let max_samples = (super::MAX_SECS as usize + 60) * rate as usize * channels;

        let mut out: Vec<f32> = Vec::with_capacity((total_ms as usize * rate as usize / 1000 * channels).min(max_samples));
        loop {
            let mut flags = 0u32;
            let mut timestamp = 0i64;
            let mut sample: Option<IMFSample> = None;
            unsafe {
                reader
                    .ReadSample(AUDIO, 0, None, Some(&mut flags), Some(&mut timestamp), Some(&mut sample))
                    .map_err(|e| format!("cannot decode the audio: {}", e.message()))?;
            }
            if let Some(sample) = sample {
                unsafe {
                    let buffer = sample.ConvertToContiguousBuffer().map_err(|e| e.message().to_string())?;
                    let mut data: *mut u8 = std::ptr::null_mut();
                    let mut len = 0u32;
                    buffer.Lock(&mut data, None, Some(&mut len)).map_err(|e| e.message().to_string())?;
                    if !data.is_null() {
                        // SAFETY: the locked buffer holds `len` bytes of f32 samples.
                        let floats = std::slice::from_raw_parts(data as *const f32, len as usize / 4);
                        out.extend_from_slice(floats);
                    }
                    let _ = buffer.Unlock();
                }
                progress((timestamp.max(0) / 10_000) as u64, total_ms);
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
            if out.len() > max_samples {
                return Err(format!("longer than {} hours", super::MAX_SECS / 3600));
            }
        }
        progress(total_ms, total_ms);
        let mono = super::mix_down(&out, channels);
        drop(out);
        Ok(if rate == 16_000 { mono } else { crate::audio::resample(&mono, rate, 16_000) })
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn decode(_path: &std::path::Path, _progress: impl FnMut(u64, u64)) -> Result<Vec<f32>, String> {
        Err("file transcription needs Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_are_averaged() {
        assert_eq!(mix_down(&[0.2, 0.4, -1.0, 1.0], 2), vec![0.3, 0.0]);
        assert_eq!(mix_down(&[0.5, 0.1], 1), vec![0.5, 0.1]);
    }

    #[cfg(windows)]
    #[test]
    fn a_wav_file_decodes_to_the_same_samples() {
        let path = std::env::temp_dir().join("rudariflow_media_test.wav");
        let tone: Vec<f32> = (0..16_000).map(|i| (i as f32 * 0.05).sin() * 0.5).collect();
        crate::audio::samples_to_wav(&tone, &path).expect("write wav");
        let decoded = decode_16k_mono(&path, |_, _| {}).expect("decode");
        assert!((decoded.len() as i64 - 16_000).abs() < 200, "{} samples", decoded.len());
        // 16-bit WAV: the same wave within rounding.
        let err = decoded.iter().zip(&tone).skip(500).take(1000).map(|(a, b)| (a - b).abs()).fold(0.0_f32, f32::max);
        assert!(err < 0.01, "max error {}", err);
        assert!(decode_16k_mono(&std::env::temp_dir().join("missing_rudariflow.mp3"), |_, _| {}).is_err());
    }
}
