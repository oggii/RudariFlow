//! Audio from media files (MP3, M4A, WAV, FLAC, MP4, MOV, MKV, WebM, ...)
//! for file transcription and the soundboard, decoded by Windows Media
//! Foundation: no extra download, and every format Windows plays. Ogg is
//! decoded ourselves: Media Foundation has no byte-stream handler for the
//! Ogg container at all (confirmed: no `.ogg`/`audio-ogg` entry under
//! `HKLM\SOFTWARE\Microsoft\Windows Media Foundation\ByteStreamHandlers`,
//! even with Web Media Extensions installed, which only covers WebM).
//! Ogg Opus (WhatsApp voice messages) is decoded with libopus; Ogg Vorbis
//! with lewton (pure Rust), resampled with rubato when the file's own
//! rate isn't the target rate.

use std::path::Path;

/// Longest file taken: 3 hours are about 700 MB of samples.
pub const MAX_SECS: u64 = 3 * 3600;

/// The error for a file without an audio track, or without any samples.
pub const NO_AUDIO: &str = "the file has no audio";

/// The error for a file longer than `max_secs`: "longer than 3 hours",
/// "longer than 30 minutes".
pub fn too_long(max_secs: u64) -> String {
    if max_secs >= 3600 && max_secs.is_multiple_of(3600) {
        format!("longer than {} hours", max_secs / 3600)
    } else {
        format!("longer than {} minutes", max_secs / 60)
    }
}

/// Whether the file starts like an Ogg file.
fn is_ogg(path: &Path) -> bool {
    let mut magic = [0u8; 4];
    std::fs::File::open(path)
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut magic))
        .is_ok()
        && &magic == b"OggS"
}

/// Decode the first audio track of `path` to 16 kHz mono.
/// `progress(done, total)` is called while reading (units vary: compare
/// the two).
pub fn decode_16k_mono(path: &Path, mut progress: impl FnMut(u64, u64)) -> Result<Vec<f32>, String> {
    if is_ogg(path) {
        match decode_ogg_opus(path, 16_000, opus::Channels::Mono, MAX_SECS, &mut progress) {
            Err(e) if e == NOT_OPUS => {}
            decoded => return decoded,
        }
        // Media Foundation cannot open the Ogg container (see the module
        // doc comment); Vorbis is decoded ourselves instead of falling
        // through to it. FLAC-in-Ogg and other, rarer Ogg codecs still
        // fall through to Media Foundation below (which will fail too,
        // for the same reason, but that is unchanged pre-existing
        // behaviour for codecs outside the soundboard's 8 formats).
        match decode_ogg_vorbis(path, 16_000, 1, MAX_SECS, &mut progress) {
            Err(e) if e == NOT_VORBIS => {}
            decoded => return decoded,
        }
    }
    let (samples, rate, channels) = imp::decode(path, 16_000, 8, MAX_SECS, progress)?;
    let mono = mix_down(&samples, channels);
    drop(samples);
    Ok(if rate == 16_000 { mono } else { crate::audio::resample(&mono, rate, 16_000) })
}

/// Decode the first audio track of `path` to 48 kHz stereo, interleaved,
/// for the soundboard. A mono file plays on both sides; Windows mixes more
/// channels down to two. Fails with `NO_AUDIO` when there is nothing to
/// play and with `too_long(max_secs)` for a longer file.
pub fn decode_48k_stereo(path: &Path, max_secs: u64) -> Result<Vec<f32>, String> {
    let stereo = if is_ogg(path) {
        match decode_ogg_opus(path, 48_000, opus::Channels::Stereo, max_secs, |_, _| {}) {
            Err(e) if e == NOT_OPUS => match decode_ogg_vorbis(path, 48_000, 2, max_secs, |_, _| {}) {
                Err(e) if e == NOT_VORBIS => mf_stereo(path, max_secs)?,
                decoded => decoded?,
            },
            decoded => decoded?,
        }
    } else {
        mf_stereo(path, max_secs)?
    };
    if stereo.is_empty() {
        return Err(NO_AUDIO.to_string());
    }
    Ok(stereo)
}

/// The Media Foundation path to 48 kHz stereo, shared by the non-Ogg case
/// and the Ogg fallback (any Ogg codec besides Opus and Vorbis).
fn mf_stereo(path: &Path, max_secs: u64) -> Result<Vec<f32>, String> {
    let (samples, rate, channels) = imp::decode(path, 48_000, 2, max_secs, |_, _| {})?;
    let stereo = to_stereo(samples, channels);
    Ok(if rate == 48_000 { stereo } else { resample_stereo(&stereo, rate, 48_000) })
}

const NOT_OPUS: &str = "only Opus audio is supported in Ogg files";
const NOT_VORBIS: &str = "not a Vorbis stream";

/// Ogg Opus, decoded by libopus straight to `rate` Hz with `channels` (it
/// resamples and mixes itself).
fn decode_ogg_opus(
    path: &Path,
    rate: u32,
    channels: opus::Channels,
    max_secs: u64,
    mut progress: impl FnMut(u64, u64),
) -> Result<Vec<f32>, String> {
    use std::io::Seek;
    let per_frame = match channels {
        opus::Channels::Mono => 1,
        opus::Channels::Stereo => 2,
    };
    let file = std::fs::File::open(path).map_err(|e| format!("cannot open the file: {}", e))?;
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut reader = ogg::PacketReader::new(std::io::BufReader::new(file));
    let bad = |e: ogg::OggReadError| format!("cannot read the file: {}", e);
    let head = reader.read_packet().map_err(bad)?.ok_or("the file is empty")?;
    if !head.data.starts_with(b"OpusHead") || head.data.len() < 19 {
        return Err(NOT_OPUS.to_string());
    }
    // Frames at 48 kHz to drop at the start (encoder delay), at our rate.
    let pre_skip = u16::from_le_bytes([head.data[10], head.data[11]]) as usize * rate as usize / 48_000;
    let _tags = reader.read_packet().map_err(bad)?;
    let mut decoder = opus::Decoder::new(rate, channels).map_err(|e| format!("Opus: {}", e))?;
    let serial = head.stream_serial();
    let max_samples = (max_secs as usize + 60) * rate as usize * per_frame;
    let mut out = Vec::new();
    // 120 ms, the longest Opus frame.
    let mut frame = vec![0f32; rate as usize * 120 / 1000 * per_frame];
    let mut packets = 0u32;
    while let Some(packet) = reader.read_packet().map_err(bad)? {
        if packet.stream_serial() != serial {
            continue;
        }
        // A damaged packet is skipped instead of failing the whole file.
        // `n` counts frames (samples per channel).
        if let Ok(n) = decoder.decode_float(&packet.data, &mut frame, false) {
            out.extend_from_slice(&frame[..n * per_frame]);
        }
        if out.len() > max_samples {
            return Err(too_long(max_secs));
        }
        packets += 1;
        if packets.is_multiple_of(500) {
            let done = reader.get_mut().stream_position().unwrap_or(0);
            progress(done, total);
        }
    }
    progress(total, total);
    out.drain(..(pre_skip * per_frame).min(out.len()));
    Ok(out)
}

/// Ogg Vorbis, decoded by lewton straight from the raw packets (no Ogg
/// container support is asked of Media Foundation, which does not have
/// any). Mixed to `target_channels` (1: mono; 2: stereo, mono on both
/// sides) and resampled to `rate` with rubato when the file's own rate
/// differs — unlike libopus, lewton neither resamples nor mixes for us.
fn decode_ogg_vorbis(
    path: &Path,
    rate: u32,
    target_channels: usize,
    max_secs: u64,
    mut progress: impl FnMut(u64, u64),
) -> Result<Vec<f32>, String> {
    use lewton::audio::{read_audio_packet_generic, PreviousWindowRight};
    use lewton::header::{read_header_ident, read_header_setup, HeaderReadError};
    use lewton::samples::InterleavedSamples;
    use std::io::Seek;

    let file = std::fs::File::open(path).map_err(|e| format!("cannot open the file: {}", e))?;
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut reader = ogg::PacketReader::new(std::io::BufReader::new(file));
    let bad = |e: ogg::OggReadError| format!("cannot read the file: {}", e);
    let head = reader.read_packet().map_err(bad)?.ok_or("the file is empty")?;
    let ident = match read_header_ident(&head.data) {
        Err(HeaderReadError::NotVorbisHeader) => return Err(NOT_VORBIS.to_string()),
        Err(e) => return Err(format!("Vorbis: {:?}", e)),
        Ok(ident) => ident,
    };
    let serial = head.stream_serial();
    let channels = (ident.audio_channels as usize).max(1);
    let source_rate = ident.audio_sample_rate;
    let _comment = reader.read_packet().map_err(bad)?.ok_or("the file is empty")?;
    let setup_packet = reader.read_packet().map_err(bad)?.ok_or("the file is empty")?;
    let setup = read_header_setup(&setup_packet.data, ident.audio_channels, (ident.blocksize_0, ident.blocksize_1))
        .map_err(|e| format!("Vorbis: {:?}", e))?;

    let max_samples = (max_secs as usize + 60) * source_rate as usize * channels;
    let mut pwr = PreviousWindowRight::new();
    let mut out: Vec<f32> = Vec::new();
    let mut packets = 0u32;
    while let Some(packet) = reader.read_packet().map_err(bad)? {
        if packet.stream_serial() != serial {
            continue;
        }
        // A damaged packet is skipped instead of failing the whole file,
        // as for Opus above.
        if let Ok(decoded) = read_audio_packet_generic::<InterleavedSamples<f32>>(&ident, &setup, &packet.data, &mut pwr) {
            out.extend_from_slice(&decoded.samples);
        }
        if out.len() > max_samples {
            return Err(too_long(max_secs));
        }
        packets += 1;
        if packets.is_multiple_of(500) {
            let done = reader.get_mut().stream_position().unwrap_or(0);
            progress(done, total);
        }
    }
    progress(total, total);

    let mixed = if target_channels <= 1 { mix_down(&out, channels) } else { to_stereo(out, channels) };
    Ok(if source_rate == rate { mixed } else { resample_interleaved(&mixed, target_channels.max(1), source_rate, rate) })
}

/// Mono from interleaved `channels`.
fn mix_down(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    samples.chunks(channels).map(|f| f.iter().sum::<f32>() / f.len() as f32).collect()
}

/// Interleaved stereo from interleaved `channels`: mono on both sides, the
/// first two of more.
fn to_stereo(samples: Vec<f32>, channels: usize) -> Vec<f32> {
    match channels {
        0 | 1 => samples.iter().flat_map(|&s| [s, s]).collect(),
        2 => samples,
        n => samples.chunks_exact(n).flat_map(|f| [f[0], f[1]]).collect(),
    }
}

/// `audio::resample` for interleaved stereo.
fn resample_stereo(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
    let left: Vec<f32> = samples.iter().step_by(2).copied().collect();
    let right: Vec<f32> = samples.iter().skip(1).step_by(2).copied().collect();
    let left = crate::audio::resample(&left, from, to);
    let right = crate::audio::resample(&right, from, to);
    left.into_iter().zip(right).flat_map(|(l, r)| [l, r]).collect()
}

/// Interleaved `channels`-channel resample with rubato's windowed-sinc
/// resampler (used for Vorbis, which — unlike libopus — does not resample
/// for us). `channels` is 1 or 2 here.
fn resample_interleaved(samples: &[f32], channels: usize, from: u32, to: u32) -> Vec<f32> {
    if from == to || samples.is_empty() || channels == 0 {
        return samples.to_vec();
    }
    let frames = samples.len() / channels;
    let mut planar: Vec<Vec<f32>> = vec![Vec::with_capacity(frames); channels];
    for frame in samples.chunks_exact(channels) {
        for (c, &s) in frame.iter().enumerate() {
            planar[c].push(s);
        }
    }
    use rubato::Resampler;
    let ratio = to as f64 / from as f64;
    let params = rubato::SincInterpolationParameters {
        sinc_len: 128,
        f_cutoff: 0.925,
        oversampling_factor: 128,
        interpolation: rubato::SincInterpolationType::Linear,
        window: rubato::WindowFunction::BlackmanHarris2,
    };
    // A whole file at once: no real-time deadline, so a chunk size that
    // covers short soundboard sounds in one call is fine; longer files
    // (Files-tab transcription) just take a few more chunks.
    let chunk_size = 4096.min(frames.max(1));
    let mut resampler = match rubato::SincFixedIn::<f32>::new(ratio, 2.0, params, chunk_size, channels) {
        Ok(r) => r,
        Err(_) => return samples.to_vec(),
    };
    let delay = resampler.output_delay();
    let mut out_planar: Vec<Vec<f32>> = vec![Vec::new(); channels];
    let mut pos = 0;
    while pos < frames {
        let need = resampler.input_frames_next();
        let end = (pos + need).min(frames);
        let chunk: Vec<&[f32]> = planar.iter().map(|c| &c[pos..end]).collect();
        let result =
            if end - pos == need { resampler.process(&chunk, None) } else { resampler.process_partial(Some(&chunk), None) };
        if let Ok(result) = result {
            for (o, r) in out_planar.iter_mut().zip(result) {
                o.extend(r);
            }
        }
        pos = end;
    }
    // Flush the filter's group delay: one more call with no input.
    if let Ok(result) = resampler.process_partial::<Vec<f32>>(None, None) {
        for (o, r) in out_planar.iter_mut().zip(result) {
            o.extend(r);
        }
    }
    let target_frames = (frames as f64 * ratio).round() as usize;
    for chan in out_planar.iter_mut() {
        chan.drain(..delay.min(chan.len()));
        chan.resize(target_frames, 0.0);
    }
    let mut out = Vec::with_capacity(target_frames * channels);
    for i in 0..target_frames {
        for chan in &out_planar {
            out.push(chan[i]);
        }
    }
    out
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

    /// Ask the reader for float samples; with a format, also for that rate
    /// and channel count (Windows' resampler, far better than resampling
    /// afterwards).
    fn set_output(reader: &IMFSourceReader, format: Option<(u32, u32)>) -> windows::core::Result<()> {
        unsafe {
            let wanted = MFCreateMediaType()?;
            wanted.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            wanted.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float)?;
            if let Some((rate, channels)) = format {
                wanted.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate)?;
                wanted.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels)?;
                wanted.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 32)?;
                wanted.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4 * channels)?;
                wanted.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 4 * rate * channels)?;
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

    /// Decode the first audio track as interleaved float at `rate` Hz with
    /// the file's own channels, at most `max_channels` (Windows mixes more
    /// down; its downmix lowers the level by 3 dB, so no fewer are asked
    /// for). Falls back to the file's own format when Windows cannot
    /// convert. Returns the samples, their rate and their channel count.
    pub fn decode(
        path: &Path,
        rate: u32,
        max_channels: u32,
        max_secs: u64,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<(Vec<f32>, u32, usize), String> {
        let _mf = Mf::start()?;
        let reader = unsafe { MFCreateSourceReaderFromURL(&HSTRING::from(path.as_os_str()), None) }
            .map_err(|e| format!("cannot open the file: {}", e.message()))?;
        unsafe {
            let _ = reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false);
            reader.SetStreamSelection(AUDIO, true).map_err(|_| super::NO_AUDIO.to_string())?;
        }
        let native_channels = unsafe { reader.GetNativeMediaType(AUDIO, 0) }
            .and_then(|t| unsafe { t.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS) })
            .unwrap_or(1)
            .clamp(1, max_channels.max(1));
        if set_output(&reader, Some((rate, native_channels))).is_err() {
            set_output(&reader, None).map_err(|e| format!("cannot decode the audio: {}", e.message()))?;
        }
        let (rate, channels) = unsafe {
            let current = reader.GetCurrentMediaType(AUDIO).map_err(|e| e.message().to_string())?;
            (
                current.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).unwrap_or(rate),
                current.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).unwrap_or(1).max(1) as usize,
            )
        };
        let total_ms = duration_ms(&reader);
        if total_ms / 1000 > max_secs {
            return Err(super::too_long(max_secs));
        }
        let max_samples = (max_secs as usize + 60) * rate as usize * channels;

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
                return Err(super::too_long(max_secs));
            }
        }
        progress(total_ms, total_ms);
        Ok((out, rate, channels))
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn decode(
        _path: &std::path::Path,
        _rate: u32,
        _max_channels: u32,
        _max_secs: u64,
        _progress: impl FnMut(u64, u64),
    ) -> Result<(Vec<f32>, u32, usize), String> {
        Err("reading media files needs Windows".to_string())
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

    #[test]
    fn mono_plays_on_both_sides_and_extra_channels_are_dropped() {
        assert_eq!(to_stereo(vec![0.1, 0.2], 1), vec![0.1, 0.1, 0.2, 0.2]);
        assert_eq!(to_stereo(vec![0.1, 0.2], 2), vec![0.1, 0.2]);
        assert_eq!(to_stereo(vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6], 3), vec![0.1, 0.2, 0.4, 0.5]);
        let up = resample_stereo(&[0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5], 24_000, 48_000);
        assert_eq!(up.len(), 16);
        assert!(up.chunks(2).all(|f| f == [0.5, -0.5]));
    }

    #[test]
    fn the_limit_names_hours_or_minutes() {
        assert_eq!(too_long(MAX_SECS), "longer than 3 hours");
        assert_eq!(too_long(30 * 60), "longer than 30 minutes");
    }

    #[cfg(windows)]
    fn fixture(name: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/soundboard").join(name)
    }

    #[cfg(windows)]
    #[test]
    fn every_soundboard_format_decodes_to_48k_stereo() {
        for ext in ["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"] {
            let samples = decode_48k_stereo(&fixture(&format!("tone.{}", ext)), 60).unwrap_or_else(|e| panic!("{}: {}", ext, e));
            assert_eq!(samples.len() % 2, 0, "{}: interleaved stereo", ext);
            let frames = samples.len() / 2;
            // 1 s, give or take the encoder's padding.
            assert!((44_000..=52_000).contains(&frames), "{}: {} frames", ext, frames);
            // 0.1 s to 0.9 s: the tone is on the left, the right is silent.
            let window: Vec<&[f32]> = samples.chunks(2).skip(4_800).take(38_400).collect();
            let rms = |c: usize| (window.iter().map(|f| (f[c] as f64).powi(2)).sum::<f64>() / window.len() as f64).sqrt();
            assert!((0.30..0.40).contains(&rms(0)), "{}: left RMS {}", ext, rms(0));
            assert!(rms(1) < 0.05, "{}: right RMS {}", ext, rms(1));
            // 440 Hz at 48 kHz: 704 zero crossings in 0.8 s (647 if the rate were wrong).
            let crossings = window.windows(2).filter(|w| (w[0][0] < 0.0) != (w[1][0] < 0.0)).count();
            assert!((690..=718).contains(&crossings), "{}: {} zero crossings", ext, crossings);
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_file_without_audio_or_over_the_limit_is_refused() {
        assert_eq!(decode_48k_stereo(&fixture("video-only.m4a"), 60), Err(NO_AUDIO.to_string()));
        assert_eq!(decode_48k_stereo(&fixture("tone.wav"), 0), Err(too_long(0)));
        assert_eq!(decode_48k_stereo(&fixture("tone.mp3"), 0), Err(too_long(0)));
    }

    // The Files tab's `decode_16k_mono` hits the same Ogg Vorbis path as the
    // soundboard's `decode_48k_stereo` (both fall through from `decode_ogg_opus`
    // to `decode_ogg_vorbis`), so the fixture that stands in for the format is
    // the same `tone.ogg`. Mixed to mono, the left-channel tone is halved
    // (averaged with the silent right channel): 0.5 * sin becomes 0.25 * sin.
    #[cfg(windows)]
    #[test]
    fn the_vorbis_fixture_also_decodes_through_the_16k_mono_path() {
        let samples = decode_16k_mono(&fixture("tone.ogg"), |_, _| {}).expect("decode");
        // 1 s at 16 kHz, give or take the encoder's padding.
        assert!((15_000..=17_500).contains(&samples.len()), "{} samples", samples.len());
        // 0.1 s to 0.9 s.
        let window: Vec<f32> = samples.iter().skip(1_600).take(12_800).copied().collect();
        let rms = (window.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / window.len() as f64).sqrt();
        assert!((0.15..0.21).contains(&rms), "mono RMS {}", rms);
        // 440 Hz: 704 zero crossings in 0.8 s, independent of the sample rate.
        let crossings = window.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
        assert!((690..=718).contains(&crossings), "{} zero crossings", crossings);
    }
}
