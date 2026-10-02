# Soundboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Soundpad-style Soundboard tab (that can pop out into its own window) plays sounds on hotkeys into a VB-Audio virtual cable together with the user's microphone, and on the user's headphones.
**Architecture:** A new `soundboard` module in the Rust library holds the library (`soundboard.json`, copied originals, prepared 48 kHz WAVs), a pure mixer and a pure drift buffer, and a cpal engine (mic in, cable out, headphones out, one reader thread per playing sound) behind a `Soundboard` object in `AppState`. main.rs adds the Tauri commands, the events and the sound/stop-all hotkeys, which are registered only while the "Virtual microphone" is on. The frontend is one component (`src/soundboard/board.ts`) that renders into the tab and into the pop-out page `soundboard.html`.
**Tech Stack:** Rust (Tauri 2.10.3, cpal 0.15 on WASAPI shared mode, hound, Media Foundation via windows 0.61, libopus), TypeScript (vanilla, Vite multi-page), tauri-plugin-global-shortcut, tauri-plugin-window-state, tauri-plugin-dialog, tauri-plugin-shell.
**Spec:** docs/superpowers/specs/2026-09-29-soundboard-design.md

## Global Constraints

- **Build environment:** from Git Bash, `source /e/claude/RudariFlow/.superpowers/tools/env13.sh` (CUDA/LLVM/Vulkan/CMake env and `CARGO_TARGET_DIR=C:\r`).
- **Unit tests:** the CPU build with a filter only. From `src-tauri`: `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib <filter>` (use `--bins <filter>` for tests in `main.rs`). NEVER run the full suite: the `paste.rs` tests overwrite the user's clipboard while they work.
- **App build:** from the repo root, `CARGO_TARGET_DIR='C:\r' npm run tauri build -- --no-bundle`, in the foreground with a 600000 ms timeout. Afterwards, if `git diff --ignore-cr-at-eol --stat src-tauri/Cargo.toml` is empty, run `git checkout -- src-tauri/Cargo.toml` (`tauri build` rewrites its line endings). Commit real Cargo.toml changes before building.
- **Frontend:** `npx tsc --noEmit` from the repo root, no errors.
- **Live checks:** only on the isolated test instance, as in `.superpowers/tools/live-checks.md` and "Live checks" at the end of this plan. Never stop, start or drive the installed RudariFlow (`E:\Users\Shiggy\AppData\Local\RudariFlow`) or its llama-server. No tray clicks, SendKeys, native dialogs or focus stealing. Check the GPU headroom first (stop if less than 6.5 GB of 16 GB is free) and stop the test instance right after each check. Never play audio to the user's speakers: before any soundboard check turns the virtual microphone on, set "headphones" to `CABLE In 16 Ch (VB-Audio Virtual Cable)`.
- **Commits:** `feat:`, `fix:`, `docs:` or `test:` plus a subject, then an EMPTY line, then exactly `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Use `git commit -F -` with a heredoc.
- **Strings:** every new UI string in English and German in `src/i18n.ts`; the pop-out page uses the same module.
- **No version bump or release.**
- **Storage (spec):** folder `<app data>\soundboard\` (`get_app_dir()`, so `RUDARIFLOW_DATA_DIR` moves it): `sounds\<id>.<ext>` (the copied original), `cache\<id>.wav` (48 kHz stereo 16-bit PCM, rebuilt from the original if missing), `soundboard.json`.
- **`soundboard.json` defaults (spec):** `"version": 1`, `"enabled": false`, `"othersVolume": 1.0`, `"meVolume": 0.7`, `"layer": false`, `"devices": { "microphone": "", "cable": "", "headphones": "" }` (`""` = automatic), `"stopHotkey": ""`, `"window": { "poppedOut": false, "alwaysOnTop": false }`, `"categories": []`, `"sounds": []`; a sound is `{ id, name, file, category, hotkey, volume, durationMs }`, `category` `""` = "No category".
- **Formats:** aac, flac, m4a, mp3, ogg, opus, wav, wma. **Limit:** 30 minutes per sound.
- **Playback (spec):** fades 15 ms; new sound replaces (fade out the others) unless "Play sounds over each other" is on; playing a playing sound stops it; stop all fades every voice; per-sound volume and "Others hear" / "You hear" 0–100 %.
- **Mic → cable (spec):** target fill about 10 ms; frames dropped above target + 20 ms; silence inserted on underrun; corrections spread out.
- **Reader (spec):** about one second ahead; the first chunk is read before the voice starts; no file I/O in audio callbacks.
- **Automatic cable (spec):** an output whose name contains "VB-Audio Virtual Cable" or "CABLE Input", preferring one without "16 Ch". Automatic microphone: the Recording setting's microphone; automatic headphones: Windows' default output.
- **Hotkeys (spec):** sound and stop-all hotkeys are registered only while the Virtual microphone is on; conflict check across dictation, paste last, rewrite last, Free GPU, stop all and every sound ("Already used by <name>"); mouse hook 64 slots (was 8).
- **Window (spec):** label `soundboard`, page `soundboard.html`; window-state filter `main` and `soundboard`; closing the window docks the board back.
- **Events (spec):** `soundboard-changed`, `soundboard-playing` (about 10 per second while something plays), `soundboard-status`.
- **Test-only commands** need `RUDARIFLOW_TEST_COMMANDS=1`.
- **VB-Cable link:** `https://vb-audio.com/Cable/`.

---

## File map

| File | Change |
|---|---|
| `src-tauri/src/media.rs` | `decode_48k_stereo`, `NO_AUDIO`, `too_long`, generic MF/Opus decode |
| `src-tauri/tests/fixtures/soundboard/*` | 1 s tones in the 8 formats, `video-only.m4a` |
| `src-tauri/src/lib.rs` | `pub mod soundboard;` |
| `src-tauri/src/soundboard/mod.rs` | `Soundboard`, `Status`, `Event`, `BoardState`, `AddResult` |
| `src-tauri/src/soundboard/library.rs` | `Board` (`soundboard.json`), categories, sound edits, ids |
| `src-tauri/src/soundboard/prepare.rs` | copy + decode + cache WAV, limits, cleanup, `ensure_cache` |
| `src-tauri/src/soundboard/mixer.rs` | voices, replace/layer, stop, volumes, fades, two outputs |
| `src-tauri/src/soundboard/drift.rs` | `DriftBuffer`, `Resampler`, `mic_frames` |
| `src-tauri/src/soundboard/engine.rs` | device lookup, cpal streams, reader threads, stats, `capture_levels` |
| `src-tauri/examples/soundboard_probe.rs`, `src-tauri/Cargo.toml` | engine probe on real devices |
| `src-tauri/src/main.rs` | `AppState.soundboard`, commands, events, `HotkeyAction::{StopSounds, Sound}`, conflict check, board hotkey sync, pop-out window, window-state filter |
| `src-tauri/src/mouse_hotkey.rs` | `SLOTS` 8 → 64 |
| `src-tauri/src/mute.rs` | doc: the soundboard's streams are RudariFlow's own sessions |
| `src-tauri/capabilities/default.json` | window `soundboard`, VB-Audio link |
| `src/hotkey-capture.ts` | capture UI shared by Recording and the Soundboard |
| `src/soundboard/api.ts`, `src/soundboard/board.ts`, `src/soundboard/page.ts` | types + invoke wrappers, the board component, the pop-out page |
| `soundboard.html`, `vite.config.ts` | pop-out page, Vite entry |
| `index.html`, `src/main.ts`, `src/files.ts`, `src/style.css`, `src/i18n.ts` | tab, wiring, drop routing, styles, EN/DE |
| `README.md`, `README.de.md`, `CHANGELOG.md` | docs |

---

### Task 1: Decode sounds to 48 kHz stereo, with fixtures for the 8 formats

**Files:**
- Modify: `src-tauri/src/media.rs`
- Create: `src-tauri/tests/fixtures/soundboard/tone.aac`, `tone.flac`, `tone.m4a`, `tone.mp3`, `tone.ogg`, `tone.opus`, `tone.wav`, `tone.wma`, `video-only.m4a`
- Test: `src-tauri/src/media.rs` (`mod tests`)

**Interfaces:**
- Produces:
  - `pub fn media::decode_48k_stereo(path: &Path, max_secs: u64) -> Result<Vec<f32>, String>` (interleaved stereo at 48 kHz)
  - `pub const media::NO_AUDIO: &str` (`"the file has no audio"`)
  - `pub fn media::too_long(max_secs: u64) -> String` (`"longer than 3 hours"`, `"longer than 30 minutes"`)
  - fixtures: 1 s, 440 Hz at amplitude 0.5 on the LEFT channel, silent right channel, 44.1 kHz source

- [ ] **Step 1: Generate the fixtures (once, with ffmpeg; the files are committed)**

```bash
mkdir -p /e/claude/RudariFlow/src-tauri/tests/fixtures/soundboard
cd /e/claude/RudariFlow/src-tauri/tests/fixtures/soundboard
T='aevalsrc=0.5*sin(2*PI*440*t)|0:s=44100:d=1'
ff() { ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$T" "$@"; }
ff -c:a pcm_s16le tone.wav
ff -c:a flac tone.flac
ff -c:a aac -b:a 128k -f adts tone.aac
ff -c:a aac -b:a 128k tone.m4a
ff -c:a libmp3lame -b:a 128k tone.mp3
ff -c:a libvorbis -q:a 4 tone.ogg
ff -c:a libopus -b:a 64k tone.opus
ff -c:a wmav2 -b:a 128k tone.wma
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "color=c=black:s=16x16:r=5:d=1" -c:v mpeg4 -f mp4 video-only.m4a
ls -l
```

Expected: nine files, none larger than about 180 KB (`tone.wav`).

- [ ] **Step 2: Failing tests**

In `src-tauri/src/media.rs`, add to `mod tests`:

```rust
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
```

Run:

```bash
source /e/claude/RudariFlow/.superpowers/tools/env13.sh
cd /e/claude/RudariFlow/src-tauri && CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib media::
```

Expected: compile errors (`to_stereo`, `resample_stereo`, `too_long`, `decode_48k_stereo`, `NO_AUDIO` not found).

- [ ] **Step 3: The decoder**

Replace everything in `media.rs` from the top of the file down to (not including) `#[cfg(windows)]\nmod imp {` with:

```rust
//! Audio from media files (MP3, M4A, WAV, FLAC, MP4, MOV, MKV, WebM, ...)
//! for file transcription and the soundboard, decoded by Windows Media
//! Foundation: no extra download, and every format Windows plays. Ogg Opus
//! (WhatsApp voice messages), which Windows cannot open, is decoded with
//! libopus.

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
        // Ogg Vorbis and FLAC in Ogg go to Media Foundation, which opens them
        // where Windows has the codec (Web Media Extensions).
        match decode_ogg_opus(path, 16_000, opus::Channels::Mono, MAX_SECS, &mut progress) {
            Err(e) if e == NOT_OPUS => {}
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
    let (samples, rate, channels) = if is_ogg(path) {
        match decode_ogg_opus(path, 48_000, opus::Channels::Stereo, max_secs, |_, _| {}) {
            Err(e) if e == NOT_OPUS => imp::decode(path, 48_000, 2, max_secs, |_, _| {})?,
            decoded => (decoded?, 48_000, 2),
        }
    } else {
        imp::decode(path, 48_000, 2, max_secs, |_, _| {})?
    };
    let stereo = to_stereo(samples, channels);
    let stereo = if rate == 48_000 { stereo } else { resample_stereo(&stereo, rate, 48_000) };
    if stereo.is_empty() {
        return Err(NO_AUDIO.to_string());
    }
    Ok(stereo)
}

const NOT_OPUS: &str = "only Opus audio is supported in Ogg files";

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

```

In `mod imp` (the `#[cfg(windows)]` one), replace `set_output` with:

```rust
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
```

and replace `pub fn decode(...) { ... }` (the whole function) with:

```rust
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
```

Replace the `#[cfg(not(windows))] mod imp` with:

```rust
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
```

Run the same command. Expected: every `media::` test passes, including the existing `a_wav_file_decodes_to_the_same_samples` and `channels_are_averaged`. If one format fails in `every_soundboard_format_decodes_to_48k_stereo`, the panic names it: fix the decoder, not the numbers (the numbers follow from a 1 s, 440 Hz, 0.5 tone).

- [ ] **Step 4: The callers of `decode_16k_mono` still build**

Run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo check --no-default-features --lib --bins --examples`. Expected: no errors (`main.rs` and `examples/media_probe.rs` call `decode_16k_mono`, whose signature is unchanged).

- [ ] **Step 5: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/media.rs src-tauri/tests/fixtures/soundboard
git commit -F - <<'EOF'
feat: decode sounds to 48 kHz stereo for the soundboard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: The library (`soundboard.json`) and preparing an added file

**Files:**
- Create: `src-tauri/src/soundboard/mod.rs`, `src-tauri/src/soundboard/library.rs`, `src-tauri/src/soundboard/prepare.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `library.rs` and `prepare.rs` (`mod tests`)

**Interfaces:**
- Consumes: `media::decode_48k_stereo`, `media::NO_AUDIO`, `media::too_long` (Task 1); fixtures.
- Produces (`rudariflow_lib::soundboard::library`):
  - `pub const FILE: &str = "soundboard.json"`
  - `pub struct Board { version: u32, enabled: bool, others_volume: f32, me_volume: f32, layer: bool, devices: Devices, stop_hotkey: String, window: WindowPrefs, categories: Vec<Category>, sounds: Vec<Sound> }` (all `pub`, serde camelCase, `Default` = the spec's defaults)
  - `pub struct Devices { microphone: String, cable: String, headphones: String }`, `pub struct WindowPrefs { popped_out: bool, always_on_top: bool }`, `pub struct Category { id: String, name: String }`, `pub struct Sound { id, name, file, category: String, hotkey: String, volume: f32, duration_ms: u64 }`
  - `Board::load(dir: &Path) -> Board`, `Board::save(&self, dir: &Path) -> Result<(), String>`, `sound(&self, id) -> Option<&Sound>`, `add_sound(&mut self, Sound)`, `remove_sound(&mut self, id) -> Option<Sound>`, `rename_sound(&mut self, id, name) -> Result<(), String>`, `set_category(&mut self, id, category) -> Result<(), String>`, `set_sound_volume(&mut self, id, f32) -> Result<(), String>`, `set_sound_hotkey(&mut self, id, &str) -> Result<(), String>`, `add_category(&mut self, name) -> Result<String, String>`, `rename_category(&mut self, id, name) -> Result<(), String>`, `remove_category(&mut self, id) -> Result<(), String>`; error codes `"no_sound"`, `"no_category"`, `"empty_name"`, `"exists"`
  - `pub fn new_id(prefix: &str) -> String` (`"s-3fa2c9d01b7e"`), `pub fn default_name(path: &Path) -> String`
- Produces (`rudariflow_lib::soundboard::prepare`):
  - `pub const EXTENSIONS: [&str; 8]`, `pub const MAX_SECS: u64 = 1800`, `pub const RATE: u32 = 48_000`
  - `pub struct Prepared { file: String, duration_ms: u64 }`
  - `pub fn prepare(dir: &Path, src: &Path, id: &str) -> Result<Prepared, String>`; errors `"unsupported"`, `"too_long"`, `"no_audio"`, `"unreadable: …"`, `"disk: …"`
  - `pub fn cache_path(dir: &Path, id: &str) -> PathBuf`, `pub fn ensure_cache(dir: &Path, sound: &Sound) -> Result<PathBuf, String>` (`"missing"`), `pub fn is_missing(dir: &Path, sound: &Sound) -> bool`, `pub fn remove_files(dir: &Path, sound: &Sound)`

- [ ] **Step 1: Module skeleton and failing library tests**

Create `src-tauri/src/soundboard/mod.rs`:

```rust
//! The soundboard: sounds on hotkeys, played into a virtual microphone (a
//! VB-Audio Virtual Cable) together with the user's own voice, and on the
//! headphones. See docs/superpowers/specs/2026-09-29-soundboard-design.md.

pub mod library;
```

In `src-tauri/src/lib.rs`, add `pub mod soundboard;` after `pub mod pdf;`.

Create `src-tauri/src/soundboard/library.rs` with only the tests for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rudariflow_sb_library_{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn sound(id: &str, name: &str) -> Sound {
        Sound {
            id: id.into(),
            name: name.into(),
            file: format!("sounds/{}.mp3", id),
            category: String::new(),
            hotkey: String::new(),
            volume: 1.0,
            duration_ms: 1000,
        }
    }

    #[test]
    fn a_missing_file_is_an_empty_board_with_the_defaults() {
        let board = Board::load(&temp("missing"));
        assert_eq!(board, Board::default());
        assert_eq!(board.version, 1);
        assert!(!board.enabled && !board.layer);
        assert_eq!((board.others_volume, board.me_volume), (1.0, 0.7));
        assert_eq!(board.devices, Devices::default());
        assert!(board.stop_hotkey.is_empty() && board.sounds.is_empty() && board.categories.is_empty());
    }

    #[test]
    fn the_board_survives_a_save_and_a_load() {
        let dir = temp("roundtrip");
        let mut board = Board::default();
        board.enabled = true;
        board.layer = true;
        board.stop_hotkey = "F14".into();
        board.devices.cable = "Speakers (VB-Audio Virtual Cable)".into();
        board.window.always_on_top = true;
        let memes = board.add_category("Memes").unwrap();
        let mut s = sound("s-1", "airhorn");
        s.category = memes;
        s.hotkey = "Numpad1".into();
        s.volume = 0.5;
        board.add_sound(s);
        board.save(&dir).unwrap();
        assert!(!dir.join("soundboard.json.tmp").exists(), "written through a temp file");
        assert_eq!(Board::load(&dir), board);
        let json = std::fs::read_to_string(dir.join(FILE)).unwrap();
        for key in ["\"othersVolume\"", "\"meVolume\"", "\"stopHotkey\"", "\"poppedOut\"", "\"alwaysOnTop\"", "\"durationMs\""] {
            assert!(json.contains(key), "{} in {}", key, json);
        }
    }

    #[test]
    fn a_damaged_file_is_kept_aside_and_the_board_starts_empty() {
        let dir = temp("damaged");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), "{ not json").unwrap();
        assert_eq!(Board::load(&dir), Board::default());
        assert_eq!(std::fs::read_to_string(dir.join("soundboard.json.bad")).unwrap(), "{ not json");
        assert!(!dir.join(FILE).exists());
    }

    #[test]
    fn values_out_of_range_are_tidied_at_load() {
        let dir = temp("tidy");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(FILE),
            r#"{"othersVolume": 3, "meVolume": -1, "window": {"poppedOut": true},
                "sounds": [{"id": "s-1", "name": "a", "file": "sounds/s-1.wav", "category": "c-gone", "volume": 2}]}"#,
        )
        .unwrap();
        let board = Board::load(&dir);
        assert_eq!((board.others_volume, board.me_volume), (1.0, 0.0));
        assert!(!board.window.popped_out, "no pop-out window exists at start");
        assert_eq!(board.sounds[0].category, "", "a category that is gone");
        assert_eq!(board.sounds[0].volume, 1.0);
        assert_eq!(board.version, 1);
    }

    #[test]
    fn sounds_are_renamed_sorted_and_removed() {
        let mut board = Board::default();
        board.add_sound(sound("s-1", "airhorn"));
        board.add_sound(sound("s-2", "airhorn"));
        assert_eq!(board.rename_sound("s-1", "  horn  "), Ok(()));
        assert_eq!(board.sound("s-1").unwrap().name, "horn");
        assert_eq!(board.rename_sound("s-1", "  "), Err("empty_name".into()));
        assert_eq!(board.rename_sound("s-9", "x"), Err("no_sound".into()));
        let c = board.add_category("Memes").unwrap();
        assert_eq!(board.set_category("s-2", &c), Ok(()));
        assert_eq!(board.set_category("s-2", "c-nope"), Err("no_category".into()));
        assert_eq!(board.set_sound_volume("s-2", 1.5), Ok(()));
        assert_eq!(board.sound("s-2").unwrap().volume, 1.0);
        assert_eq!(board.set_sound_hotkey("s-2", "F13"), Ok(()));
        assert_eq!(board.remove_sound("s-1").unwrap().name, "horn");
        assert!(board.remove_sound("s-1").is_none());
        assert_eq!(board.sounds.len(), 1);
    }

    #[test]
    fn deleting_a_category_moves_its_sounds_to_no_category() {
        let mut board = Board::default();
        let memes = board.add_category("Memes").unwrap();
        assert!(memes.starts_with("c-"));
        assert_eq!(board.add_category(" memes "), Err("exists".into()));
        assert_eq!(board.add_category(""), Err("empty_name".into()));
        let music = board.add_category("Music").unwrap();
        assert_eq!(board.rename_category(&music, "memes"), Err("exists".into()));
        assert_eq!(board.rename_category(&music, "music"), Ok(()), "its own name in other letters");
        board.add_sound(sound("s-1", "a"));
        board.set_category("s-1", &memes).unwrap();
        board.add_sound(sound("s-2", "b"));
        board.set_category("s-2", &music).unwrap();
        assert_eq!(board.remove_category(&memes), Ok(()));
        assert_eq!(board.sound("s-1").unwrap().category, "");
        assert_eq!(board.sound("s-2").unwrap().category, music);
        assert_eq!(board.categories.len(), 1);
        assert_eq!(board.remove_category(&memes), Err("no_category".into()));
    }

    #[test]
    fn ids_are_random_and_names_come_from_the_file() {
        let (a, b) = (new_id("s"), new_id("s"));
        assert_ne!(a, b);
        assert!(a.starts_with("s-") && a.len() == 14, "{}", a);
        assert_eq!(default_name(Path::new("C:/sounds/Air Horn.mp3")), "Air Horn");
    }
}
```

Run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib soundboard::` (from `src-tauri`, after `source …/env13.sh`). Expected: compile errors (`Board`, `Sound`, `FILE`, … not found).

- [ ] **Step 2: The library**

Put this above the tests in `library.rs`:

```rust
//! The soundboard's library and settings in `soundboard.json` (sounds,
//! categories, volumes, devices, hotkeys, the pop-out window). Saved
//! through a temp file and a rename, so a crash never leaves half a file.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::startup_log;

pub const FILE: &str = "soundboard.json";

fn version() -> u32 {
    1
}

fn full() -> f32 {
    1.0
}

fn me_default() -> f32 {
    0.7
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    #[serde(default = "version")]
    pub version: u32,
    /// The Virtual microphone switch, remembered across restarts.
    #[serde(default)]
    pub enabled: bool,
    /// "Others hear": the sounds in the virtual cable.
    #[serde(default = "full")]
    pub others_volume: f32,
    /// "You hear": the sounds on the headphones.
    #[serde(default = "me_default")]
    pub me_volume: f32,
    /// "Play sounds over each other"; off, a new sound replaces the others.
    #[serde(default)]
    pub layer: bool,
    #[serde(default)]
    pub devices: Devices,
    /// Stops every sound; empty = off.
    #[serde(default)]
    pub stop_hotkey: String,
    #[serde(default)]
    pub window: WindowPrefs,
    #[serde(default)]
    pub categories: Vec<Category>,
    #[serde(default)]
    pub sounds: Vec<Sound>,
}

/// Device names; "" = automatic.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Devices {
    #[serde(default)]
    pub microphone: String,
    #[serde(default)]
    pub cable: String,
    #[serde(default)]
    pub headphones: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPrefs {
    #[serde(default)]
    pub popped_out: bool,
    #[serde(default)]
    pub always_on_top: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sound {
    pub id: String,
    pub name: String,
    /// The copied original, relative to the soundboard folder: "sounds/<id>.<ext>".
    pub file: String,
    /// A category id; "" = no category.
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub hotkey: String,
    #[serde(default = "full")]
    pub volume: f32,
    #[serde(default)]
    pub duration_ms: u64,
}

impl Default for Board {
    fn default() -> Self {
        Board {
            version: 1,
            enabled: false,
            others_volume: 1.0,
            me_volume: 0.7,
            layer: false,
            devices: Devices::default(),
            stop_hotkey: String::new(),
            window: WindowPrefs::default(),
            categories: Vec::new(),
            sounds: Vec::new(),
        }
    }
}

impl Board {
    /// The board in `dir`. Missing: an empty board. Damaged: an empty board,
    /// and the damaged file is kept as `soundboard.json.bad`.
    pub fn load(dir: &Path) -> Board {
        let path = dir.join(FILE);
        let Ok(text) = std::fs::read_to_string(&path) else {
            return Board::default();
        };
        match serde_json::from_str::<Board>(&text) {
            Ok(mut board) => {
                board.tidy();
                board
            }
            Err(e) => {
                startup_log::log(&format!("[soundboard] {} is damaged ({}); kept as {}.bad", FILE, e, FILE));
                let _ = std::fs::rename(&path, dir.join(format!("{}.bad", FILE)));
                Board::default()
            }
        }
    }

    /// Values a hand edit or an older version may leave out of range.
    fn tidy(&mut self) {
        self.version = 1;
        self.others_volume = self.others_volume.clamp(0.0, 1.0);
        self.me_volume = self.me_volume.clamp(0.0, 1.0);
        // No pop-out window exists when the app starts.
        self.window.popped_out = false;
        let categories: Vec<String> = self.categories.iter().map(|c| c.id.clone()).collect();
        for sound in &mut self.sounds {
            sound.volume = sound.volume.clamp(0.0, 1.0);
            if !sound.category.is_empty() && !categories.contains(&sound.category) {
                sound.category.clear();
            }
        }
    }

    /// Write `soundboard.json` in `dir` through a temp file.
    pub fn save(&self, dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!("{}.tmp", FILE));
        std::fs::write(&tmp, json)
            .and_then(|_| std::fs::rename(&tmp, dir.join(FILE)))
            .map_err(|e| e.to_string())
    }

    pub fn sound(&self, id: &str) -> Option<&Sound> {
        self.sounds.iter().find(|s| s.id == id)
    }

    fn sound_mut(&mut self, id: &str) -> Result<&mut Sound, String> {
        self.sounds.iter_mut().find(|s| s.id == id).ok_or_else(|| "no_sound".to_string())
    }

    pub fn add_sound(&mut self, sound: Sound) {
        self.sounds.push(sound);
    }

    pub fn remove_sound(&mut self, id: &str) -> Option<Sound> {
        let at = self.sounds.iter().position(|s| s.id == id)?;
        Some(self.sounds.remove(at))
    }

    /// Only the name changes, never the files.
    pub fn rename_sound(&mut self, id: &str, name: &str) -> Result<(), String> {
        let name = clean_name(name)?;
        self.sound_mut(id)?.name = name;
        Ok(())
    }

    /// `category` "" = no category.
    pub fn set_category(&mut self, id: &str, category: &str) -> Result<(), String> {
        if !category.is_empty() && !self.categories.iter().any(|c| c.id == category) {
            return Err("no_category".to_string());
        }
        self.sound_mut(id)?.category = category.to_string();
        Ok(())
    }

    pub fn set_sound_volume(&mut self, id: &str, volume: f32) -> Result<(), String> {
        self.sound_mut(id)?.volume = volume.clamp(0.0, 1.0);
        Ok(())
    }

    pub fn set_sound_hotkey(&mut self, id: &str, hotkey: &str) -> Result<(), String> {
        self.sound_mut(id)?.hotkey = hotkey.to_string();
        Ok(())
    }

    /// A new category; returns its id.
    pub fn add_category(&mut self, name: &str) -> Result<String, String> {
        let name = clean_name(name)?;
        self.check_free(&name, None)?;
        let id = new_id("c");
        self.categories.push(Category { id: id.clone(), name });
        Ok(id)
    }

    pub fn rename_category(&mut self, id: &str, name: &str) -> Result<(), String> {
        let name = clean_name(name)?;
        self.check_free(&name, Some(id))?;
        let category = self.categories.iter_mut().find(|c| c.id == id).ok_or("no_category")?;
        category.name = name;
        Ok(())
    }

    /// Its sounds move to "No category".
    pub fn remove_category(&mut self, id: &str) -> Result<(), String> {
        let at = self.categories.iter().position(|c| c.id == id).ok_or("no_category")?;
        self.categories.remove(at);
        for sound in &mut self.sounds {
            if sound.category == id {
                sound.category.clear();
            }
        }
        Ok(())
    }

    /// "exists" when another category has this name (any capitalisation).
    fn check_free(&self, name: &str, except: Option<&str>) -> Result<(), String> {
        let taken = self
            .categories
            .iter()
            .any(|c| Some(c.id.as_str()) != except && c.name.to_lowercase() == name.to_lowercase());
        if taken {
            Err("exists".to_string())
        } else {
            Ok(())
        }
    }
}

fn clean_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        Err("empty_name".to_string())
    } else {
        Ok(name.to_string())
    }
}

/// A new id: `prefix` and 12 random hex digits ("s-3fa2c9d01b7e").
pub fn new_id(prefix: &str) -> String {
    let mut bytes = [0u8; 6];
    if getrandom::fill(&mut bytes).is_err() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        bytes.copy_from_slice(&nanos.to_le_bytes()[..6]);
    }
    format!("{}-{}", prefix, bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>())
}

/// A sound's name before it is renamed: the file name without extension.
pub fn default_name(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}
```

Run the same command. Expected: the 7 `soundboard::library::` tests pass.

- [ ] **Step 3: Failing prepare tests**

In `mod.rs`, add `pub mod prepare;` after `pub mod library;`. Create `src-tauri/src/soundboard/prepare.rs` with the tests only:

```rust
#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/soundboard").join(name)
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rudariflow_sb_prepare_{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// Files left in `sounds\` and `cache\`.
    fn left_over(dir: &Path) -> usize {
        ["sounds", "cache"].iter().map(|d| std::fs::read_dir(dir.join(d)).map(|r| r.count()).unwrap_or(0)).sum()
    }

    fn sound_for(p: &Prepared, id: &str) -> Sound {
        Sound {
            id: id.into(),
            name: "tone".into(),
            file: p.file.clone(),
            category: String::new(),
            hotkey: String::new(),
            volume: 1.0,
            duration_ms: p.duration_ms,
        }
    }

    #[test]
    fn an_added_file_is_copied_and_prepared_for_playback() {
        let dir = temp("add");
        let p = prepare(&dir, &fixture("tone.mp3"), "s-test").unwrap();
        assert_eq!(p.file, "sounds/s-test.mp3");
        assert_eq!(std::fs::read(dir.join(&p.file)).unwrap(), std::fs::read(fixture("tone.mp3")).unwrap());
        assert!((950..=1100).contains(&p.duration_ms), "{} ms", p.duration_ms);
        let wav = hound::WavReader::open(cache_path(&dir, "s-test")).unwrap();
        let spec = wav.spec();
        assert_eq!((spec.channels, spec.sample_rate, spec.bits_per_sample), (2, 48_000, 16));
        assert!((wav.duration() as u64).abs_diff(p.duration_ms * 48) < 48);
        assert!(!dir.join("cache").join("s-test.wav.tmp").exists());
        // The same file again is a second sound.
        assert!(prepare(&dir, &fixture("tone.mp3"), "s-again").is_ok());
    }

    #[test]
    fn unsupported_long_silent_and_broken_files_leave_nothing_behind() {
        let dir = temp("refused");
        std::fs::create_dir_all(&dir).unwrap();
        let text = dir.join("notes.txt");
        std::fs::write(&text, "hello").unwrap();
        assert_eq!(prepare(&dir, &text, "s-1").unwrap_err(), "unsupported");
        assert_eq!(prepare_limited(&dir, &fixture("tone.wav"), "s-2", 0).unwrap_err(), "too_long");
        assert_eq!(prepare(&dir, &fixture("video-only.m4a"), "s-3").unwrap_err(), "no_audio");
        let broken = dir.join("broken.mp3");
        std::fs::write(&broken, vec![7u8; 4096]).unwrap();
        let e = prepare(&dir, &broken, "s-4").unwrap_err();
        // Media Foundation refuses the bytes, or finds no audio in them.
        assert!(e.starts_with("unreadable: ") || e == "no_audio", "{}", e);
        assert_eq!(left_over(&dir), 0);
    }

    #[test]
    fn a_missing_cache_is_rebuilt_and_a_missing_original_is_reported() {
        let dir = temp("cache");
        let p = prepare(&dir, &fixture("tone.wav"), "s-1").unwrap();
        let sound = sound_for(&p, "s-1");
        std::fs::remove_file(cache_path(&dir, "s-1")).unwrap();
        assert!(!is_missing(&dir, &sound), "the original is still there");
        assert_eq!(ensure_cache(&dir, &sound).unwrap(), cache_path(&dir, "s-1"));
        assert!(cache_path(&dir, "s-1").exists());
        remove_files(&dir, &sound);
        assert!(is_missing(&dir, &sound));
        assert_eq!(ensure_cache(&dir, &sound).unwrap_err(), "missing");
        assert_eq!(left_over(&dir), 0);
    }
}
```

Run the same command. Expected: compile errors (`prepare`, `cache_path`, … not found).

- [ ] **Step 4: Preparing**

Put this above the tests in `prepare.rs`:

```rust
//! Adding a sound: the file is copied into `sounds\<id>.<ext>`, decoded once
//! to 48 kHz stereo and written to `cache\<id>.wav` (16-bit PCM), the copy
//! playback reads. Whatever fails leaves no file behind.

use std::path::{Path, PathBuf};

use super::library::Sound;
use crate::media;

/// The formats that can be added.
pub const EXTENSIONS: [&str; 8] = ["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"];
/// Longest sound: 30 minutes.
pub const MAX_SECS: u64 = 30 * 60;
/// Prepared sounds are 48 kHz stereo.
pub const RATE: u32 = 48_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Prepared {
    /// The copied original, relative to the soundboard folder.
    pub file: String,
    pub duration_ms: u64,
}

/// The playback copy of sound `id`.
pub fn cache_path(dir: &Path, id: &str) -> PathBuf {
    dir.join("cache").join(format!("{}.wav", id))
}

/// Copy `src` into the soundboard folder `dir` as sound `id` and prepare
/// its playback copy. Errors: "unsupported", "too_long", "no_audio",
/// "unreadable: …", "disk: …".
pub fn prepare(dir: &Path, src: &Path, id: &str) -> Result<Prepared, String> {
    prepare_limited(dir, src, id, MAX_SECS)
}

fn prepare_limited(dir: &Path, src: &Path, id: &str, max_secs: u64) -> Result<Prepared, String> {
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    if !EXTENSIONS.contains(&ext.as_str()) {
        return Err("unsupported".to_string());
    }
    let file = format!("sounds/{}.{}", id, ext);
    let (original, cache) = (dir.join(&file), cache_path(dir, id));
    let result = std::fs::create_dir_all(dir.join("sounds"))
        .and_then(|_| std::fs::create_dir_all(dir.join("cache")))
        .and_then(|_| std::fs::copy(src, &original))
        .map_err(disk)
        .and_then(|_| write_cache(&original, &cache, max_secs));
    match result {
        Ok(frames) => Ok(Prepared { file, duration_ms: frames * 1000 / RATE as u64 }),
        Err(e) => {
            let _ = std::fs::remove_file(&original);
            let _ = std::fs::remove_file(&cache);
            Err(e)
        }
    }
}

/// Decode `original` and write the playback copy through a temp file.
/// Returns its length in frames.
fn write_cache(original: &Path, cache: &Path, max_secs: u64) -> Result<u64, String> {
    let samples = media::decode_48k_stereo(original, max_secs).map_err(|e| reason(&e, max_secs))?;
    let frames = (samples.len() / 2) as u64;
    if frames > max_secs * RATE as u64 {
        return Err("too_long".to_string());
    }
    let tmp = cache.with_extension("wav.tmp");
    let spec = hound::WavSpec { channels: 2, sample_rate: RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let written = (|| -> Result<(), hound::Error> {
        let mut writer = hound::WavWriter::create(&tmp, spec)?;
        // In blocks of a second: the writer's buffer is as large as a block.
        for chunk in samples.chunks(96_000) {
            let mut block = writer.get_i16_writer(chunk.len() as u32);
            for &s in chunk {
                block.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
            }
            block.flush()?;
        }
        writer.finalize()
    })();
    let saved = written.map_err(|e| e.to_string()).and_then(|_| std::fs::rename(&tmp, cache).map_err(|e| e.to_string()));
    if let Err(e) = saved {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("disk: {}", e));
    }
    Ok(frames)
}

/// The decoder's error as a reason the UI knows.
fn reason(error: &str, max_secs: u64) -> String {
    if error == media::NO_AUDIO {
        "no_audio".to_string()
    } else if error == media::too_long(max_secs) {
        "too_long".to_string()
    } else {
        format!("unreadable: {}", error)
    }
}

fn disk(e: std::io::Error) -> String {
    format!("disk: {}", e)
}

/// The playback copy of `sound`, made again from the original when only
/// the copy is gone. "missing" when both are.
pub fn ensure_cache(dir: &Path, sound: &Sound) -> Result<PathBuf, String> {
    let cache = cache_path(dir, &sound.id);
    if cache.exists() {
        return Ok(cache);
    }
    let original = dir.join(&sound.file);
    if !original.exists() {
        return Err("missing".to_string());
    }
    std::fs::create_dir_all(dir.join("cache")).map_err(disk)?;
    write_cache(&original, &cache, MAX_SECS)?;
    Ok(cache)
}

/// Both files of `sound` were deleted by hand.
pub fn is_missing(dir: &Path, sound: &Sound) -> bool {
    !cache_path(dir, &sound.id).exists() && !dir.join(&sound.file).exists()
}

/// Delete both files of `sound`.
pub fn remove_files(dir: &Path, sound: &Sound) {
    let _ = std::fs::remove_file(dir.join(&sound.file));
    let _ = std::fs::remove_file(cache_path(dir, &sound.id));
}
```

Run the same command. Expected: all `soundboard::` tests pass (7 library, 3 prepare).

- [ ] **Step 5: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/lib.rs src-tauri/src/soundboard
git commit -F - <<'EOF'
feat: soundboard library and preparing added sounds

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---
### Task 3: The mixer (pure playback logic)

**Files:**
- Create: `src-tauri/src/soundboard/mixer.rs`
- Modify: `src-tauri/src/soundboard/mod.rs`
- Test: `mixer.rs` (`mod tests`)

**Interfaces:**
- Consumes: `crate::audio::lock` (existing, `pub(crate)`).
- Produces (`rudariflow_lib::soundboard::mixer`):
  - `pub const SOURCE_RATE: u32 = 48_000`, `pub const FADE_MS: u32 = 15`
  - `pub enum Output { Cable = 0, Headphones = 1 }`
  - `pub struct VoiceBuffer` with `push(&mut self, &[[f32; 2]])`, `finish(&mut self)`, `is_finished(&self) -> bool`, `end(&self) -> u64`, `len(&self) -> usize`, `is_empty(&self) -> bool`, `trim_before(&mut self, frame: u64)`
  - `pub struct VoiceShared { pub buffer: Mutex<VoiceBuffer>, pub played: [AtomicU64; 2], pub done: AtomicBool }` (`Default`), `slowest(&self) -> u64`
  - `pub struct PlayingVoice { pub id: String, pub pos_ms: u64, pub duration_ms: u64 }` (serde camelCase, `PartialEq`)
  - `pub struct Mixer { pub layer: bool, pub others_volume: f32, pub me_volume: f32, .. }` with `new(layer: bool, others_volume: f32, me_volume: f32) -> Mixer`, `is_playing(&self, sound_id: &str) -> bool`, `start(&mut self, sound_id: &str, volume: f32, frames: u64, shared: Arc<VoiceShared>)`, `stop_sound(&mut self, sound_id: &str) -> bool`, `stop_all(&mut self)`, `set_sound_volume(&mut self, sound_id: &str, volume: f32)`, `playing(&self) -> Vec<PlayingVoice>`, `is_idle(&self) -> bool`, `clear(&mut self)`, `render(&mut self, output: Output, out: &mut [f32], channels: usize, rate: u32)` (adds into `out`); dropping a `Mixer` clears it
  - `pub fn add_frame(out: &mut [f32], channels: usize, i: usize, frame: [f32; 2])`

- [ ] **Step 1: Failing tests**

In `src-tauri/src/soundboard/mod.rs`, add `pub mod mixer;` after `pub mod library;`. Create `src-tauri/src/soundboard/mixer.rs` with the tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// A sound of `frames` frames of [value, -value], all read.
    fn sound(frames: usize, value: f32) -> Arc<VoiceShared> {
        let shared = Arc::new(VoiceShared::default());
        {
            let mut buffer = lock(&shared.buffer);
            buffer.push(&vec![[value, -value]; frames]);
            buffer.finish();
        }
        shared
    }

    /// `frames` stereo frames of `output` at `rate`.
    fn render(m: &mut Mixer, output: Output, frames: usize, rate: u32) -> Vec<f32> {
        let mut out = vec![0.0; frames * 2];
        m.render(output, &mut out, 2, rate);
        out
    }

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }

    #[test]
    fn a_sound_plays_on_both_outputs_at_its_volumes() {
        let mut m = Mixer::new(false, 1.0, 0.5);
        m.start("a", 0.8, 480, sound(480, 0.5));
        let cable = render(&mut m, Output::Cable, 100, 48_000);
        assert!(close(cable[0], 0.4) && close(cable[1], -0.4), "{:?}", &cable[..2]);
        let phones = render(&mut m, Output::Headphones, 100, 48_000);
        assert!(close(phones[0], 0.2) && close(phones[1], -0.2), "{:?}", &phones[..2]);
    }

    #[test]
    fn each_output_keeps_its_own_position_and_the_voice_ends_with_both() {
        let mut m = Mixer::new(false, 1.0, 1.0);
        let a = sound(480, 0.5);
        m.start("a", 1.0, 480, a.clone());
        render(&mut m, Output::Cable, 600, 48_000);
        assert!(!m.is_idle(), "the headphones have not played it yet");
        assert_eq!(a.played[0].load(Ordering::Relaxed), 480);
        assert_eq!(a.slowest(), 0);
        let phones = render(&mut m, Output::Headphones, 600, 48_000);
        assert!(close(phones[2 * 479], 0.5) && phones[2 * 480] == 0.0);
        assert!(m.is_idle());
        assert!(a.done.load(Ordering::Relaxed), "its reader thread stops");
    }

    #[test]
    fn the_sound_follows_the_device_rate() {
        // 0.1 s rising from 0 to 1, played at 44.1 kHz: 4410 frames.
        let shared = Arc::new(VoiceShared::default());
        {
            let mut buffer = lock(&shared.buffer);
            let ramp: Vec<[f32; 2]> = (0..4_800).map(|k| [k as f32 / 4_800.0; 2]).collect();
            buffer.push(&ramp);
            buffer.finish();
        }
        let mut m = Mixer::new(false, 1.0, 1.0);
        m.start("ramp", 1.0, 4_800, shared);
        let out = render(&mut m, Output::Cable, 5_000, 44_100);
        for j in [1, 1_000, 3_000, 4_409] {
            let expected = (j as f64 * 48_000.0 / 44_100.0 / 4_800.0) as f32;
            assert!((out[2 * j] - expected).abs() < 1e-4, "frame {}: {} vs {}", j, out[2 * j], expected);
        }
        assert!(out[2 * 4_412..].iter().all(|&s| s == 0.0), "over after about 4410 frames");
    }

    #[test]
    fn a_new_sound_replaces_the_playing_one_with_a_fade() {
        let mut m = Mixer::new(false, 1.0, 1.0);
        let a = sound(48_000, 1.0);
        m.start("a", 1.0, 48_000, a.clone());
        render(&mut m, Output::Cable, 100, 48_000);
        render(&mut m, Output::Headphones, 100, 48_000);
        m.start("b", 1.0, 48_000, sound(48_000, 0.25));
        assert_eq!(m.playing().iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), ["b"]);
        // 15 ms at 48 kHz: 720 frames from full to silent.
        let out = render(&mut m, Output::Cable, 800, 48_000);
        assert!(close(out[0], 1.25), "{}", out[0]);
        assert!(close(out[2 * 360], 0.75), "{}", out[2 * 360]);
        assert!(close(out[2 * 720], 0.25) && close(out[2 * 799], 0.25));
        assert!(!a.done.load(Ordering::Relaxed), "still fading on the headphones");
        render(&mut m, Output::Headphones, 800, 48_000);
        assert!(a.done.load(Ordering::Relaxed));
        assert_eq!(m.playing().len(), 1);
    }

    #[test]
    fn layer_mode_plays_sounds_over_each_other() {
        let mut m = Mixer::new(true, 1.0, 1.0);
        m.start("a", 1.0, 4_800, sound(4_800, 0.25));
        m.start("b", 1.0, 4_800, sound(4_800, 0.5));
        let mut ids: Vec<String> = m.playing().into_iter().map(|v| v.id).collect();
        ids.sort();
        assert_eq!(ids, ["a", "b"]);
        let out = render(&mut m, Output::Cable, 10, 48_000);
        assert!(close(out[0], 0.75) && close(out[1], -0.75));
    }

    #[test]
    fn stopping_a_playing_sound_fades_it_and_stop_all_fades_every_voice() {
        let mut m = Mixer::new(true, 1.0, 1.0);
        m.start("a", 1.0, 48_000, sound(48_000, 0.5));
        m.start("b", 1.0, 48_000, sound(48_000, 0.5));
        assert!(m.is_playing("a"));
        assert!(m.stop_sound("a"));
        assert!(!m.is_playing("a"), "fading out counts as stopped");
        assert!(!m.stop_sound("a"));
        assert!(!m.stop_sound("nothing"));
        m.stop_all();
        assert!(m.playing().is_empty());
        for output in [Output::Cable, Output::Headphones] {
            let out = render(&mut m, output, 800, 48_000);
            assert!(out[2 * 720..].iter().all(|&s| s == 0.0));
        }
        assert!(m.is_idle());
    }

    #[test]
    fn a_bus_at_zero_is_silent_but_the_sound_still_ends() {
        let mut m = Mixer::new(false, 1.0, 0.0);
        m.start("a", 1.0, 480, sound(480, 0.5));
        assert!(render(&mut m, Output::Headphones, 600, 48_000).iter().all(|&s| s == 0.0));
        assert!(close(render(&mut m, Output::Cable, 600, 48_000)[0], 0.5));
        assert!(m.is_idle());
        m.start("b", 1.0, 480, sound(480, 0.5));
        m.others_volume = 0.0;
        m.me_volume = 1.0;
        m.set_sound_volume("b", 0.5);
        assert!(render(&mut m, Output::Cable, 10, 48_000).iter().all(|&s| s == 0.0));
        assert!(close(render(&mut m, Output::Headphones, 10, 48_000)[0], 0.25));
    }

    #[test]
    fn a_voice_waits_for_frames_not_read_yet() {
        let shared = Arc::new(VoiceShared::default());
        lock(&shared.buffer).push(&vec![[0.5, 0.5]; 100]);
        let mut m = Mixer::new(false, 1.0, 1.0);
        m.start("slow", 1.0, 1_000, shared.clone());
        let out = render(&mut m, Output::Cable, 200, 48_000);
        assert!(close(out[2 * 99], 0.5) && out[2 * 100] == 0.0);
        assert_eq!(shared.played[0].load(Ordering::Relaxed), 100);
        {
            let mut buffer = lock(&shared.buffer);
            buffer.push(&vec![[0.25, 0.25]; 900]);
            buffer.finish();
        }
        let out = render(&mut m, Output::Cable, 10, 48_000);
        assert!(close(out[0], 0.25), "it goes on at frame 100, not later");
    }

    #[test]
    fn the_playing_list_has_the_position_and_length() {
        let mut m = Mixer::new(false, 1.0, 1.0);
        m.start("a", 1.0, 48_000, sound(48_000, 0.1));
        render(&mut m, Output::Cable, 24_000, 48_000);
        assert_eq!(m.playing(), vec![PlayingVoice { id: "a".into(), pos_ms: 500, duration_ms: 1000 }]);
    }

    #[test]
    fn stereo_goes_to_the_first_two_channels_and_mono_gets_both() {
        let mut quad = vec![0.0; 8];
        add_frame(&mut quad, 4, 1, [0.5, -0.25]);
        assert_eq!(quad, [0.0, 0.0, 0.0, 0.0, 0.5, -0.25, 0.0, 0.0]);
        let mut mono = vec![0.0; 2];
        add_frame(&mut mono, 1, 1, [0.5, 0.25]);
        assert_eq!(mono, [0.0, 0.375]);
    }

    #[test]
    fn dropping_the_mixer_ends_every_voice() {
        let shared = sound(480, 0.5);
        let mut m = Mixer::new(false, 1.0, 1.0);
        m.start("a", 1.0, 480, shared.clone());
        drop(m);
        assert!(shared.done.load(Ordering::Relaxed));
    }

    #[test]
    fn the_reader_may_drop_what_both_outputs_played() {
        let mut buffer = VoiceBuffer::default();
        buffer.push(&[[0.0, 0.0]; 10]);
        buffer.trim_before(4);
        assert_eq!((buffer.end(), buffer.len()), (10, 6));
        buffer.trim_before(50);
        assert_eq!((buffer.end(), buffer.len()), (10, 0));
    }
}
```

Run (from `src-tauri`, after `source …/env13.sh`): `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib soundboard::mixer::`. Expected: compile errors (`Mixer`, `VoiceShared`, … not found).

- [ ] **Step 2: The mixer**

Put this above the tests in `mixer.rs`:

```rust
//! Playback without devices: which sounds play, replace or layer, stop,
//! stop all, volumes and 15 ms fade-outs. Each output (the cable, the
//! headphones) keeps its own position in every voice, so the two can run
//! on different clocks and rates. A voice ends when both outputs are
//! through it, or it has faded out on both.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::audio::lock;

/// Prepared sounds are 48 kHz stereo.
pub const SOURCE_RATE: u32 = 48_000;
/// A stopped or replaced sound fades out over this time.
pub const FADE_MS: u32 = 15;

/// What others hear (the virtual cable) and what the user hears.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Output {
    Cable = 0,
    Headphones = 1,
}

/// Frames of one playing sound, filled ahead by its reader thread
/// (engine.rs). Frames before `base` were dropped once both outputs were
/// past them.
#[derive(Debug, Default)]
pub struct VoiceBuffer {
    frames: VecDeque<[f32; 2]>,
    base: u64,
    finished: bool,
}

impl VoiceBuffer {
    pub fn push(&mut self, frames: &[[f32; 2]]) {
        self.frames.extend(frames.iter().copied());
    }

    /// The reader reached the end of the file.
    pub fn finish(&mut self) {
        self.finished = true;
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// One past the last frame read so far.
    pub fn end(&self) -> u64 {
        self.base + self.frames.len() as u64
    }

    /// Frames held now.
    pub fn len(&self) -> usize {
        self.frames.len()
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    /// Drop the frames before `frame`.
    pub fn trim_before(&mut self, frame: u64) {
        let n = frame.saturating_sub(self.base).min(self.frames.len() as u64);
        self.frames.drain(..n as usize);
        self.base += n;
    }

    fn get(&self, i: u64) -> Option<[f32; 2]> {
        let k = i.checked_sub(self.base)?;
        self.frames.get(k as usize).copied()
    }
}

/// What a voice's reader thread and the mixer share.
#[derive(Debug, Default)]
pub struct VoiceShared {
    pub buffer: Mutex<VoiceBuffer>,
    /// Whole frames each output has played ([Cable, Headphones]).
    pub played: [AtomicU64; 2],
    /// The voice is over: its reader thread stops.
    pub done: AtomicBool,
}

impl VoiceShared {
    /// The frame both outputs have reached.
    pub fn slowest(&self) -> u64 {
        self.played[0].load(Ordering::Relaxed).min(self.played[1].load(Ordering::Relaxed))
    }
}

/// A playing sound as the views show it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayingVoice {
    /// The sound's id.
    pub id: String,
    /// Where the cable output is.
    pub pos_ms: u64,
    pub duration_ms: u64,
}

/// One output's progress through a voice.
#[derive(Debug, Default, Clone, Copy)]
struct Track {
    /// In source frames; fractional at other device rates.
    pos: f64,
    /// Frames left of the fade-out, and its length, once it started.
    fade: Option<(u32, u32)>,
    done: bool,
}

struct Voice {
    sound_id: String,
    volume: f32,
    /// The sound's length in frames.
    frames: u64,
    shared: Arc<VoiceShared>,
    out: [Track; 2],
    /// Fading out (stopped, replaced or stop all).
    stopping: bool,
}

pub struct Mixer {
    voices: Vec<Voice>,
    /// "Play sounds over each other".
    pub layer: bool,
    /// "Others hear".
    pub others_volume: f32,
    /// "You hear".
    pub me_volume: f32,
}

impl Mixer {
    pub fn new(layer: bool, others_volume: f32, me_volume: f32) -> Mixer {
        Mixer { voices: Vec::new(), layer, others_volume, me_volume }
    }

    /// `sound_id` plays and is not fading out.
    pub fn is_playing(&self, sound_id: &str) -> bool {
        self.voices.iter().any(|v| v.sound_id == sound_id && !v.stopping)
    }

    /// Start a voice of `frames` frames; unless layering, the others fade out.
    pub fn start(&mut self, sound_id: &str, volume: f32, frames: u64, shared: Arc<VoiceShared>) {
        if !self.layer {
            for voice in &mut self.voices {
                voice.stopping = true;
            }
        }
        self.voices.push(Voice {
            sound_id: sound_id.to_string(),
            volume,
            frames,
            shared,
            out: [Track::default(); 2],
            stopping: false,
        });
    }

    /// Fade `sound_id` out. False when it was not playing.
    pub fn stop_sound(&mut self, sound_id: &str) -> bool {
        let mut stopped = false;
        for voice in self.voices.iter_mut().filter(|v| v.sound_id == sound_id && !v.stopping) {
            voice.stopping = true;
            stopped = true;
        }
        stopped
    }

    pub fn stop_all(&mut self) {
        for voice in &mut self.voices {
            voice.stopping = true;
        }
    }

    /// Applies to the voices of `sound_id` that play now, too.
    pub fn set_sound_volume(&mut self, sound_id: &str, volume: f32) {
        for voice in self.voices.iter_mut().filter(|v| v.sound_id == sound_id) {
            voice.volume = volume;
        }
    }

    /// The sounds that play (not fading out), with the cable's position.
    pub fn playing(&self) -> Vec<PlayingVoice> {
        let ms = |frames: u64| frames * 1000 / SOURCE_RATE as u64;
        self.voices
            .iter()
            .filter(|v| !v.stopping)
            .map(|v| PlayingVoice {
                id: v.sound_id.clone(),
                pos_ms: ms((v.out[0].pos as u64).min(v.frames)),
                duration_ms: ms(v.frames),
            })
            .collect()
    }

    pub fn is_idle(&self) -> bool {
        self.voices.is_empty()
    }

    /// End every voice at once (the engine stops).
    pub fn clear(&mut self) {
        for voice in self.voices.drain(..) {
            voice.shared.done.store(true, Ordering::Relaxed);
        }
    }

    /// Add the sounds for `output` to `out`: interleaved, `channels` per
    /// frame, at `rate` (linear rate conversion from 48 kHz).
    pub fn render(&mut self, output: Output, out: &mut [f32], channels: usize, rate: u32) {
        let channels = channels.max(1);
        let frames = out.len() / channels;
        let bus = match output {
            Output::Cable => self.others_volume,
            Output::Headphones => self.me_volume,
        };
        let step = SOURCE_RATE as f64 / rate.max(1) as f64;
        let fade_len = (rate * FADE_MS / 1000).max(1);
        let o = output as usize;
        for voice in &mut self.voices {
            let track = &mut voice.out[o];
            if track.done {
                continue;
            }
            if voice.stopping && track.fade.is_none() {
                track.fade = Some((fade_len, fade_len));
            }
            let gain = voice.volume * bus;
            let buffer = lock(&voice.shared.buffer);
            for i in 0..frames {
                let at = track.pos as u64;
                if at >= voice.frames {
                    track.done = true;
                    break;
                }
                let Some(a) = buffer.get(at) else {
                    // Not read yet (a slow disk): wait for it rather than skip ahead.
                    track.done = buffer.finished;
                    break;
                };
                let b = buffer.get(at + 1).unwrap_or(a);
                let mut g = gain;
                if let Some((left, len)) = track.fade.as_mut() {
                    if *left == 0 {
                        track.done = true;
                        break;
                    }
                    g *= *left as f32 / *len as f32;
                    *left -= 1;
                }
                let frac = (track.pos - at as f64) as f32;
                add_frame(
                    out,
                    channels,
                    i,
                    [(a[0] + (b[0] - a[0]) * frac) * g, (a[1] + (b[1] - a[1]) * frac) * g],
                );
                track.pos += step;
            }
            drop(buffer);
            voice.shared.played[o].store(track.pos as u64, Ordering::Relaxed);
        }
        self.voices.retain(|v| {
            let over = v.out.iter().all(|t| t.done);
            if over {
                v.shared.done.store(true, Ordering::Relaxed);
            }
            !over
        });
    }
}

impl Drop for Mixer {
    fn drop(&mut self) {
        self.clear();
    }
}

/// Add a stereo frame to frame `i` of an interleaved buffer: left and right
/// into the first two channels (more channels stay as they are), their
/// average into a mono one.
pub fn add_frame(out: &mut [f32], channels: usize, i: usize, [l, r]: [f32; 2]) {
    let at = i * channels;
    if channels == 1 {
        out[at] += (l + r) * 0.5;
    } else {
        out[at] += l;
        out[at + 1] += r;
    }
}
```

Run the same command. Expected: 12 passed.

- [ ] **Step 3: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/soundboard/mod.rs src-tauri/src/soundboard/mixer.rs
git commit -F - <<'EOF'
feat: soundboard mixer with replace, layer, stop and fades

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: The microphone's way to the cable (drift buffer and rate converter)

**Files:**
- Create: `src-tauri/src/soundboard/drift.rs`
- Modify: `src-tauri/src/soundboard/mod.rs`
- Test: `drift.rs` (`mod tests`)

**Interfaces:**
- Consumes: `mixer::add_frame` (Task 3).
- Produces (`rudariflow_lib::soundboard::drift`):
  - `pub const TARGET_MS: u32 = 10`, `pub const HIGH_MS: u32 = 20`
  - `pub struct DriftStats { pub fill_ms: f32, pub max_fill_ms: f32, pub dropped: u64, pub inserted: u64, pub underruns: u64, pub pushed: u64 }` (`Copy`, serde camelCase)
  - `pub struct DriftBuffer` with `new(rate: u32) -> DriftBuffer`, `push(&mut self, frames: &[[f32; 2]])`, `read_into(&mut self, out: &mut [f32], channels: usize)` (adds into `out`), `stats(&self) -> DriftStats`
  - `pub struct Resampler` with `new(from: u32, to: u32) -> Resampler`, `process(&mut self, input: &[[f32; 2]], out: &mut Vec<[f32; 2]>)`
  - `pub fn mic_frames(data: &[f32], channels: usize, out: &mut Vec<[f32; 2]>)`

- [ ] **Step 1: Failing tests**

In `mod.rs`, add `pub mod drift;` before `pub mod library;`. Create `drift.rs` with the tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    /// `secs` of a microphone and a cable whose clocks differ by `skew`
    /// (0.001: the microphone runs 0.1 % fast), both with 10 ms callbacks,
    /// the microphone 3 ms after the cable.
    fn simulate(skew: f64, secs: u32) -> DriftStats {
        let mut buffer = DriftBuffer::new(48_000);
        let chunk = vec![[0.1f32, 0.1]; 480];
        let mut out = vec![0f32; 960];
        let mic_period = 10_000.0 / (1.0 + skew);
        let (mut mic_t, mut cable_t) = (3_000.0f64, 0.0f64);
        let end = secs as f64 * 1e6;
        while mic_t < end || cable_t < end {
            if mic_t <= cable_t {
                buffer.push(&chunk);
                mic_t += mic_period;
            } else {
                out.fill(0.0);
                buffer.read_into(&mut out, 2);
                cable_t += 10_000.0;
            }
        }
        buffer.stats()
    }

    #[test]
    fn the_delay_stays_bounded_when_the_clocks_drift() {
        // 0.1 % of 5 minutes at 48 kHz: 14,400 frames to correct.
        let fast = simulate(0.001, 300);
        assert_eq!(fast.underruns, 0, "{:?}", fast);
        assert!(fast.max_fill_ms <= (TARGET_MS + HIGH_MS + 10) as f32 + 1.0, "{:?}", fast);
        assert!((12_000..=14_400).contains(&fast.dropped), "{:?}", fast);
        assert_eq!(fast.inserted, 0);
        let slow = simulate(-0.001, 300);
        assert_eq!(slow.underruns, 0, "{:?}", slow);
        assert!(slow.max_fill_ms <= (TARGET_MS + HIGH_MS + 10) as f32 + 1.0, "{:?}", slow);
        assert!((12_000..=14_500).contains(&slow.inserted), "{:?}", slow);
        assert_eq!(slow.dropped, 0);
    }

    #[test]
    fn an_underrun_is_silence_and_it_starts_again_with_a_margin() {
        let mut buffer = DriftBuffer::new(48_000);
        let mut out = vec![0f32; 960];
        buffer.read_into(&mut out, 2);
        assert!(out.iter().all(|&s| s == 0.0), "nothing before it is primed");
        buffer.push(&vec![[0.5, 0.5]; 960]);
        buffer.read_into(&mut out, 2);
        assert!(out.iter().all(|&s| s == 0.5));
        out.fill(0.0);
        buffer.read_into(&mut out, 2);
        out.fill(0.0);
        buffer.read_into(&mut out, 2);
        assert_eq!(buffer.stats().underruns, 1);
        assert!(out.iter().all(|&s| s == 0.0));
        // Primed again only with a read on top of the target (10 ms + 10 ms).
        buffer.push(&vec![[0.5, 0.5]; 500]);
        out.fill(0.0);
        buffer.read_into(&mut out, 2);
        assert!(out.iter().all(|&s| s == 0.0));
        assert_eq!(buffer.stats().pushed, 1_460);
    }

    #[test]
    fn a_stalled_cable_does_not_let_the_buffer_grow() {
        let mut buffer = DriftBuffer::new(48_000);
        for _ in 0..100 {
            buffer.push(&vec![[0.1, 0.1]; 480]);
        }
        // 200 ms at most.
        assert_eq!(buffer.stats().dropped, 48_000 - 9_600);
    }

    #[test]
    fn the_microphone_is_converted_to_the_cable_rate() {
        // 1 s of a 1 kHz tone at 44.1 kHz, in callbacks of 441 frames.
        let input: Vec<[f32; 2]> = (0..44_100)
            .map(|i| {
                let s = ((2.0 * PI * 1000.0 * i as f64 / 44_100.0).sin() * 0.5) as f32;
                [s, s]
            })
            .collect();
        let mut resampler = Resampler::new(44_100, 48_000);
        let mut out = Vec::new();
        for chunk in input.chunks(441) {
            resampler.process(chunk, &mut out);
        }
        assert!((47_990..=48_000).contains(&out.len()), "{}", out.len());
        let error = out
            .iter()
            .enumerate()
            .map(|(j, f)| (f[0] as f64 - (2.0 * PI * 1000.0 * j as f64 / 48_000.0).sin() * 0.5).abs())
            .fold(0.0f64, f64::max);
        assert!(error < 0.01, "max error {}", error);
        // The same in one piece.
        let mut whole = Vec::new();
        Resampler::new(44_100, 48_000).process(&input, &mut whole);
        assert!(whole.len().abs_diff(out.len()) <= 1);
        assert!(whole.iter().zip(&out).all(|(a, b)| (a[0] - b[0]).abs() < 1e-5));
        // The same rate: unchanged.
        let mut same = Vec::new();
        Resampler::new(48_000, 48_000).process(&input[..480], &mut same);
        assert_eq!(same, &input[..480]);
    }

    #[test]
    fn microphone_channels_become_one_voice_on_both_sides() {
        let mut out = Vec::new();
        mic_frames(&[0.2, 0.4, -0.2, 0.0], 2, &mut out);
        mic_frames(&[0.5], 1, &mut out);
        assert!((out[0][0] - 0.3).abs() < 1e-6 && out[0][0] == out[0][1]);
        assert!((out[1][0] + 0.1).abs() < 1e-6);
        assert_eq!(out[2], [0.5, 0.5]);
    }
}
```

Run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib soundboard::drift::`. Expected: compile errors (`DriftBuffer`, `Resampler`, `mic_frames` not found).

- [ ] **Step 2: The drift buffer and the rate converter**

Put this above the tests in `drift.rs`:

```rust
//! The microphone on its way to the cable. Its frames are made stereo at
//! the cable's rate (`mic_frames`, `Resampler`) and wait in a `DriftBuffer`
//! until the cable's callback takes them. The two devices run on their own
//! clocks, so the buffer drops or repeats single frames, at most one in a
//! hundred, to keep the voice's extra delay between about 10 and 30 ms.

use std::collections::VecDeque;

use super::mixer::add_frame;

/// Fill kept after each read of the cable.
pub const TARGET_MS: u32 = 10;
/// Above the target by this much, frames are dropped.
pub const HIGH_MS: u32 = 20;
/// At most one correction per this many frames, so speech stays clean.
const SPREAD: u32 = 100;
/// A cable that stopped reading: frames beyond this are dropped at once.
const CAP_MS: u32 = 200;

#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftStats {
    /// Smoothed fill after a read of the cable.
    pub fill_ms: f32,
    pub max_fill_ms: f32,
    /// Frames dropped (too full) and repeated (too empty).
    pub dropped: u64,
    pub inserted: u64,
    /// Times the cable found the buffer empty.
    pub underruns: u64,
    /// Frames the microphone delivered, at the cable's rate.
    pub pushed: u64,
}

#[derive(Clone, Copy, PartialEq)]
enum Fix {
    None,
    Drop,
    Repeat,
}

pub struct DriftBuffer {
    frames: VecDeque<[f32; 2]>,
    rate: u32,
    target: usize,
    high: usize,
    cap: usize,
    /// Reading; off at the start and after an underrun until the fill is
    /// one read above the target.
    primed: bool,
    /// Smoothed fill after a read, in frames.
    avg: Option<f64>,
    since_fix: u32,
    stats: DriftStats,
}

impl DriftBuffer {
    /// A buffer for a cable running at `rate`.
    pub fn new(rate: u32) -> DriftBuffer {
        let frames_in = |ms: u32| (rate as u64 * ms as u64 / 1000) as usize;
        DriftBuffer {
            frames: VecDeque::with_capacity(frames_in(CAP_MS)),
            rate,
            target: frames_in(TARGET_MS),
            high: frames_in(TARGET_MS + HIGH_MS),
            cap: frames_in(CAP_MS),
            primed: false,
            avg: None,
            since_fix: 0,
            stats: DriftStats::default(),
        }
    }

    /// Microphone frames, already at the cable's rate.
    pub fn push(&mut self, frames: &[[f32; 2]]) {
        self.stats.pushed += frames.len() as u64;
        self.frames.extend(frames.iter().copied());
        let over = self.frames.len().saturating_sub(self.cap);
        if over > 0 {
            self.frames.drain(..over);
            self.stats.dropped += over as u64;
        }
    }

    /// Add the next frames to the cable's buffer (interleaved, `channels`).
    pub fn read_into(&mut self, out: &mut [f32], channels: usize) {
        let channels = channels.max(1);
        let n = out.len() / channels;
        if !self.primed {
            if self.frames.len() < self.target + n {
                return;
            }
            self.primed = true;
        }
        let fix = match self.avg {
            Some(avg) if avg > self.high as f64 => Fix::Drop,
            Some(avg) if avg < self.target as f64 => Fix::Repeat,
            _ => Fix::None,
        };
        for i in 0..n {
            let Some(&frame) = self.frames.front() else {
                // Underrun: the rest stays silent until it is primed again.
                self.stats.underruns += 1;
                self.primed = false;
                self.avg = None;
                break;
            };
            self.since_fix += 1;
            let now = fix != Fix::None && self.since_fix >= SPREAD;
            if now {
                self.since_fix = 0;
            }
            match (now, fix) {
                // This frame plays again next time.
                (true, Fix::Repeat) => self.stats.inserted += 1,
                (true, Fix::Drop) => {
                    self.frames.pop_front();
                    self.frames.pop_front();
                    self.stats.dropped += 1;
                }
                _ => {
                    self.frames.pop_front();
                }
            }
            add_frame(out, channels, i, frame);
        }
        if self.primed {
            let fill = self.frames.len() as f64;
            let avg = self.avg.map_or(fill, |a| a * 0.9 + fill * 0.1);
            self.avg = Some(avg);
            let ms = |frames: f64| (frames * 1000.0 / self.rate as f64) as f32;
            self.stats.fill_ms = ms(avg);
            self.stats.max_fill_ms = self.stats.max_fill_ms.max(ms(fill));
        }
    }

    pub fn stats(&self) -> DriftStats {
        self.stats
    }
}

/// Linear rate conversion of a stream of stereo frames, chunk by chunk
/// (the microphone at its rate → the cable's rate).
pub struct Resampler {
    /// Input frames per output frame.
    step: f64,
    /// Position of the next output frame; 0 is `prev`, k is input[k - 1].
    pos: f64,
    /// The last frame of the previous chunk.
    prev: [f32; 2],
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Resampler {
        Resampler { step: from as f64 / to.max(1) as f64, pos: 1.0, prev: [0.0; 2] }
    }

    /// Convert `input` and append the frames to `out`.
    pub fn process(&mut self, input: &[[f32; 2]], out: &mut Vec<[f32; 2]>) {
        let Some(&last) = input.last() else { return };
        let prev = self.prev;
        let at = |k: usize| if k == 0 { prev } else { input[k - 1] };
        let n = input.len() as f64;
        let mut pos = self.pos;
        while pos <= n {
            let k = pos as usize;
            let frac = (pos - k as f64) as f32;
            let a = at(k);
            let b = if k < input.len() { at(k + 1) } else { a };
            out.push([a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac]);
            pos += self.step;
        }
        self.pos = pos - n;
        self.prev = last;
    }
}

/// The microphone's interleaved samples as stereo frames: one channel on
/// both sides, several averaged (as for dictation).
pub fn mic_frames(data: &[f32], channels: usize, out: &mut Vec<[f32; 2]>) {
    let channels = channels.max(1);
    out.extend(data.chunks_exact(channels).map(|f| {
        let m = f.iter().sum::<f32>() / channels as f32;
        [m, m]
    }));
}
```

Run the same command. Expected: 5 passed. `the_delay_stays_bounded_when_the_clocks_drift` simulates 10 minutes of callbacks; it takes a few seconds in the debug build.

- [ ] **Step 3: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/soundboard/mod.rs src-tauri/src/soundboard/drift.rs
git commit -F - <<'EOF'
feat: soundboard microphone path keeps its delay bounded under clock drift

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: The audio engine (devices, streams, reader threads)

**Files:**
- Create: `src-tauri/src/soundboard/engine.rs`, `src-tauri/examples/soundboard_probe.rs`
- Modify: `src-tauri/src/soundboard/mod.rs`, `src-tauri/Cargo.toml`
- Test: `engine.rs` (`mod tests`); live: the probe on the real devices

**Interfaces:**
- Consumes: `library::Devices` (Task 2); `mixer::{Mixer, Output, PlayingVoice, VoiceShared, SOURCE_RATE}` (Task 3); `drift::{DriftBuffer, DriftStats, Resampler, mic_frames}` (Task 4); `prepare::{prepare, cache_path}` (Task 2, in the probe).
- Produces (`rudariflow_lib::soundboard::engine`):
  - `pub struct DeviceList { pub inputs: Vec<String>, pub outputs: Vec<String>, pub default_input: Option<String>, pub default_output: Option<String> }`, `pub fn device_list() -> DeviceList`
  - `pub fn auto_cable(outputs: &[String]) -> Option<String>`
  - `pub struct Picks { pub microphone: Option<String>, pub cable: Option<String>, pub headphones: Option<String> }` (serde camelCase), `pub fn automatic(recording_mic: &str, list: &DeviceList) -> Picks`
  - `pub struct DeviceChoices { pub inputs: Vec<String>, pub outputs: Vec<String>, pub automatic: Picks }` (serde camelCase), `pub fn choices(recording_mic: &str) -> DeviceChoices`
  - `pub struct EngineDevices { pub microphone: String, pub cable: String, pub headphones: String }` (`Clone`, `PartialEq`, `Debug`)
  - `pub struct Problem { pub reason: String, pub device: String, pub name: String, pub detail: String }` (`Serialize`, `PartialEq`), `Problem::new(reason, device, name, detail)`; reasons `"no_cable"`, `"no_device"`, `"not_connected"`, `"mic_is_cable"`, `"open_failed"`, `"lost"`; devices `"microphone"`, `"cable"`, `"headphones"`
  - `pub fn resolve(saved: &Devices, recording_mic: &str, list: &DeviceList) -> Result<EngineDevices, Problem>` (refuses a cable endpoint as the microphone: it would hear itself)
  - `pub struct Callbacks { pub on_tick: Box<dyn FnMut(Vec<PlayingVoice>) + Send>, pub on_lost: Box<dyn FnOnce(Problem) + Send> }`
  - `pub struct EngineInfo { microphone, cable, headphones: String, mic_rate: u32, mic_channels: u16, cable_rate: u32, cable_channels: u16, headphones_rate: u32, headphones_channels: u16 }` (all `pub`, serde camelCase)
  - `pub struct EngineStats { #[serde(flatten)] pub info: EngineInfo, #[serde(flatten)] pub drift: DriftStats }`
  - `pub struct Engine { pub generation: u64, .. }` with `start(generation: u64, devices: EngineDevices, mixer: Mixer, callbacks: Callbacks) -> Result<Engine, Problem>`, `info(&self) -> &EngineInfo`, `stats(&self) -> EngineStats`, `with_mixer<R>(&self, f: impl FnOnce(&mut Mixer) -> R) -> R`, `start_voice(&self, sound_id: &str, volume: f32, wav: &Path) -> Result<(), String>`, `stop(self)`
  - `pub fn spawn_reader(wav: &Path) -> Result<(Arc<VoiceShared>, u64), String>`
  - `pub struct Levels { pub rms: f32, pub peak: f32, pub frames: u64, pub rate: u32, pub channels: u16 }` (serde camelCase), `pub fn capture_levels(device: &str, ms: u64, loopback: bool) -> Result<Levels, String>`

- [ ] **Step 1: Failing tests**

In `mod.rs`, add `pub mod engine;` after `pub mod drift;`. Create `engine.rs` with the tests:

```rust
#[cfg(test)]
mod tests {
    use super::*;
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
        for (k, f) in got.chunks(2).take(144_000).enumerate() {
            let v = ((k % 1000) as i16 * 16) as f32 / 32768.0;
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
}
```

Run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib soundboard::engine::`. Expected: compile errors (`DeviceList`, `resolve`, `spawn_reader`, … not found).

- [ ] **Step 2: The engine**

Put this above the tests in `engine.rs`:

```rust
//! The soundboard's devices. While the virtual microphone is on, three
//! cpal streams (WASAPI shared mode, each device's own format) run on the
//! "rf-soundboard" thread: the microphone in, the virtual cable out
//! (microphone + sounds) and the headphones out (sounds only). Every
//! playing sound has a reader thread that keeps about a second of it in
//! memory, so no audio callback touches a file.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::sync::atomic::Ordering;
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

/// The VB-Audio cable's input: a name with "VB-Audio Virtual Cable" or
/// "CABLE Input", preferring the stereo endpoint over "CABLE In 16 Ch"
/// (both feed "CABLE Output").
pub fn auto_cable(outputs: &[String]) -> Option<String> {
    let cables: Vec<&String> = outputs.iter().filter(|n| is_cable(n)).collect();
    cables
        .iter()
        .find(|n| !n.to_ascii_lowercase().contains("16 ch"))
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
        let (m, d, c, open) = (mixer.clone(), drift.clone(), control.clone(), devices.clone());
        let Callbacks { mut on_tick, on_lost } = callbacks;
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
                let lost = run_until_stopped(&control_rx, &m, &mut *on_tick);
                drop(streams);
                let _ = stopped_tx.send(());
                if let Some(problem) = lost {
                    // Off this thread: the handler takes the engine out of
                    // the board and waits for it to stop.
                    std::thread::spawn(move || on_lost(problem));
                }
            })
            .map_err(|e| Problem::new("open_failed", "cable", &devices.cable, &e.to_string()))?;
        match ready_rx.recv_timeout(OPEN_TIMEOUT) {
            Ok(Ok(info)) => Ok(Engine { generation, control, stopped, mixer, drift, info }),
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
    pub fn start_voice(&self, sound_id: &str, volume: f32, wav: &Path) -> Result<(), String> {
        let (shared, frames) = spawn_reader(wav)?;
        lock(&self.mixer).start(sound_id, volume, frames, shared);
        Ok(())
    }

    /// Close the streams. Dropping a WASAPI stream joins its thread; a
    /// wedged device must not hang the caller for long.
    pub fn stop(self) {
        let _ = self.control.send(Control::Stop);
        let _ = self.stopped.recv_timeout(Duration::from_secs(3));
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.control.send(Control::Stop);
    }
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
                    buffer.finish();
                    return;
                }
            }
            Err(e) => {
                startup_log::log(&format!("[soundboard] reading a sound failed: {}", e));
                lock(&shared.buffer).finish();
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
```

Run the same command. Expected: 4 passed.

- [ ] **Step 3: The probe on the real devices**

Create `src-tauri/examples/soundboard_probe.rs`:

```rust
//! The soundboard engine on the real devices, without the app: plays a
//! sound into the VB-Audio cable and measures what arrives on "CABLE
//! Output" and on the headphones output. The headphones output is the
//! cable's 16-channel endpoint, so nothing plays on the speakers.
//!
//!   cargo run --no-default-features --example soundboard_probe -- <audio file of 8 s>

use std::path::Path;
use std::time::Duration;

use rudariflow_lib::soundboard::engine::{self, Callbacks, Engine, EngineDevices};
use rudariflow_lib::soundboard::{mixer::Mixer, prepare};

const CABLE_OUTPUT: &str = "CABLE Output (VB-Audio Virtual Cable)";

fn main() {
    let src = std::env::args().nth(1).expect("usage: soundboard_probe <audio file>");
    let dir = std::env::temp_dir().join("rudariflow_soundboard_probe");
    let _ = std::fs::remove_dir_all(&dir);
    let prepared = prepare::prepare(&dir, Path::new(&src), "s-probe").expect("prepare");
    println!("prepared: {} ms", prepared.duration_ms);
    let list = engine::device_list();
    println!("inputs: {:?}\noutputs: {:?}", list.inputs, list.outputs);
    let devices = EngineDevices {
        microphone: list
            .default_input
            .clone()
            .filter(|n| !n.contains("VB-Audio"))
            .expect("no microphone, or Windows' default microphone is the cable itself"),
        cable: engine::auto_cable(&list.outputs).expect("no VB-Audio Virtual Cable"),
        headphones: list.outputs.iter().find(|n| n.contains("16 Ch")).cloned().expect("no 16 Ch cable endpoint"),
    };
    let callbacks = Callbacks { on_tick: Box::new(|_| {}), on_lost: Box::new(|p| eprintln!("lost: {:?}", p)) };
    let running = Engine::start(1, devices.clone(), Mixer::new(false, 1.0, 1.0), callbacks).expect("start");
    println!("started: {}", serde_json::to_string(&running.stats()).unwrap());
    let quiet = engine::capture_levels(CABLE_OUTPUT, 1000, false).expect("capture");
    println!("cable before: {:?}", quiet);
    running.start_voice("s-probe", 1.0, &prepare::cache_path(&dir, "s-probe")).expect("play");
    std::thread::sleep(Duration::from_millis(300));
    let cable = engine::capture_levels(CABLE_OUTPUT, 1000, false).expect("capture");
    let headphones = engine::capture_levels(&devices.headphones, 1000, true).expect("loopback");
    println!("cable playing: {:?}\nheadphones loopback: {:?}", cable, headphones);
    std::thread::sleep(Duration::from_secs(3));
    println!("after 5 s: {}", serde_json::to_string(&running.stats()).unwrap());
    running.stop();
    let _ = std::fs::remove_dir_all(&dir);
}
```

In `src-tauri/Cargo.toml`, after the last `[[example]]` entry (`speakers_bench`), add:

```toml

[[example]]
name = "soundboard_probe"
path = "examples/soundboard_probe.rs"
```

Make the 8 s test tone in your scratch folder `$S` (see "Live checks"), then run the probe:

```bash
S=<your scratch folder, forward slashes>
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "aevalsrc=0.5*sin(2*PI*440*t)|0.5*sin(2*PI*440*t):s=48000:d=8" -c:a pcm_s16le "$S/tone8s.wav"
source /e/claude/RudariFlow/.superpowers/tools/env13.sh
cd /e/claude/RudariFlow/src-tauri && CARGO_TARGET_DIR='C:\t\rf-cpu' cargo run --no-default-features --example soundboard_probe -- "$S/tone8s.wav"
```

This does not start RudariFlow and plays nothing on the speakers (the "headphones" are the cable's 16-channel endpoint). It opens the default microphone in shared mode for about 6 s.

Expected:
- `prepared: 8000 ms`; the outputs list `Speakers (VB-Audio Virtual Cable)` and `CABLE In 16 Ch (VB-Audio Virtual Cable)`.
- `started:` shows `"cable":"Speakers (VB-Audio Virtual Cable)"` and the three rates (48000 or 44100) and channel counts (16 for the headphones endpoint).
- `cable before:` `rms` below 0.1 (only the room through the microphone).
- `cable playing:` `rms` above 0.2 (the tone through both cable endpoints, plus the microphone).
- `headphones loopback:` `rms` above 0.2 with `frames` above 40000. If `frames` is 0, cpal's loopback delivers nothing on this PC: note it for the controller; Task 7's live check then measures the headphones path on "CABLE Output" with "Others hear" at 0.
- `after 5 s:` `pushed` above 200000, `underruns` 0 or 1, `fillMs` between 5 and 45, no `lost:` line.

Record the printed lines for the report.

- [ ] **Step 4: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/soundboard/mod.rs src-tauri/src/soundboard/engine.rs src-tauri/examples/soundboard_probe.rs src-tauri/Cargo.toml
git commit -F - <<'EOF'
feat: soundboard audio engine with mic passthrough, cable and headphones

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---
### Task 6: The `Soundboard` object (library + engine + events)

**Files:**
- Modify: `src-tauri/src/soundboard/mod.rs`
- Test: `mod.rs` (`mod tests`)

**Interfaces:**
- Consumes: Tasks 2–5 (`Board`, `Devices`, `Sound`, `library::{new_id, default_name}`, `prepare::{prepare, ensure_cache, is_missing, remove_files, cache_path}`, `Mixer`, `PlayingVoice`, `engine::{resolve, device_list, Engine, Callbacks, EngineStats, Problem}`).
- Produces (`rudariflow_lib::soundboard`):
  - `pub enum Status { Off, On { cable: String }, Error { problem: Problem } }` (serde `tag = "state"`, camelCase: `{"state":"off"}`, `{"state":"on","cable":"…"}`, `{"state":"error","problem":{…}}`)
  - `pub enum Event { Changed, Playing(Vec<PlayingVoice>), Status(Status) }`
  - `pub struct BoardState { pub board: Board, pub status: Status, pub playing: Vec<PlayingVoice>, pub missing: Vec<String>, pub hotkeys_taken: Vec<String> }` (serde camelCase)
  - `pub struct AddResult { pub path: String, pub name: String, pub id: Option<String>, pub error: Option<String> }` (serde camelCase)
  - `pub struct Soundboard` with `new(app_dir: &Path, events: Box<dyn Fn(Event) + Send + Sync>) -> Arc<Soundboard>`, `dir(&self) -> &Path`, `board(&self) -> Board`, `is_on(&self) -> bool`, `status(&self) -> Status`, `state(&self) -> BoardState`, `turn_on(&self, recording_mic: &str) -> Result<(), Problem>`, `turn_off(&self)`, `shutdown(&self)`, `set_devices(&self, devices: Devices, recording_mic: &str) -> Status`, `set_volumes(&self, others: f32, me: f32) -> Result<(), String>`, `set_layer(&self, layer: bool) -> Result<(), String>`, `add(&self, paths: &[String]) -> Vec<AddResult>`, `remove(&self, id: &str) -> Result<Sound, String>`, `rename(&self, id: &str, name: &str) -> Result<(), String>`, `set_category(&self, id: &str, category: &str) -> Result<(), String>`, `set_sound_volume(&self, id: &str, volume: f32) -> Result<(), String>`, `set_sound_hotkey(&self, id: &str, hotkey: &str) -> Result<(), String>`, `set_stop_hotkey(&self, hotkey: &str) -> Result<(), String>`, `set_hotkeys_taken(&self, taken: Vec<String>)`, `play(&self, id: &str) -> Result<bool, String>` (errors `"off"`, `"no_sound"`, `"missing"`), `stop_all(&self)`, `category_add(&self, name: &str) -> Result<String, String>`, `category_rename(&self, id: &str, name: &str) -> Result<(), String>`, `category_remove(&self, id: &str) -> Result<(), String>`, `set_window(&self, popped_out: Option<bool>, always_on_top: Option<bool>)`, `stats(&self) -> Option<EngineStats>`
  - Behaviour: any failure to turn on and a device lost while on set `enabled` to false (saved) and the status to `Error`; `turn_off` saves `enabled: false`; `shutdown` (app exit) stops the engine and saves nothing.

- [ ] **Step 1: Failing tests**

At the end of `src-tauri/src/soundboard/mod.rs`, add:

```rust
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn fixture(name: &str) -> String {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/soundboard")
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    /// A board in a fresh folder, with its events as short strings.
    fn board(name: &str) -> (Arc<Soundboard>, mpsc::Receiver<String>, PathBuf) {
        let app_dir = std::env::temp_dir().join(format!("rudariflow_sb_{}", name));
        let _ = std::fs::remove_dir_all(&app_dir);
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sb = Soundboard::new(
            &app_dir,
            Box::new(move |event| {
                let text = match event {
                    Event::Changed => "changed".to_string(),
                    Event::Playing(voices) => format!("playing:{}", voices.len()),
                    Event::Status(status) => format!("status:{:?}", status),
                };
                let _ = lock(&tx).send(text);
            }),
        );
        (sb, rx, app_dir)
    }

    fn drain(rx: &mpsc::Receiver<String>) -> Vec<String> {
        rx.try_iter().collect()
    }

    #[test]
    fn sounds_are_added_organised_and_removed() {
        let (sb, rx, app_dir) = board("library");
        let results = sb.add(&[fixture("tone.wav"), fixture("tone.ogg")]);
        assert!(results.iter().all(|r| r.error.is_none() && r.id.is_some()), "{:?}", results);
        assert_eq!(results[0].name, "tone");
        let ids: Vec<String> = results.iter().map(|r| r.id.clone().unwrap()).collect();
        assert_ne!(ids[0], ids[1]);
        assert_eq!(drain(&rx), ["changed", "changed"]);
        let memes = sb.category_add("Memes").unwrap();
        sb.rename(&ids[0], "airhorn").unwrap();
        sb.set_category(&ids[0], &memes).unwrap();
        sb.set_sound_volume(&ids[0], 0.5).unwrap();
        assert_eq!(sb.rename("s-none", "x"), Err("no_sound".to_string()));
        // Saved: the file on disk has it all.
        let saved = Board::load(&app_dir.join("soundboard"));
        let s = saved.sound(&ids[0]).unwrap();
        assert_eq!((s.name.as_str(), s.category.as_str(), s.volume), ("airhorn", memes.as_str(), 0.5));
        assert!((950..=1100).contains(&s.duration_ms), "{}", s.duration_ms);
        let removed = sb.remove(&ids[0]).unwrap();
        assert!(!sb.dir().join(&removed.file).exists());
        assert!(!prepare::cache_path(sb.dir(), &ids[0]).exists());
        assert_eq!(sb.board().sounds.len(), 1);
        sb.category_remove(&memes).unwrap();
        assert!(sb.board().categories.is_empty());
    }

    #[test]
    fn a_file_that_fails_is_reported_and_the_rest_are_added() {
        let (sb, _rx, app_dir) = board("failures");
        std::fs::create_dir_all(&app_dir).unwrap();
        let text = app_dir.join("notes.txt");
        std::fs::write(&text, "x").unwrap();
        let results = sb.add(&[text.to_string_lossy().into_owned(), fixture("tone.flac")]);
        assert_eq!(results[0].error.as_deref(), Some("unsupported"));
        assert_eq!((results[0].name.as_str(), results[0].id.as_deref()), ("notes", None));
        assert!(results[1].error.is_none());
        assert_eq!(sb.board().sounds.len(), 1);
    }

    #[test]
    fn playing_needs_the_virtual_microphone_and_missing_files_show() {
        let (sb, _rx, _) = board("off");
        let id = sb.add(&[fixture("tone.wav")])[0].id.clone().unwrap();
        assert_eq!(sb.play(&id), Err("off".to_string()));
        assert_eq!(sb.play("s-none"), Err("no_sound".to_string()));
        sb.stop_all();
        assert!(sb.state().missing.is_empty());
        let sound = sb.board().sound(&id).cloned().unwrap();
        prepare::remove_files(sb.dir(), &sound);
        assert_eq!(sb.state().missing, vec![id]);
        assert_eq!(sb.status(), Status::Off);
        assert!(sb.state().playing.is_empty());
    }

    #[test]
    fn a_missing_device_keeps_it_off_with_the_reason() {
        let (sb, rx, _) = board("device");
        let devices = Devices { cable: "No Such Cable (RudariFlow test)".into(), ..Devices::default() };
        assert_eq!(sb.set_devices(devices, "default"), Status::Off, "off: the devices are only saved");
        let problem = sb.turn_on("default").unwrap_err();
        assert_eq!(problem, Problem::new("not_connected", "cable", "No Such Cable (RudariFlow test)", ""));
        assert!(!sb.is_on());
        assert_eq!(sb.status(), Status::Error { problem });
        assert!(!sb.board().enabled);
        assert!(drain(&rx).iter().any(|e| e.starts_with("status:Error")));
        sb.turn_off();
        assert_eq!(sb.status(), Status::Off);
        assert_eq!(serde_json::to_string(&Status::Off).unwrap(), r#"{"state":"off"}"#);
        assert_eq!(serde_json::to_string(&Status::On { cable: "C".into() }).unwrap(), r#"{"state":"on","cable":"C"}"#);
    }

    #[test]
    fn settings_are_saved_and_taken_hotkeys_announced_once() {
        let (sb, rx, app_dir) = board("settings");
        sb.set_volumes(0.5, 2.0).unwrap();
        sb.set_layer(true).unwrap();
        sb.set_stop_hotkey("F14").unwrap();
        sb.set_window(Some(true), Some(true));
        let saved = Board::load(&app_dir.join("soundboard"));
        assert_eq!((saved.others_volume, saved.me_volume, saved.layer), (0.5, 1.0, true));
        assert_eq!(saved.stop_hotkey, "F14");
        assert!(saved.window.always_on_top);
        assert!(sb.board().window.popped_out);
        drain(&rx);
        sb.set_hotkeys_taken(vec!["stopSounds".into()]);
        sb.set_hotkeys_taken(vec!["stopSounds".into()]);
        assert_eq!(drain(&rx), ["changed"]);
        assert_eq!(sb.state().hotkeys_taken, vec!["stopSounds".to_string()]);
    }
}
```

Run (from `src-tauri`, after `source …/env13.sh`): `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib soundboard::tests::`. Expected: compile errors (`Soundboard`, `Event`, `Status` not found).

- [ ] **Step 2: The `Soundboard`**

Replace the part of `mod.rs` above the tests with:

```rust
//! The soundboard: sounds on hotkeys, played into a virtual microphone (a
//! VB-Audio Virtual Cable) together with the user's own voice, and on the
//! headphones. See docs/superpowers/specs/2026-09-29-soundboard-design.md.
//!
//! `Soundboard` holds the library, the engine while the "Virtual
//! microphone" is on, and reports every change as an `Event`. The Tauri
//! commands and the hotkeys are in main.rs.

pub mod drift;
pub mod engine;
pub mod library;
pub mod mixer;
pub mod prepare;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex, Weak};

use serde::Serialize;

use self::engine::{Callbacks, Engine, EngineStats, Problem};
use self::library::{Board, Devices, Sound};
use self::mixer::{Mixer, PlayingVoice};
use crate::audio::lock;
use crate::startup_log;

/// Whether the virtual microphone runs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Off,
    On { cable: String },
    Error { problem: Problem },
}

/// What the views need to hear about; main.rs turns them into events.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// The library or the settings changed ("soundboard-changed").
    Changed,
    /// The playing sounds ("soundboard-playing").
    Playing(Vec<PlayingVoice>),
    /// On, off or failed ("soundboard-status").
    Status(Status),
}

/// Everything a view renders.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardState {
    pub board: Board,
    pub status: Status,
    pub playing: Vec<PlayingVoice>,
    /// Sounds whose files were deleted by hand.
    pub missing: Vec<String>,
    /// Sound ids, and "stopSounds", whose hotkey another program owns.
    pub hotkeys_taken: Vec<String>,
}

/// One file of an add.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddResult {
    pub path: String,
    pub name: String,
    pub id: Option<String>,
    /// "unsupported", "too_long", "no_audio", "unreadable: …" or "disk: …".
    pub error: Option<String>,
}

pub struct Soundboard {
    /// `<app data>\soundboard`.
    dir: PathBuf,
    board: Mutex<Board>,
    /// While the virtual microphone is on.
    engine: Mutex<Option<Engine>>,
    on: AtomicBool,
    generation: AtomicU64,
    status: Mutex<Status>,
    /// The last report of the engine, for `state`.
    playing: Mutex<Vec<PlayingVoice>>,
    hotkeys_taken: Mutex<Vec<String>>,
    events: Box<dyn Fn(Event) + Send + Sync>,
    this: Weak<Soundboard>,
}

impl Soundboard {
    /// The board in `<app_dir>\soundboard`, off. `events` gets every change.
    pub fn new(app_dir: &Path, events: Box<dyn Fn(Event) + Send + Sync>) -> Arc<Soundboard> {
        let dir = app_dir.join("soundboard");
        let board = Board::load(&dir);
        Arc::new_cyclic(|this| Soundboard {
            dir,
            board: Mutex::new(board),
            engine: Mutex::new(None),
            on: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            status: Mutex::new(Status::Off),
            playing: Mutex::new(Vec::new()),
            hotkeys_taken: Mutex::new(Vec::new()),
            events,
            this: this.clone(),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn board(&self) -> Board {
        lock(&self.board).clone()
    }

    pub fn is_on(&self) -> bool {
        self.on.load(SeqCst)
    }

    pub fn status(&self) -> Status {
        lock(&self.status).clone()
    }

    pub fn state(&self) -> BoardState {
        let board = self.board();
        let missing = board.sounds.iter().filter(|s| prepare::is_missing(&self.dir, s)).map(|s| s.id.clone()).collect();
        BoardState {
            board,
            status: self.status(),
            playing: lock(&self.playing).clone(),
            missing,
            hotkeys_taken: lock(&self.hotkeys_taken).clone(),
        }
    }

    /// Turn the virtual microphone on: open the saved devices, or the
    /// automatic ones (`recording_mic` is the Recording setting's
    /// microphone). A missing or failing device leaves it off, with the
    /// reason in the status.
    pub fn turn_on(&self, recording_mic: &str) -> Result<(), Problem> {
        let mut slot = lock(&self.engine);
        if slot.is_some() {
            return Ok(());
        }
        let board = self.board();
        let generation = self.generation.fetch_add(1, SeqCst) + 1;
        let started = engine::resolve(&board.devices, recording_mic, &engine::device_list()).and_then(|devices| {
            let (ticks, lost) = (self.this.clone(), self.this.clone());
            let callbacks = Callbacks {
                on_tick: Box::new(move |voices| {
                    if let Some(sb) = ticks.upgrade() {
                        sb.set_playing(voices);
                    }
                }),
                on_lost: Box::new(move |problem| {
                    if let Some(sb) = lost.upgrade() {
                        sb.engine_lost(generation, problem);
                    }
                }),
            };
            Engine::start(generation, devices, Mixer::new(board.layer, board.others_volume, board.me_volume), callbacks)
        });
        match started {
            Ok(engine) => {
                let info = engine.info().clone();
                *slot = Some(engine);
                self.on.store(true, SeqCst);
                drop(slot);
                startup_log::log(&format!(
                    "[soundboard] on: {} + sounds -> {}, sounds -> {}",
                    info.microphone, info.cable, info.headphones
                ));
                self.save_enabled(true);
                self.set_status(Status::On { cable: info.cable });
                Ok(())
            }
            Err(problem) => {
                drop(slot);
                startup_log::log(&format!("[soundboard] not on: {:?}", problem));
                self.save_enabled(false);
                self.set_status(Status::Error { problem: problem.clone() });
                Err(problem)
            }
        }
    }

    /// The switch was turned off.
    pub fn turn_off(&self) {
        self.stop_engine();
        self.save_enabled(false);
        self.set_status(Status::Off);
        startup_log::log("[soundboard] off");
    }

    /// The app quits: stop without changing the saved switch.
    pub fn shutdown(&self) {
        self.stop_engine();
    }

    fn stop_engine(&self) {
        let engine = lock(&self.engine).take();
        self.on.store(false, SeqCst);
        if let Some(engine) = engine {
            engine.stop();
        }
        self.set_playing(Vec::new());
    }

    /// A device failed while on (from the engine, on a thread of its own).
    fn engine_lost(&self, generation: u64, problem: Problem) {
        let engine = {
            let mut slot = lock(&self.engine);
            if slot.as_ref().map(|e| e.generation) != Some(generation) {
                return;
            }
            slot.take()
        };
        self.on.store(false, SeqCst);
        if let Some(engine) = engine {
            engine.stop();
        }
        startup_log::log(&format!("[soundboard] device lost, off: {:?}", problem));
        self.set_playing(Vec::new());
        self.save_enabled(false);
        self.set_status(Status::Error { problem });
    }

    fn save_enabled(&self, enabled: bool) {
        if lock(&self.board).enabled != enabled {
            let _ = self.update(|b| {
                b.enabled = enabled;
                Ok(())
            });
        }
    }

    fn set_status(&self, status: Status) {
        *lock(&self.status) = status.clone();
        (self.events)(Event::Status(status));
    }

    fn set_playing(&self, voices: Vec<PlayingVoice>) {
        *lock(&self.playing) = voices.clone();
        (self.events)(Event::Playing(voices));
    }

    /// Change the board, save it and tell the views.
    fn update<R>(&self, change: impl FnOnce(&mut Board) -> Result<R, String>) -> Result<R, String> {
        let result = {
            let mut board = lock(&self.board);
            let result = change(&mut board)?;
            board.save(&self.dir).map_err(|e| format!("disk: {}", e))?;
            result
        };
        (self.events)(Event::Changed);
        Ok(result)
    }

    /// `f` on the mixer while the engine runs.
    fn with_mixer(&self, f: impl FnOnce(&mut Mixer)) {
        if let Some(engine) = lock(&self.engine).as_ref() {
            engine.with_mixer(f);
        }
    }

    /// Save the chosen devices ("" = automatic). While on, the engine
    /// starts again on them; a missing one turns it off with the reason.
    pub fn set_devices(&self, devices: Devices, recording_mic: &str) -> Status {
        let _ = self.update(|b| {
            b.devices = devices;
            Ok(())
        });
        if self.is_on() {
            self.stop_engine();
            let _ = self.turn_on(recording_mic);
        }
        self.status()
    }

    pub fn set_volumes(&self, others: f32, me: f32) -> Result<(), String> {
        let (others, me) = (others.clamp(0.0, 1.0), me.clamp(0.0, 1.0));
        self.update(|b| {
            b.others_volume = others;
            b.me_volume = me;
            Ok(())
        })?;
        self.with_mixer(|m| {
            m.others_volume = others;
            m.me_volume = me;
        });
        Ok(())
    }

    pub fn set_layer(&self, layer: bool) -> Result<(), String> {
        self.update(|b| {
            b.layer = layer;
            Ok(())
        })?;
        self.with_mixer(|m| m.layer = layer);
        Ok(())
    }

    /// Add files, one by one; each gets its result.
    pub fn add(&self, paths: &[String]) -> Vec<AddResult> {
        paths
            .iter()
            .map(|path| {
                let name = library::default_name(Path::new(path));
                let id = library::new_id("s");
                let added = prepare::prepare(&self.dir, Path::new(path), &id).and_then(|prepared| {
                    let sound = Sound {
                        id: id.clone(),
                        name: name.clone(),
                        file: prepared.file,
                        category: String::new(),
                        hotkey: String::new(),
                        volume: 1.0,
                        duration_ms: prepared.duration_ms,
                    };
                    let kept = sound.clone();
                    self.update(|b| {
                        b.add_sound(sound);
                        Ok(())
                    })
                    .inspect_err(|_| prepare::remove_files(&self.dir, &kept))
                });
                match &added {
                    Ok(()) => startup_log::log(&format!("[soundboard] added '{}' as {}", name, id)),
                    Err(e) => startup_log::log(&format!("[soundboard] '{}' not added: {}", name, e)),
                }
                AddResult { path: path.clone(), name, id: added.is_ok().then_some(id), error: added.err() }
            })
            .collect()
    }

    /// Delete a sound and both of its files.
    pub fn remove(&self, id: &str) -> Result<Sound, String> {
        self.with_mixer(|m| {
            m.stop_sound(id);
        });
        let sound = self.update(|b| b.remove_sound(id).ok_or_else(|| "no_sound".to_string()))?;
        prepare::remove_files(&self.dir, &sound);
        Ok(sound)
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        self.update(|b| b.rename_sound(id, name))
    }

    pub fn set_category(&self, id: &str, category: &str) -> Result<(), String> {
        self.update(|b| b.set_category(id, category))
    }

    pub fn set_sound_volume(&self, id: &str, volume: f32) -> Result<(), String> {
        let volume = volume.clamp(0.0, 1.0);
        self.update(|b| b.set_sound_volume(id, volume))?;
        self.with_mixer(|m| m.set_sound_volume(id, volume));
        Ok(())
    }

    /// Saved as given; main.rs checks it and registers it.
    pub fn set_sound_hotkey(&self, id: &str, hotkey: &str) -> Result<(), String> {
        self.update(|b| b.set_sound_hotkey(id, hotkey))
    }

    pub fn set_stop_hotkey(&self, hotkey: &str) -> Result<(), String> {
        self.update(|b| {
            b.stop_hotkey = hotkey.to_string();
            Ok(())
        })
    }

    /// The hotkeys another program owns (sound ids, "stopSounds"); the views
    /// hear about it only when the list changes.
    pub fn set_hotkeys_taken(&self, taken: Vec<String>) {
        let changed = {
            let mut current = lock(&self.hotkeys_taken);
            let changed = *current != taken;
            *current = taken;
            changed
        };
        if changed {
            (self.events)(Event::Changed);
        }
    }

    /// Play a sound, or stop it when it plays. True when it started.
    /// Errors: "off", "no_sound", "missing" (its files are gone), or why the
    /// prepared file could not be read.
    pub fn play(&self, id: &str) -> Result<bool, String> {
        let sound = lock(&self.board).sound(id).cloned().ok_or("no_sound")?;
        let slot = lock(&self.engine);
        let engine = slot.as_ref().ok_or("off")?;
        if engine.with_mixer(|m| m.stop_sound(id)) {
            return Ok(false);
        }
        let wav = prepare::ensure_cache(&self.dir, &sound)?;
        engine.start_voice(id, sound.volume, &wav)?;
        Ok(true)
    }

    pub fn stop_all(&self) {
        self.with_mixer(|m| m.stop_all());
    }

    pub fn category_add(&self, name: &str) -> Result<String, String> {
        self.update(|b| b.add_category(name))
    }

    pub fn category_rename(&self, id: &str, name: &str) -> Result<(), String> {
        self.update(|b| b.rename_category(id, name))
    }

    pub fn category_remove(&self, id: &str) -> Result<(), String> {
        self.update(|b| b.remove_category(id))
    }

    /// The pop-out window opened or closed, or its Always on top switch.
    pub fn set_window(&self, popped_out: Option<bool>, always_on_top: Option<bool>) {
        let _ = self.update(|b| {
            if let Some(popped_out) = popped_out {
                b.window.popped_out = popped_out;
            }
            if let Some(always_on_top) = always_on_top {
                b.window.always_on_top = always_on_top;
            }
            Ok(())
        });
    }

    /// For the live checks; None while off.
    pub fn stats(&self) -> Option<EngineStats> {
        lock(&self.engine).as_ref().map(|e| e.stats())
    }
}
```

Run the same command. Expected: 5 passed. Then run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib soundboard::` — every soundboard test passes.

- [ ] **Step 3: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/soundboard/mod.rs
git commit -F - <<'EOF'
feat: soundboard state with on/off, library changes and events

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 7: Commands, events and hotkeys in the app

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/mouse_hotkey.rs`
- Modify: `src-tauri/src/mute.rs` (doc only)
- Test: `main.rs` (`mod tests`), `mouse_hotkey.rs` (`mod tests`); live: test instance

**Interfaces:**
- Consumes: `Soundboard` and friends (Task 6), `engine::{choices, capture_levels, DeviceChoices, Levels, EngineStats}` (Task 5), `library::{Board, Devices}` (Task 2).
- Produces:
  - `AppState.soundboard: Arc<Soundboard>`
  - `enum HotkeyAction { Dictation, PasteLast, RewriteLast, FreeGpu, StopSounds, Sound(String) }` (no longer `Copy`), `HotkeyAction::target(&self) -> String`
  - `fn board_hotkeys(board: &Board) -> Vec<(HotkeyAction, String)>`, `fn all_hotkeys(settings: &Settings, board: &Board) -> Vec<(HotkeyAction, String)>`, `fn taken_by(all: &[(HotkeyAction, String)], action: &HotkeyAction, hotkey: &str) -> Option<HotkeyAction>` (replaces `taken_by_other`), `fn owner_label(action: &HotkeyAction, board: &Board) -> String`, `fn check_board_hotkey(all, board, action, hotkey) -> Result<(), String>`
  - error text for a taken key: `'<hotkey>' is already used by <owner>`, owner `dictation` | `pasteLast` | `rewriteLast` | `freeGpu` | `stopSounds` | `sound:<name>`
  - `fn sync_board_hotkeys(app: &AppHandle)`, `fn spawn_board_hotkey_sync(app: &AppHandle)`
  - commands: `soundboard_state() -> BoardState`, `soundboard_set_enabled(enabled: bool) -> Status`, `soundboard_devices() -> DeviceChoices`, `soundboard_set_devices(devices: Devices) -> Status`, `soundboard_set_volumes(others: f32, me: f32)`, `soundboard_set_layer(layer: bool)`, `soundboard_add(paths: Vec<String>) -> Vec<AddResult>`, `soundboard_remove(id)`, `soundboard_rename(id, name)`, `soundboard_set_category(id, category)`, `soundboard_set_sound_volume(id, volume)`, `soundboard_set_hotkey(id, hotkey)`, `soundboard_set_stop_hotkey(hotkey)`, `soundboard_play(id) -> bool`, `soundboard_stop_all()`, `soundboard_category_add(name) -> String`, `soundboard_category_rename(id, name)`, `soundboard_category_remove(id)`; test-only `soundboard_capture_test(device: String, ms: u64, loopback: bool) -> Levels`, `soundboard_engine_stats() -> EngineStats` (`"off"` while off)
  - events `soundboard-changed` (no payload), `soundboard-playing` (`PlayingVoice[]`), `soundboard-status` (`Status`)
  - `mouse_hotkey::SLOTS = 64`

- [ ] **Step 1: Failing tests**

In `mouse_hotkey.rs`, add to `mod tests`:

```rust
    #[test]
    fn every_side_button_binding_fits() {
        // Two buttons with any of 16 modifier sets: 32 bindings, and
        // soundboard hotkeys may use all of them.
        let mut codes = std::collections::HashSet::new();
        for button in [MouseButton::Mouse4, MouseButton::Mouse5] {
            for bits in 0..16u8 {
                let modifiers = Modifiers { ctrl: bits & 1 != 0, shift: bits & 2 != 0, alt: bits & 4 != 0, win: bits & 8 != 0 };
                codes.insert(encode(MouseBinding { button, modifiers }));
            }
        }
        assert_eq!(codes.len(), 32);
        assert!(SLOTS >= codes.len(), "{} slots", SLOTS);
    }
```

In `main.rs`, in `mod tests`, add `use rudariflow_lib::soundboard::library::Sound;` below `use super::*;`, replace `a_hotkey_serves_one_action` with:

```rust
    #[test]
    fn a_hotkey_serves_one_action() {
        let mut s = Settings::default();
        s.rewrite_last_hotkey = "Shift+Mouse5".to_string();
        let all = hotkeys(&s);
        assert_eq!(
            taken_by(&all, &HotkeyAction::FreeGpu, "shift+mouse5"),
            Some(HotkeyAction::RewriteLast),
            "mouse bindings by button and modifiers"
        );
        assert_eq!(taken_by(&all, &HotkeyAction::FreeGpu, "cmdorctrl+shift+space"), Some(HotkeyAction::Dictation), "chords without case");
        assert_eq!(taken_by(&all, &HotkeyAction::RewriteLast, "Shift+Mouse5"), None, "its own hotkey");
        assert_eq!(taken_by(&all, &HotkeyAction::FreeGpu, "Alt+Shift+F10"), None);
    }
```

and add:

```rust
    fn board_with(stop: &str, sounds: &[(&str, &str, &str)]) -> Board {
        let mut board = Board::default();
        board.stop_hotkey = stop.to_string();
        for (id, name, hotkey) in sounds {
            board.sounds.push(Sound {
                id: id.to_string(),
                name: name.to_string(),
                file: format!("sounds/{}.wav", id),
                category: String::new(),
                hotkey: hotkey.to_string(),
                volume: 1.0,
                duration_ms: 1000,
            });
        }
        board
    }

    #[test]
    fn sound_and_stop_hotkeys_join_the_conflict_check() {
        let board = board_with("F14", &[("s-a", "airhorn", "F13"), ("s-b", "drums", "")]);
        assert_eq!(
            board_hotkeys(&board),
            vec![(HotkeyAction::StopSounds, "F14".to_string()), (HotkeyAction::Sound("s-a".into()), "F13".to_string())]
        );
        let all = all_hotkeys(&Settings::default(), &board);
        assert_eq!(all.len(), 6);
        let drums = HotkeyAction::Sound("s-b".into());
        assert_eq!(taken_by(&all, &drums, "f13"), Some(HotkeyAction::Sound("s-a".into())));
        assert_eq!(taken_by(&all, &drums, "F14"), Some(HotkeyAction::StopSounds));
        assert_eq!(taken_by(&all, &drums, "CmdOrCtrl+Shift+Space"), Some(HotkeyAction::Dictation));
        assert_eq!(
            taken_by(&all, &HotkeyAction::FreeGpu, "F13"),
            Some(HotkeyAction::Sound("s-a".into())),
            "the app's hotkeys cannot take a sound's key"
        );
        assert_eq!(taken_by(&all, &HotkeyAction::Sound("s-a".into()), "F13"), None, "its own");
        assert_eq!(taken_by(&all, &drums, "F15"), None);
    }

    #[test]
    fn a_taken_hotkey_names_its_owner() {
        let board = board_with("", &[("s-a", "air horn", "F13")]);
        assert_eq!(owner_label(&HotkeyAction::Sound("s-a".into()), &board), "sound:air horn");
        assert_eq!(owner_label(&HotkeyAction::StopSounds, &board), "stopSounds");
        assert_eq!(owner_label(&HotkeyAction::Dictation, &board), "dictation");
        assert_eq!(HotkeyAction::Sound("s-a".into()).target(), "s-a");
    }

    #[test]
    fn board_hotkeys_are_checked_before_saving() {
        let board = board_with("", &[("s-a", "airhorn", "F13"), ("s-b", "drums", "")]);
        let all = all_hotkeys(&Settings::default(), &board);
        let drums = HotkeyAction::Sound("s-b".into());
        assert_eq!(check_board_hotkey(&all, &board, &drums, ""), Ok(()), "off");
        assert_eq!(check_board_hotkey(&all, &board, &drums, "Numpad1"), Ok(()), "a key alone");
        assert_eq!(check_board_hotkey(&all, &board, &drums, "Shift+Mouse4"), Ok(()));
        assert!(check_board_hotkey(&all, &board, &drums, "CmdOrCtrl+C").unwrap_err().contains("Windows shortcut"));
        assert!(check_board_hotkey(&all, &board, &drums, "Banana+Q").unwrap_err().contains("not a valid hotkey"));
        assert_eq!(check_board_hotkey(&all, &board, &drums, "F13"), Err("'F13' is already used by sound:airhorn".to_string()));
        assert_eq!(
            check_board_hotkey(&all, &board, &HotkeyAction::StopSounds, "Alt+Shift+V"),
            Err("'Alt+Shift+V' is already used by pasteLast".to_string())
        );
    }
```

Run:

```bash
source /e/claude/RudariFlow/.superpowers/tools/env13.sh
cd /e/claude/RudariFlow/src-tauri
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib mouse_hotkey::
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --bins hotkey
```

Expected: `every_side_button_binding_fits` fails (`8 slots`); the `--bins` run fails to compile (`taken_by`, `board_hotkeys`, `HotkeyAction::Sound`, … not found).

- [ ] **Step 2: 64 mouse slots**

In `mouse_hotkey.rs`, change the first doc line to `//! Mouse side buttons as global hotkeys (dictation, paste last, rewrite last, free GPU, soundboard).` and replace

```rust
/// Most bindings at once (four hotkeys use them today).
const SLOTS: usize = 8;
```

with

```rust
/// Most bindings at once. Two buttons with 16 modifier sets make 32
/// different bindings; the soundboard's hotkeys may use all of them.
const SLOTS: usize = 64;
```

Run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib mouse_hotkey::`. Expected: all pass (the hook reads the slots with `std::array::from_fn`, so no other change is needed).

- [ ] **Step 3: The hotkey model with sounds, and the board's hotkeys following on/off**

In `main.rs`:

1. Below `use rudariflow_lib::{ai_cleanup, file_transcribe, media, screen_context};` add:

```rust
use rudariflow_lib::soundboard::library::{Board, Devices};
use rudariflow_lib::soundboard::{self, engine, AddResult, BoardState, Soundboard, Status};
```

2. In `struct AppState`, after `gpu: GpuFree,` add:

```rust
    /// The soundboard (library, engine while on).
    soundboard: Arc<Soundboard>,
```

3. Replace the `HotkeyAction` enum and its `impl` with:

```rust
/// What a global hotkey does.
#[derive(Clone, PartialEq, Debug)]
enum HotkeyAction {
    /// Start / stop dictation (the main hotkey).
    Dictation,
    /// Paste the last transcript again.
    PasteLast,
    /// Select the last dictation and record what to change about it.
    RewriteLast,
    /// Free the GPU, or load the models again (see `free_gpu_press`).
    FreeGpu,
    /// Stop every soundboard sound (registered while the board is on).
    StopSounds,
    /// Play or stop a soundboard sound, by id (registered while the board is on).
    Sound(String),
}

impl HotkeyAction {
    fn from_target(target: &str) -> Result<Self, String> {
        match target {
            "dictation" => Ok(Self::Dictation),
            "pasteLast" => Ok(Self::PasteLast),
            "rewriteLast" => Ok(Self::RewriteLast),
            "freeGpu" => Ok(Self::FreeGpu),
            _ => Err(format!("Unknown hotkey target: {}", target)),
        }
    }

    /// The name the UI knows this hotkey by: "dictation", "pasteLast",
    /// "rewriteLast", "freeGpu", "stopSounds", or the sound's id.
    fn target(&self) -> String {
        match self {
            Self::Dictation => "dictation".to_string(),
            Self::PasteLast => "pasteLast".to_string(),
            Self::RewriteLast => "rewriteLast".to_string(),
            Self::FreeGpu => "freeGpu".to_string(),
            Self::StopSounds => "stopSounds".to_string(),
            Self::Sound(id) => id.clone(),
        }
    }
}
```

4. Replace `fn taken_by_other(...) { ... }` with:

```rust
/// The stop-all and sound hotkeys that are set.
fn board_hotkeys(board: &Board) -> Vec<(HotkeyAction, String)> {
    std::iter::once((HotkeyAction::StopSounds, board.stop_hotkey.clone()))
        .chain(board.sounds.iter().map(|s| (HotkeyAction::Sound(s.id.clone()), s.hotkey.clone())))
        .filter(|(_, hotkey)| !hotkey.is_empty())
        .collect()
}

/// Every hotkey: the app's four and the soundboard's.
fn all_hotkeys(settings: &Settings, board: &Board) -> Vec<(HotkeyAction, String)> {
    let mut all = hotkeys(settings).to_vec();
    all.extend(board_hotkeys(board));
    all
}

/// The action other than `action` that already has `hotkey`: mouse
/// bindings by button and modifiers, chords without regard to case.
fn taken_by(all: &[(HotkeyAction, String)], action: &HotkeyAction, hotkey: &str) -> Option<HotkeyAction> {
    let same = |h: &str| match (mouse_hotkey::parse(hotkey), mouse_hotkey::parse(h)) {
        (Some(a), Some(b)) => a == b,
        _ => hotkey.eq_ignore_ascii_case(h),
    };
    all.iter().find(|(a, h)| a != action && !h.is_empty() && same(h)).map(|(a, _)| a.clone())
}

/// The owner in an "already used by" error, for the UI to put in words:
/// its target, and for a sound "sound:<name>".
fn owner_label(action: &HotkeyAction, board: &Board) -> String {
    match action {
        HotkeyAction::Sound(id) => format!("sound:{}", board.sound(id).map_or("", |s| s.name.as_str())),
        other => other.target(),
    }
}

/// Whether `hotkey` may become a sound's or stop all's: not a Windows
/// shortcut, a key or side button the hotkey code knows, and no other
/// hotkey's. Empty (off) is always fine. A key alone (the numpad, F13) is
/// allowed here; the settings UI only offers that for the soundboard.
fn check_board_hotkey(all: &[(HotkeyAction, String)], board: &Board, action: &HotkeyAction, hotkey: &str) -> Result<(), String> {
    if hotkey.is_empty() {
        return Ok(());
    }
    if rudariflow_lib::settings::is_windows_shortcut(hotkey) {
        return Err(format!("'{}' is a Windows shortcut (select all, copy, paste, ...)", hotkey));
    }
    if mouse_hotkey::parse(hotkey).is_none() && hotkey.parse::<tauri_plugin_global_shortcut::Shortcut>().is_err() {
        return Err(format!("'{}' is not a valid hotkey", hotkey));
    }
    match taken_by(all, action, hotkey) {
        Some(owner) => Err(format!("'{}' is already used by {}", hotkey, owner_label(&owner, board))),
        None => Ok(()),
    }
}
```

5. Replace `change_hotkey` with:

```rust
/// `target` is "dictation", "pasteLast", "rewriteLast" or "freeGpu"; each
/// takes a keyboard chord or a mouse side button. An empty `new_hotkey` turns
/// paste-last, rewrite or free GPU off; dictation always needs one. A key a
/// soundboard hotkey has is refused too, even while the board is off.
#[tauri::command]
fn change_hotkey(
    app: tauri::AppHandle,
    state: State<AppState>,
    target: String,
    new_hotkey: String,
) -> Result<(), String> {
    let action = HotkeyAction::from_target(&target)?;
    let board = state.soundboard.board();
    let all = all_hotkeys(&state.settings.lock().unwrap(), &board);
    let current = all.iter().find(|(a, _)| *a == action).map(|(_, h)| h.clone()).unwrap_or_default();
    if new_hotkey.is_empty() && action == HotkeyAction::Dictation {
        return Err("The dictation hotkey cannot be empty".to_string());
    }
    if !new_hotkey.is_empty() {
        if let Some(owner) = taken_by(&all, &action, &new_hotkey) {
            return Err(format!("'{}' is already used by {}", new_hotkey, owner_label(&owner, &board)));
        }
    }
    if new_hotkey != current {
        // Register the new chord before dropping the old one, so a rejected
        // chord (invalid name, taken by another app) leaves the old one working.
        if !new_hotkey.is_empty() {
            register_hotkey(&app, &new_hotkey, action.clone())?;
        }
        if !current.is_empty() {
            unregister_hotkey(&app, &current);
        }
    } else if !new_hotkey.is_empty() && !hotkey_is_registered(&app, &current) {
        register_hotkey(&app, &new_hotkey, action.clone())?;
    }
    startup_log::log(&format!("[hotkey] {:?} changed {} -> {}", action, current, new_hotkey));
    let mut settings = state.settings.lock().unwrap();
    match action {
        HotkeyAction::Dictation => settings.hotkey = new_hotkey,
        HotkeyAction::PasteLast => settings.paste_last_hotkey = new_hotkey,
        HotkeyAction::RewriteLast => settings.rewrite_last_hotkey = new_hotkey,
        HotkeyAction::FreeGpu => settings.free_gpu_hotkey = new_hotkey,
        // `from_target` names only the app's four.
        HotkeyAction::StopSounds | HotkeyAction::Sound(_) => {}
    }
    settings.save(&state.app_dir)?;
    Ok(())
}
```

6. Replace `set_hotkey_paused` with:

```rust
/// Temporarily release the global hotkeys while the settings UI captures a
/// new chord; a registered chord never reaches the webview as a keydown.
/// The soundboard's hotkeys follow off the main thread.
#[tauri::command]
fn set_hotkey_paused(
    app: tauri::AppHandle,
    state: State<AppState>,
    paused: bool,
) -> Result<(), String> {
    let all = hotkeys(&state.settings.lock().unwrap());
    let mut result = Ok(());
    for (action, hotkey) in all {
        if hotkey.is_empty() {
            continue;
        }
        if paused {
            unregister_hotkey(&app, &hotkey);
        } else if !hotkey_is_registered(&app, &hotkey) {
            let dictation = action == HotkeyAction::Dictation;
            if let Err(e) = register_hotkey(&app, &hotkey, action) {
                // An optional chord (paste last, rewrite, free GPU) taken by
                // another app must not block the dictation hotkey; it is
                // logged by register_hotkey.
                if dictation {
                    result = Err(e);
                }
            }
        }
    }
    HOTKEYS_PAUSED.store(paused, Ordering::SeqCst);
    spawn_board_hotkey_sync(&app);
    result
}
```

7. Replace `on_hotkey_event` with:

```rust
fn on_hotkey_event(handle: &AppHandle, action: &HotkeyAction, pressed: bool) {
    match action {
        HotkeyAction::Dictation => on_hotkey(handle, pressed),
        HotkeyAction::PasteLast if pressed => paste_last_transcript(handle),
        HotkeyAction::PasteLast => {}
        HotkeyAction::RewriteLast => on_rewrite_hotkey(handle, pressed),
        HotkeyAction::FreeGpu if pressed => on_free_gpu_hotkey(handle),
        HotkeyAction::FreeGpu => {}
        HotkeyAction::StopSounds if pressed => on_stop_sounds_hotkey(handle),
        HotkeyAction::StopSounds => {}
        HotkeyAction::Sound(id) if pressed => on_sound_hotkey(handle, id),
        HotkeyAction::Sound(_) => {}
    }
}

/// A sound's hotkey: play it, or stop it while it plays. Off the hotkey's
/// thread (chords arrive on the main thread).
fn on_sound_hotkey(handle: &AppHandle, id: &str) {
    let (handle, id) = (handle.clone(), id.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = handle.state::<AppState>().soundboard.play(&id) {
            startup_log::log(&format!("[soundboard] {} not played: {}", id, e));
        }
    });
}

/// The stop-all hotkey.
fn on_stop_sounds_hotkey(handle: &AppHandle) {
    let handle = handle.clone();
    tauri::async_runtime::spawn_blocking(move || handle.state::<AppState>().soundboard.stop_all());
}
```

8. In `register_hotkey`, change the two calls `on_hotkey_event(&handle, action, pressed);` and `on_hotkey_event(&handle, action, event.state == ShortcutState::Pressed);` to pass `&action`:

```rust
                on_hotkey_event(&handle, &action, pressed);
```

```rust
            on_hotkey_event(&handle, &action, event.state == ShortcutState::Pressed);
```

9. After `fn hotkey_is_registered(...) { ... }` add:

```rust
/// The stop-all and sound hotkeys registered now, with their actions.
static BOARD_HOTKEYS: Mutex<Vec<(String, HotkeyAction)>> = Mutex::new(Vec::new());
/// A hotkey is being captured in the UI: the board's hotkeys stay released.
static HOTKEYS_PAUSED: AtomicBool = AtomicBool::new(false);

/// Make the registered board hotkeys what the board wants: its stop-all
/// and sound hotkeys while it is on and no hotkey is being captured, none
/// otherwise. Keys another program owns are reported to the board ("Taken
/// by another program"). Never on the main thread: registering waits for it.
fn sync_board_hotkeys(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut registered = BOARD_HOTKEYS.lock().unwrap_or_else(|p| p.into_inner());
    let wanted = if state.soundboard.is_on() && !HOTKEYS_PAUSED.load(Ordering::SeqCst) {
        board_hotkeys(&state.soundboard.board())
    } else {
        Vec::new()
    };
    registered.retain(|(hotkey, action)| {
        let keep = wanted.iter().any(|(a, h)| h == hotkey && a == action);
        if !keep {
            unregister_hotkey(app, hotkey);
            startup_log::log(&format!("[soundboard] hotkey {} released", hotkey));
        }
        keep
    });
    let mut taken = Vec::new();
    for (action, hotkey) in wanted {
        if registered.iter().any(|(h, a)| *h == hotkey && *a == action) {
            continue;
        }
        match register_hotkey(app, &hotkey, action.clone()) {
            Ok(()) => registered.push((hotkey, action)),
            Err(_) => taken.push(action.target()),
        }
    }
    drop(registered);
    state.soundboard.set_hotkeys_taken(taken);
}

fn spawn_board_hotkey_sync(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || sync_board_hotkeys(&app));
}

/// The soundboard's changes as events for both views. Its hotkeys follow
/// every change and every status (see `sync_board_hotkeys`).
fn soundboard_event(event: soundboard::Event) {
    let Some(app) = APP_HANDLE.get() else { return };
    match event {
        soundboard::Event::Changed => {
            let _ = app.emit("soundboard-changed", ());
            spawn_board_hotkey_sync(app);
        }
        soundboard::Event::Playing(voices) => {
            let _ = app.emit("soundboard-playing", voices);
        }
        soundboard::Event::Status(status) => {
            let _ = app.emit("soundboard-status", status);
            spawn_board_hotkey_sync(app);
        }
    }
}
```

10. In `main()`, after `let history = Arc::new(History::load(&app_dir));` add:

```rust
    let soundboard = Soundboard::new(&app_dir, Box::new(soundboard_event));
```

and in `.manage(AppState { … })`, after `gpu: GpuFree::default(),` add `soundboard,`.

Run `CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --bins hotkey`. Expected: 5 passed (`free_gpu_is_the_fourth_hotkey`, `a_hotkey_serves_one_action`, `sound_and_stop_hotkeys_join_the_conflict_check`, `a_taken_hotkey_names_its_owner`, `board_hotkeys_are_checked_before_saving`). A warning about unused imports (`Devices`, `AddResult`, `BoardState`, `Status`, `engine`) is expected until Step 4.

- [ ] **Step 4: Commands, start and exit**

In `main.rs`, after `free_gpu_test` add:

```rust
#[tauri::command]
async fn soundboard_state(state: State<'_, AppState>) -> Result<BoardState, String> {
    Ok(state.soundboard.state())
}

/// The Virtual microphone switch. Returns the status after it (on, off, or
/// the reason it could not turn on).
#[tauri::command]
async fn soundboard_set_enabled(state: State<'_, AppState>, enabled: bool) -> Result<Status, String> {
    let (board, mic) = (state.soundboard.clone(), state.settings.lock().unwrap().microphone.clone());
    tauri::async_runtime::spawn_blocking(move || {
        if enabled {
            let _ = board.turn_on(&mic);
        } else {
            board.turn_off();
        }
        board.status()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Inputs and outputs for the Devices area, with the automatic picks.
#[tauri::command]
async fn soundboard_devices(state: State<'_, AppState>) -> Result<engine::DeviceChoices, String> {
    let mic = state.settings.lock().unwrap().microphone.clone();
    tauri::async_runtime::spawn_blocking(move || engine::choices(&mic)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn soundboard_set_devices(state: State<'_, AppState>, devices: Devices) -> Result<Status, String> {
    let (board, mic) = (state.soundboard.clone(), state.settings.lock().unwrap().microphone.clone());
    tauri::async_runtime::spawn_blocking(move || board.set_devices(devices, &mic)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn soundboard_set_volumes(state: State<'_, AppState>, others: f32, me: f32) -> Result<(), String> {
    state.soundboard.set_volumes(others, me)
}

#[tauri::command]
async fn soundboard_set_layer(state: State<'_, AppState>, layer: bool) -> Result<(), String> {
    state.soundboard.set_layer(layer)
}

/// Add files (copied into the soundboard folder); a result per file.
#[tauri::command]
async fn soundboard_add(state: State<'_, AppState>, paths: Vec<String>) -> Result<Vec<AddResult>, String> {
    let board = state.soundboard.clone();
    tauri::async_runtime::spawn_blocking(move || board.add(&paths)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn soundboard_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let board = state.soundboard.clone();
    tauri::async_runtime::spawn_blocking(move || board.remove(&id).map(|_| ())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn soundboard_rename(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    state.soundboard.rename(&id, &name)
}

#[tauri::command]
async fn soundboard_set_category(state: State<'_, AppState>, id: String, category: String) -> Result<(), String> {
    state.soundboard.set_category(&id, &category)
}

#[tauri::command]
async fn soundboard_set_sound_volume(state: State<'_, AppState>, id: String, volume: f32) -> Result<(), String> {
    state.soundboard.set_sound_volume(&id, volume)
}

/// A sound's hotkey ("" = none): checked against every other hotkey; the
/// board's hotkeys follow from the change event.
#[tauri::command]
async fn soundboard_set_hotkey(state: State<'_, AppState>, id: String, hotkey: String) -> Result<(), String> {
    let board = state.soundboard.board();
    let all = all_hotkeys(&state.settings.lock().unwrap(), &board);
    check_board_hotkey(&all, &board, &HotkeyAction::Sound(id.clone()), &hotkey)?;
    state.soundboard.set_sound_hotkey(&id, &hotkey)
}

/// The stop-all hotkey ("" = off).
#[tauri::command]
async fn soundboard_set_stop_hotkey(state: State<'_, AppState>, hotkey: String) -> Result<(), String> {
    let board = state.soundboard.board();
    let all = all_hotkeys(&state.settings.lock().unwrap(), &board);
    check_board_hotkey(&all, &board, &HotkeyAction::StopSounds, &hotkey)?;
    state.soundboard.set_stop_hotkey(&hotkey)
}

/// Play a sound, or stop it while it plays; true when it started.
#[tauri::command]
async fn soundboard_play(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let board = state.soundboard.clone();
    tauri::async_runtime::spawn_blocking(move || board.play(&id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn soundboard_stop_all(state: State<'_, AppState>) -> Result<(), String> {
    state.soundboard.stop_all();
    Ok(())
}

#[tauri::command]
async fn soundboard_category_add(state: State<'_, AppState>, name: String) -> Result<String, String> {
    state.soundboard.category_add(&name)
}

#[tauri::command]
async fn soundboard_category_rename(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    state.soundboard.category_rename(&id, &name)
}

#[tauri::command]
async fn soundboard_category_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.soundboard.category_remove(&id)
}

/// Test hook: record `ms` (at most 10 s) from an input such as "CABLE
/// Output", or with `loopback` what an output plays, and measure it. Only
/// with RUDARIFLOW_TEST_COMMANDS=1.
#[tauri::command]
async fn soundboard_capture_test(device: String, ms: u64, loopback: bool) -> Result<engine::Levels, String> {
    if std::env::var("RUDARIFLOW_TEST_COMMANDS").as_deref() != Ok("1") {
        return Err("test commands are off".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || engine::capture_levels(&device, ms.min(10_000), loopback))
        .await
        .map_err(|e| e.to_string())?
}

/// Test hook: the engine's devices, formats and microphone buffer; "off"
/// while off. Only with RUDARIFLOW_TEST_COMMANDS=1.
#[tauri::command]
async fn soundboard_engine_stats(state: State<'_, AppState>) -> Result<engine::EngineStats, String> {
    if std::env::var("RUDARIFLOW_TEST_COMMANDS").as_deref() != Ok("1") {
        return Err("test commands are off".to_string());
    }
    state.soundboard.stats().ok_or_else(|| "off".to_string())
}
```

In `generate_handler![…]`, after `diag_log,` add:

```rust
            soundboard_state,
            soundboard_set_enabled,
            soundboard_devices,
            soundboard_set_devices,
            soundboard_set_volumes,
            soundboard_set_layer,
            soundboard_add,
            soundboard_remove,
            soundboard_rename,
            soundboard_set_category,
            soundboard_set_sound_volume,
            soundboard_set_hotkey,
            soundboard_set_stop_hotkey,
            soundboard_play,
            soundboard_stop_all,
            soundboard_category_add,
            soundboard_category_rename,
            soundboard_category_remove,
            soundboard_capture_test,
            soundboard_engine_stats,
```

In `setup`, after the block `if !initial_free_gpu_hotkey.is_empty() { … }` add:

```rust
            // The virtual microphone was on when RudariFlow last ran: on
            // again. Its hotkeys follow from the status event.
            if app.state::<AppState>().soundboard.board().enabled {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = handle.state::<AppState>();
                    let mic = state.settings.lock().unwrap().microphone.clone();
                    let _ = state.soundboard.turn_on(&mic);
                });
            }
```

Replace the final `.run(|app, event| { … })` with:

```rust
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let state = app.state::<AppState>();
                state.llm.stop();
                // Keeps the saved switch: on again at the next start.
                state.soundboard.shutdown();
            }
        });
```

- [ ] **Step 5: "Mute other apps" leaves the soundboard alone**

`mute::imp::mute_all` skips every session whose process is RudariFlow or one of its children (`descends_from(pid, own, …)` is true for `pid == own`, tested by `follows_parent_chain`). The soundboard's cpal streams are sessions of RudariFlow's own process, so dictating with "Mute other apps while recording" on never mutes them. Record that in the module doc: in `src-tauri/src/mute.rs`, replace the doc lines

```rust
//! Mutes every audio session on every active playback device, except sessions
//! that belong to RudariFlow itself (the webview plays the start/stop sounds
//! from a child process) and sessions the user had already muted. `restore`
//! unmutes exactly the sessions that were muted here.
```

with

```rust
//! Mutes every audio session on every active playback device, except sessions
//! that belong to RudariFlow itself (the webview plays the start/stop sounds
//! from a child process; the soundboard's streams run in RudariFlow's own
//! process) and sessions the user had already muted. `restore` unmutes
//! exactly the sessions that were muted here.
```

- [ ] **Step 6: Compile, tests, lints**

```bash
source /e/claude/RudariFlow/.superpowers/tools/env13.sh
cd /e/claude/RudariFlow/src-tauri
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --bins hotkey
for f in soundboard:: mouse_hotkey:: mute:: media::; do CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib "$f" || break; done
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo clippy --no-default-features --lib --bins --examples 2>&1 | grep -A4 -E "^(warning|error)" | grep -E "main.rs|soundboard|media.rs|mouse_hotkey.rs" || echo "no findings in the changed files"
```

Expected: all pass, and `no findings in the changed files`. Fix a finding in lines this plan wrote; a finding in older lines predates the plan and stays.

- [ ] **Step 7: Live check on the test instance**

Build the app, check the headroom and prepare (see "Live checks" at the end). Before starting the test instance, give it a fresh board:

```powershell
Remove-Item -Recurse -Force C:\t\rf-test-data\soundboard -ErrorAction SilentlyContinue
```

In the scratch folder `$S` you need `tone8s.wav` (Task 5), plus:

```bash
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "aevalsrc=0.5*sin(2*PI*880*t)|0.5*sin(2*PI*880*t):s=48000:d=8" -c:a pcm_s16le "$S/beep8s.wav"
head -c 4096 /dev/urandom > "$S/corrupt.mp3"
```

Start the test instance. Write these files to `$S`, replacing `SCRATCH` with `$S` (forward slashes), and run each with `node E:/claude/RudariFlow/.superpowers/tools/cdp.mjs $S/<file>.js`:

`sb_setup.js`:
```js
const i = window.__TAURI_INTERNALS__.invoke;
const S = "SCRATCH";
const F = "E:/claude/RudariFlow/src-tauri/tests/fixtures/soundboard";
const formats = ["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"].map((e) => `${F}/tone.${e}`);
const added = await i("soundboard_add", { paths: [`${S}/tone8s.wav`, `${S}/beep8s.wav`, ...formats, `${S}/corrupt.mp3`, `${F}/video-only.m4a`] });
// Never the speakers: the headphones output goes to the cable's 16-channel endpoint.
await i("soundboard_set_devices", { devices: { microphone: "", cable: "", headphones: "CABLE In 16 Ch (VB-Audio Virtual Cable)" } });
const devices = await i("soundboard_devices");
const st = await i("soundboard_state");
return JSON.stringify({ added: added.map((a) => [a.name, a.error]), sounds: st.board.sounds.length, automatic: devices.automatic, status: st.status });
```

`sb_on.js`:
```js
const i = window.__TAURI_INTERNALS__.invoke;
const status = await i("soundboard_set_enabled", { enabled: true });
const stats = await i("soundboard_engine_stats").catch((e) => String(e));
return JSON.stringify({ status, stats });
```

`sb_levels.js`:
```js
const i = window.__TAURI_INTERNALS__.invoke;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = await i("soundboard_state");
const id = (name) => st.board.sounds.find((s) => s.name === name).id;
const cap = (device, loopback) => i("soundboard_capture_test", { device, ms: 1500, loopback });
// What Discord would record, what our cable stream plays, what our headphones stream plays.
const measure = async () => {
  const [out, cable, phones] = await Promise.all([
    cap("CABLE Output (VB-Audio Virtual Cable)", false),
    cap("Speakers (VB-Audio Virtual Cable)", true),
    cap("CABLE In 16 Ch (VB-Audio Virtual Cable)", true),
  ]);
  return { out: out.rms, cable: cable.rms, cableFrames: cable.frames, phones: phones.rms, phonesFrames: phones.frames };
};
const quiet = await measure();
await i("soundboard_set_volumes", { others: 1, me: 1 });
const started = await i("soundboard_play", { id: id("tone8s") });
await sleep(300);
const both = await measure();
await i("soundboard_set_volumes", { others: 1, me: 0 });
await sleep(200);
const othersOnly = await measure();
await i("soundboard_set_volumes", { others: 0, me: 1 });
await sleep(200);
const meOnly = await measure();
await i("soundboard_stop_all");
await i("soundboard_set_volumes", { others: 1, me: 0.7 });
return JSON.stringify({ quiet, started, both, othersOnly, meOnly });
```

`sb_rules.js`:
```js
const i = window.__TAURI_INTERNALS__.invoke;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = await i("soundboard_state");
const id = (name) => st.board.sounds.find((s) => s.name === name).id;
const playing = async () => {
  const s = await i("soundboard_state");
  return s.playing.map((p) => s.board.sounds.find((x) => x.id === p.id).name).sort();
};
await i("soundboard_set_layer", { layer: false });
await i("soundboard_play", { id: id("tone8s") });
await sleep(300);
await i("soundboard_play", { id: id("beep8s") });
await sleep(300);
const replace = await playing();
await i("soundboard_set_layer", { layer: true });
await i("soundboard_play", { id: id("tone8s") });
await sleep(300);
const layer = await playing();
const toggled = await i("soundboard_play", { id: id("beep8s") });
await sleep(300);
const afterToggle = await playing();
await i("soundboard_stop_all");
await sleep(300);
const afterStop = await playing();
await i("soundboard_set_layer", { layer: false });
return JSON.stringify({ replace, layer, toggled, afterToggle, afterStop });
```

`sb_hotkeys.js`:
```js
const i = window.__TAURI_INTERNALS__.invoke;
const st = await i("soundboard_state");
const id = (name) => st.board.sounds.find((s) => s.name === name).id;
const [tone, beep] = [id("tone8s"), id("beep8s")];
const settings = await i("get_settings");
const result = (p) => p.then(() => "ok", (e) => String(e));
await i("soundboard_set_enabled", { enabled: false });
await i("diag_log", { source: "check", message: "hotkeys-off" });
const setWhileOff = [
  await result(i("soundboard_set_hotkey", { id: tone, hotkey: "F13" })),
  await result(i("soundboard_set_stop_hotkey", { hotkey: "F14" })),
];
const refused = {
  sound: await result(i("soundboard_set_hotkey", { id: beep, hotkey: "F13" })),
  stop: await result(i("soundboard_set_hotkey", { id: beep, hotkey: "F14" })),
  dictation: await result(i("soundboard_set_hotkey", { id: beep, hotkey: settings.hotkey })),
  windows: await result(i("soundboard_set_hotkey", { id: beep, hotkey: "CmdOrCtrl+C" })),
  appHotkey: await result(i("change_hotkey", { target: "freeGpu", newHotkey: "F13" })),
};
await new Promise((r) => setTimeout(r, 500));
await i("diag_log", { source: "check", message: "hotkeys-on" });
const on = await i("soundboard_set_enabled", { enabled: true });
await new Promise((r) => setTimeout(r, 800));
await i("diag_log", { source: "check", message: "hotkeys-off-again" });
await i("soundboard_set_enabled", { enabled: false });
await new Promise((r) => setTimeout(r, 800));
return JSON.stringify({ setWhileOff, refused, on: on.state, taken: (await i("soundboard_state")).hotkeysTaken });
```

`sb_stats.js`:
```js
const i = window.__TAURI_INTERNALS__.invoke;
const a = await i("soundboard_engine_stats");
await new Promise((r) => setTimeout(r, 180_000));
const b = await i("soundboard_engine_stats");
return JSON.stringify({ a, b, pushedPerSec: (b.pushed - a.pushed) / 180, corrections: b.dropped + b.inserted - a.dropped - a.inserted });
```

`sb_files.js`:
```js
const i = window.__TAURI_INTERNALS__.invoke;
let st = await i("soundboard_state");
const tones = st.board.sounds.filter((s) => s.name === "tone").map((s) => s.id);
const [a, b, c] = tones;
const memes = await i("soundboard_category_add", { name: "Memes" });
await i("soundboard_rename", { id: a, name: "airhorn" });
await i("soundboard_set_category", { id: a, category: memes });
await i("soundboard_set_sound_volume", { id: a, volume: 0.5 });
await i("soundboard_remove", { id: b });
await i("soundboard_category_rename", { id: memes, name: "Funny" });
st = await i("soundboard_state");
const air = st.board.sounds.find((s) => s.id === a);
return JSON.stringify({ a, b, c, air: [air.name, air.category === memes, air.volume], categories: st.board.categories.map((x) => x.name), count: st.board.sounds.length });
```

`sb_missing.js` (replace `AID` and `CID` with `a` and `c` from `sb_files.js`):
```js
const i = window.__TAURI_INTERNALS__.invoke;
const replayed = await i("soundboard_play", { id: "AID" }).catch((e) => String(e));
await i("soundboard_stop_all");
const missing = (await i("soundboard_state")).missing;
const gone = await i("soundboard_play", { id: "CID" }).catch((e) => String(e));
return JSON.stringify({ replayed, missing, gone });
```

`sb_lost.js`:
```js
const i = window.__TAURI_INTERNALS__.invoke;
const on = await i("soundboard_set_enabled", { enabled: true });
await i("diag_log", { source: "check", message: "lost" });
const status = await i("soundboard_set_devices", { devices: { microphone: "", cable: "Missing Cable (RudariFlow test)", headphones: "CABLE In 16 Ch (VB-Audio Virtual Cable)" } });
await new Promise((r) => setTimeout(r, 800));
const st = await i("soundboard_state");
const stats = await i("soundboard_engine_stats").catch((e) => String(e));
await i("soundboard_set_devices", { devices: { microphone: "", cable: "", headphones: "CABLE In 16 Ch (VB-Audio Virtual Cable)" } });
return JSON.stringify({ on: on.state, status, enabled: st.board.enabled, stats });
```

`sb_status.js`:
```js
const s = await window.__TAURI_INTERNALS__.invoke("soundboard_state");
return JSON.stringify({ status: s.status, enabled: s.board.enabled });
```

Read the log with `Select-String -Path C:\t\rf-test-data\startup.log -Pattern "\[soundboard\]|\[check\]|registering F1[34]" | Select-Object -Last 40`.

Run in this order and expect:
1. `sb_setup.js`: ten `[name, null]` entries (`tone8s`, `beep8s`, eight `tone`), `corrupt` with an error starting `unreadable: ` (or `no_audio`), `video-only` with `no_audio`; `sounds: 10`; `automatic.cable: "Speakers (VB-Audio Virtual Cable)"`; `status: {"state":"off"}`.
2. `sb_on.js`: `status: {"state":"on","cable":"Speakers (VB-Audio Virtual Cable)"}`; `stats.headphones` is the 16 Ch endpoint; rates and channel counts are filled in. Windows shows the microphone-in-use icon.
3. `sb_levels.js`:
   - `quiet`: `phones` below 0.01, `cable` and `out` below 0.1 (only the room through the microphone).
   - `started: true`; `both`: `out`, `cable` and `phones` above 0.2.
   - `othersOnly` (You hear 0): `phones` below 0.01, `cable` above 0.2.
   - `meOnly` (Others hear 0): `phones` above 0.2, `cable` below 0.1.
   - If `cableFrames` or `phonesFrames` is 0, loopback delivers nothing on this PC: then judge `othersOnly` and `meOnly` by `out` (above 0.2 in both, since both endpoints feed CABLE Output), note it for the controller, and rely on Task 3's bus tests for the separation.
   - If `quiet.out` or `quiet.cable` is above 0.1, someone spoke near the microphone: run again.
4. `sb_rules.js`: `replace: ["beep8s"]`, `layer: ["beep8s","tone8s"]`, `toggled: false`, `afterToggle: ["tone8s"]`, `afterStop: []`.
5. `sb_hotkeys.js`: `setWhileOff: ["ok","ok"]`; `refused.sound: "'F13' is already used by sound:tone8s"`, `refused.stop: "'F14' is already used by stopSounds"`, `refused.dictation` ends `is already used by dictation`, `refused.windows` contains `Windows shortcut`, `refused.appHotkey: "'F13' is already used by sound:tone8s"`; `on: "on"`, `taken: []`. In the log: between `[check] hotkeys-off` and `[check] hotkeys-on` no `registering F13`/`F14` line; after `hotkeys-on` the lines `[hotkey] registering F13 for Sound("s-…")` and `[hotkey] registering F14 for StopSounds`; after `hotkeys-off-again` the lines `[soundboard] hotkey F13 released` and `[soundboard] hotkey F14 released`.
6. `sb_on.js` again, then `sb_stats.js` (takes 3 minutes; give the command a 240000 ms timeout): `pushedPerSec` within 1 % of `b.cableRate`; `b.underruns - a.underruns` at most 1; `b.fillMs` between 5 and 45; `b.maxFillMs` at most 60; `corrections` below 1 % of the frames pushed in between.
7. `sb_files.js`: `air: ["airhorn", true, 0.5]`, `categories: ["Funny"]`, `count: 9`. In PowerShell, `Test-Path C:\t\rf-test-data\soundboard\cache\<b>.wav` and `Test-Path C:\t\rf-test-data\soundboard\sounds\<b>.*` are both `False`.
8. Delete `C:\t\rf-test-data\soundboard\cache\<a>.wav`, and both `cache\<c>.wav` and `sounds\<c>.*`, with `Remove-Item`. Then `sb_missing.js`: `replayed: true` (and `cache\<a>.wav` exists again), `missing: ["<c>"]`, `gone: "missing"`.
9. `sb_lost.js`: `on: "on"`; `status: {"state":"error","problem":{"reason":"not_connected","device":"cable","name":"Missing Cable (RudariFlow test)","detail":""}}`; `enabled: false`; `stats: "off"`; after `[check] lost` the log has `[soundboard] not on:` and the `hotkey F13 released` / `F14 released` lines.
10. `sb_on.js`, then stop the test instance (as in "Live checks") and start it again. `sb_status.js`: `status.state: "on"`, `enabled: true`; the new log section has `[soundboard] on:` and `registering F13`. Then run `node …/cdp.mjs -e "return JSON.stringify(await window.__TAURI_INTERNALS__.invoke('soundboard_set_enabled', { enabled: false }))"`: `{"state":"off"}`.

Stop the test instance.

- [ ] **Step 8: Commit**

```bash
cd /e/claude/RudariFlow
git add src-tauri/src/main.rs src-tauri/src/mouse_hotkey.rs src-tauri/src/mute.rs
git commit -F - <<'EOF'
feat: soundboard commands, events and hotkeys that exist only while it is on

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---
### Task 8: The Soundboard tab

**Files:**
- Create: `src/hotkey-capture.ts`, `src/soundboard/api.ts`, `src/soundboard/board.ts`
- Modify: `src/main.ts`, `src/files.ts`, `index.html`, `src/i18n.ts`, `src/style.css`, `src-tauri/capabilities/default.json`
- Test: `npx tsc --noEmit`; live: test instance over CDP

**Interfaces:**
- Consumes: the commands and events of Task 7 (names and payloads there); `soundboard_pop_out`, `soundboard_dock`, `soundboard_set_always_on_top` come in Task 9 (the Pop out button and the pop-out-only row call them; this task's checks do not press them).
- Produces:
  - `src/hotkey-capture.ts`: `export interface CaptureTarget { button: HTMLElement; text: HTMLElement; allowBare?: boolean; apply(combo: string): Promise<void>; render(): void; done?(): void }`, `export function startCapture(target: CaptureTarget): boolean`, `export function hotkeyLabel(combo: string): string`, `export function keyEventToCombo(e: KeyboardEvent, allowBare?: boolean): string | null`, `export function mouseEventToCombo(e: MouseEvent): string | null`, `export function hotkeyError(err: unknown, combo: string): string`
  - `src/soundboard/api.ts`: the types `Board`, `Sound`, `Category`, `Devices`, `Problem`, `Status`, `PlayingVoice`, `BoardState`, `DeviceChoices`, `AddResult`, `EXTENSIONS`, and `api.{state, setEnabled, devices, setDevices, setVolumes, setLayer, add, remove, rename, setCategory, setSoundVolume, setHotkey, setStopHotkey, play, stopAll, categoryAdd, categoryRename, categoryRemove, popOut, dock, setAlwaysOnTop}`
  - `src/soundboard/board.ts`: `export function mountBoard(root: HTMLElement, options: { popOut: boolean }): { refresh(): Promise<void>; setActive(active: boolean): void }`
  - `FilesHost.acceptsDrops(): boolean` in `files.ts`
  - DOM: nav item `[data-section="soundboard"]`, `#section-soundboard`, `#sb-root`; the component's controls carry `data-key` (`enabled`, `others`, `me`, `layer`, `stop-hotkey`, `on-top`, `devices`, `device-<kind>`, `add`, `search`, `stop-all`, `pop-out`, `dock`, `chip-all`, `chip-<id>`, `chip-<id>-rename`, `chip-<id>-delete`, `chip-new`, `<soundId>-play|-name|-category|-hotkey|-hotkey-clear|-volume|-delete`, `hint-dismiss`, `cable-link`)

- [ ] **Step 1: The shared hotkey capture**

Create `src/hotkey-capture.ts`:

```ts
// Hotkey capture, shared by the Recording settings and the Soundboard (tab
// and pop-out window): a key combination or a mouse side button. The
// global hotkeys are released while it listens (`set_hotkey_paused`), so
// pressing a current one reaches the page.
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

export interface CaptureTarget {
  /** The button that was clicked; a click elsewhere cancels. */
  button: HTMLElement;
  /** Shows "Press a key…", then an error or the saved hotkey. */
  text: HTMLElement;
  /** Keys that work without a modifier (the numpad, F1–F24): soundboard hotkeys only. */
  allowBare?: boolean;
  /** Save the combination; throws the backend's error. */
  apply(combo: string): Promise<void>;
  /** Show the saved hotkey again. */
  render(): void;
  /** Called once the capture is over, saved or not. */
  done?(): void;
}

let capturing: CaptureTarget | null = null;

/** Keys a soundboard hotkey may use alone. */
const BARE_KEY = /^(Numpad\w+|F([1-9]|1\d|2[0-4]))$/;

export function hotkeyLabel(combo: string): string {
  if (!combo) return t("hotkey_none");
  const isMac = navigator.userAgent.includes("Mac");
  return combo
    .replace("CmdOrCtrl", isMac ? "Cmd" : "Ctrl")
    .replace("Mouse4", t("hotkey_mouse4"))
    .replace("Mouse5", t("hotkey_mouse5"));
}

function modifierTokens(e: KeyboardEvent | MouseEvent): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("CmdOrCtrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  return mods;
}

/** Mouse side buttons: MouseEvent.button 3 = back (XBUTTON1), 4 = forward
 *  (XBUTTON2). They work alone or with modifiers. */
export function mouseEventToCombo(e: MouseEvent): string | null {
  const button = e.button === 3 ? "Mouse4" : e.button === 4 ? "Mouse5" : null;
  return button ? [...modifierTokens(e), button].join("+") : null;
}

/** A key event as a hotkey string; null while only modifiers are down, and
 *  for a key alone unless `allowBare` allows it. */
export function keyEventToCombo(e: KeyboardEvent, allowBare = false): string | null {
  const k = e.key;
  if (["Control", "Shift", "Alt", "Meta", "OS"].includes(k)) return null;
  let key = k;
  // The numpad by its physical key: "Numpad1", "NumpadAdd".
  if (e.code.startsWith("Numpad")) key = e.code;
  else if (key === " ") key = "Space";
  else if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
  // Digits and punctuation: e.key changes with Shift ("!" instead of "1")
  // and with the layout (umlauts), so use the physical code (Digit1, Minus).
  else if (key.length === 1) key = e.code;
  // Function keys, arrows, etc. already match (F1, ArrowLeft, ...)
  const mods = modifierTokens(e);
  if (mods.length === 0) return allowBare && BARE_KEY.test(key) ? key : null;
  return [...mods, key].join("+");
}

/** The backend's refusal in words: a Windows shortcut, a key another
 *  hotkey has ("Already used by …"), or a key it does not know. */
export function hotkeyError(err: unknown, combo: string): string {
  const reason = String(err);
  if (reason.includes("Windows shortcut")) return t("hotkey_reserved").replace("{combo}", hotkeyLabel(combo));
  const owner = /already used by (\w+)(?::(.*))?$/.exec(reason);
  if (owner) return t("hotkey_taken_by").replace("{name}", ownerName(owner[1], owner[2]));
  return t("hotkey_invalid");
}

function ownerName(target: string, name?: string): string {
  if (target === "sound") return t("quoted").replace("{name}", name ?? "");
  const keys: Record<string, string> = {
    dictation: "hotkey_owner_dictation",
    pasteLast: "paste_last_label",
    rewriteLast: "rewrite_last_label",
    freeGpu: "free_gpu_label",
    stopSounds: "sb_stop_hotkey_label",
  };
  return keys[target] ? t(keys[target]) : target;
}

/** Listen for a hotkey for `target`. False when another capture runs. */
export function startCapture(target: CaptureTarget): boolean {
  if (capturing) return false;
  capturing = target;
  // Release the global hotkeys so pressing a current one reaches this window.
  invoke("set_hotkey_paused", { paused: true }).catch(console.error);
  target.button.classList.add("capturing");
  target.text.textContent = t("hotkey_press_keys");
  window.addEventListener("keydown", onKey, true);
  // A click outside cancels.
  setTimeout(() => window.addEventListener("mousedown", onMouse, true), 0);
  return true;
}

function stopCapture() {
  const target = capturing;
  capturing = null;
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("mousedown", onMouse, true);
  invoke("set_hotkey_paused", { paused: false }).catch(console.error);
  if (!target) return;
  target.button.classList.remove("capturing");
  target.render();
  target.done?.();
}

async function onKey(e: KeyboardEvent) {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") {
    stopCapture();
    return;
  }
  const combo = keyEventToCombo(e, capturing?.allowBare);
  if (combo) await apply(combo);
}

async function apply(combo: string) {
  const target = capturing;
  if (!target) return;
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("mousedown", onMouse, true);
  try {
    await target.apply(combo);
    stopCapture();
  } catch (err) {
    target.text.textContent = hotkeyError(err, combo);
    console.error("setting the hotkey failed:", err);
    setTimeout(stopCapture, 2500);
  }
}

function onMouse(e: MouseEvent) {
  if (!capturing) return;
  const combo = mouseEventToCombo(e);
  if (combo) {
    e.preventDefault();
    e.stopPropagation();
    void apply(combo);
    return;
  }
  if (!capturing.button.contains(e.target as Node)) stopCapture();
}

// Side buttons would otherwise go back and forward in the webview.
window.addEventListener("mouseup", (e) => {
  if (e.button === 3 || e.button === 4) e.preventDefault();
});
```

In `src/main.ts`:
- Add below `import { playStart, playStop, playDiscard, setVolume } from "./sounds";`:

```ts
import { hotkeyLabel, startCapture } from "./hotkey-capture";
import { mountBoard } from "./soundboard/board";
```

- Replace everything from the line `// Hotkey capture. "dictation" starts/stops recording, "pasteLast" pastes the` down to and including the `freeGpuClear.addEventListener("click", async () => { … });` block (the end of the hotkey section, just above `// ── Replacements ──`) with:

```ts
// Hotkeys. "dictation" starts/stops recording, "pasteLast" pastes the last
// transcript again, "rewriteLast" selects it and records an edit, "freeGpu"
// unloads the models or loads them again. Each takes a key combination or a
// mouse side button (with or without modifiers); the capture itself is in
// hotkey-capture.ts, shared with the Soundboard.
type HotkeyTarget = "dictation" | "pasteLast" | "rewriteLast" | "freeGpu";

function renderHotkeys() {
  hotkeyText.textContent = hotkeyLabel(currentSettings.hotkey);
  pasteLastText.textContent = hotkeyLabel(currentSettings.pasteLastHotkey);
  pasteLastClear.classList.toggle("hidden", !currentSettings.pasteLastHotkey);
  rewriteLastText.textContent = hotkeyLabel(currentSettings.rewriteLastHotkey);
  rewriteLastClear.classList.toggle("hidden", !currentSettings.rewriteLastHotkey);
  freeGpuText.textContent = hotkeyLabel(currentSettings.freeGpuHotkey);
  freeGpuClear.classList.toggle("hidden", !currentSettings.freeGpuHotkey);
}

function captureElements(target: HotkeyTarget) {
  if (target === "dictation") return { btn: hotkeyBtn, text: hotkeyText };
  if (target === "pasteLast") return { btn: pasteLastBtn, text: pasteLastText };
  if (target === "rewriteLast") return { btn: rewriteLastBtn, text: rewriteLastText };
  return { btn: freeGpuBtn, text: freeGpuText };
}

async function setHotkey(target: HotkeyTarget, combo: string) {
  await invoke("change_hotkey", { target, newHotkey: combo });
  if (target === "dictation") currentSettings.hotkey = combo;
  else if (target === "pasteLast") currentSettings.pasteLastHotkey = combo;
  else if (target === "rewriteLast") currentSettings.rewriteLastHotkey = combo;
  else currentSettings.freeGpuHotkey = combo;
}

function capture(target: HotkeyTarget) {
  const { btn, text } = captureElements(target);
  startCapture({ button: btn, text, apply: (combo) => setHotkey(target, combo), render: renderHotkeys });
}

hotkeyBtn.addEventListener("click", () => capture("dictation"));
pasteLastBtn.addEventListener("click", () => capture("pasteLast"));
rewriteLastBtn.addEventListener("click", () => capture("rewriteLast"));
rewriteLastClear.addEventListener("click", async () => {
  try {
    await setHotkey("rewriteLast", "");
  } catch (err) {
    console.error("clearing rewrite hotkey failed:", err);
  }
  renderHotkeys();
});
pasteLastClear.addEventListener("click", async () => {
  try {
    await setHotkey("pasteLast", "");
  } catch (err) {
    console.error("clearing paste-last hotkey failed:", err);
  }
  renderHotkeys();
});
freeGpuBtn.addEventListener("click", () => capture("freeGpu"));
freeGpuClear.addEventListener("click", async () => {
  try {
    await setHotkey("freeGpu", "");
  } catch (err) {
    console.error("clearing free-GPU hotkey failed:", err);
  }
  renderHotkeys();
});
```

Run (repo root): `npx tsc --noEmit`. Expected: an error only for the missing module `./soundboard/board` (created in Step 2).

- [ ] **Step 2: The board component**

Create `src/soundboard/api.ts`:

```ts
// The Soundboard's backend: types of `soundboard_state` and the commands.
import { invoke } from "@tauri-apps/api/core";

export interface Category {
  id: string;
  name: string;
}

export interface Sound {
  id: string;
  name: string;
  file: string;
  /** A category id; "" = no category. */
  category: string;
  hotkey: string;
  volume: number;
  durationMs: number;
}

/** Device names; "" = automatic. */
export interface Devices {
  microphone: string;
  cable: string;
  headphones: string;
}

export interface Board {
  version: number;
  enabled: boolean;
  othersVolume: number;
  meVolume: number;
  layer: boolean;
  devices: Devices;
  stopHotkey: string;
  window: { poppedOut: boolean; alwaysOnTop: boolean };
  categories: Category[];
  sounds: Sound[];
}

export interface Problem {
  reason: "no_cable" | "no_device" | "not_connected" | "mic_is_cable" | "open_failed" | "lost";
  device: "microphone" | "cable" | "headphones";
  name: string;
  detail: string;
}

export type Status = { state: "off" } | { state: "on"; cable: string } | { state: "error"; problem: Problem };

export interface PlayingVoice {
  id: string;
  posMs: number;
  durationMs: number;
}

export interface BoardState {
  board: Board;
  status: Status;
  playing: PlayingVoice[];
  /** Sounds whose files were deleted by hand. */
  missing: string[];
  /** Sound ids, and "stopSounds", whose hotkey another program owns. */
  hotkeysTaken: string[];
}

export interface DeviceChoices {
  inputs: string[];
  outputs: string[];
  automatic: { microphone: string | null; cable: string | null; headphones: string | null };
}

export interface AddResult {
  path: string;
  name: string;
  id: string | null;
  error: string | null;
}

/** The formats "Add sounds…" offers. */
export const EXTENSIONS = ["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"];

export const api = {
  state: () => invoke<BoardState>("soundboard_state"),
  setEnabled: (enabled: boolean) => invoke<Status>("soundboard_set_enabled", { enabled }),
  devices: () => invoke<DeviceChoices>("soundboard_devices"),
  setDevices: (devices: Devices) => invoke<Status>("soundboard_set_devices", { devices }),
  setVolumes: (others: number, me: number) => invoke<void>("soundboard_set_volumes", { others, me }),
  setLayer: (layer: boolean) => invoke<void>("soundboard_set_layer", { layer }),
  add: (paths: string[]) => invoke<AddResult[]>("soundboard_add", { paths }),
  remove: (id: string) => invoke<void>("soundboard_remove", { id }),
  rename: (id: string, name: string) => invoke<void>("soundboard_rename", { id, name }),
  setCategory: (id: string, category: string) => invoke<void>("soundboard_set_category", { id, category }),
  setSoundVolume: (id: string, volume: number) => invoke<void>("soundboard_set_sound_volume", { id, volume }),
  setHotkey: (id: string, hotkey: string) => invoke<void>("soundboard_set_hotkey", { id, hotkey }),
  setStopHotkey: (hotkey: string) => invoke<void>("soundboard_set_stop_hotkey", { hotkey }),
  play: (id: string) => invoke<boolean>("soundboard_play", { id }),
  stopAll: () => invoke<void>("soundboard_stop_all"),
  categoryAdd: (name: string) => invoke<string>("soundboard_category_add", { name }),
  categoryRename: (id: string, name: string) => invoke<void>("soundboard_category_rename", { id, name }),
  categoryRemove: (id: string) => invoke<void>("soundboard_category_remove", { id }),
  popOut: (focus: boolean) => invoke<void>("soundboard_pop_out", { focus }),
  dock: () => invoke<void>("soundboard_dock"),
  setAlwaysOnTop: (on: boolean) => invoke<void>("soundboard_set_always_on_top", { on }),
};
```

Create `src/soundboard/board.ts`:

```ts
// The Soundboard: sounds on hotkeys, played into the virtual microphone.
// One component for the tab (index.html) and the pop-out window
// (soundboard.html). The library, playback and settings live in the
// backend; both views render from `soundboard_state` and follow its events.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { t } from "../i18n";
import { hotkeyLabel, startCapture } from "../hotkey-capture";
import {
  api,
  EXTENSIONS,
  type AddResult,
  type BoardState,
  type DeviceChoices,
  type Devices,
  type PlayingVoice,
  type Problem,
  type Sound,
  type Status,
} from "./api";

const CABLE_URL = "https://vb-audio.com/Cable/";
/** Set once the Discord hint was dismissed (a per-PC convenience). */
const HINT_KEY = "rudariflow-soundboard-hint-seen";

const PLAY_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 2.2v7.6L9.8 6z" fill="currentColor"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor"/></svg>';
const X_ICON =
  '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const PEN_ICON =
  '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 9.5l.6-2.3 5-5 1.7 1.7-5 5z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>';

export interface BoardOptions {
  /** The pop-out window: an Always on top switch instead of Pop out. */
  popOut: boolean;
}

export interface BoardView {
  /** Load the state again and redraw (also after a language change). */
  refresh(): Promise<void>;
  /** The tab is shown: files dropped on the window are added. */
  setActive(active: boolean): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className: string, text: string, key: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", className, text);
  b.type = "button";
  b.dataset.key = key;
  b.addEventListener("click", onClick);
  return b;
}

function iconButton(icon: string, label: string, key: string, onClick: () => void): HTMLButtonElement {
  const b = button("icon-btn", "", key, onClick);
  b.innerHTML = icon;
  b.title = label;
  b.setAttribute("aria-label", label);
  return b;
}

function option(value: string, label: string): HTMLOptionElement {
  const o = el("option", "", label);
  o.value = value;
  return o;
}

/** "0:02", "12:40". */
function clock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function problemText(p: Problem): string {
  return t(`sb_err_${p.reason}`)
    .replace("{device}", t(`sb_dev_${p.device}`))
    .replace("{name}", p.name)
    .replace("{detail}", p.detail);
}

function statusText(s: Status): string {
  if (s.state === "on") return t("sb_status_on").replace("{cable}", s.cable);
  if (s.state === "error") return problemText(s.problem);
  return t("sb_status_off");
}

/** A backend reason ("too_long", "disk: …") in words; unknown ones as they are. */
function reasonText(error: string): string {
  const [code, ...rest] = error.split(": ");
  const key = `sb_reason_${code}`;
  const text = t(key);
  return text === key ? error : text.replace("{detail}", rest.join(": "));
}

function hintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

function setHintSeen() {
  try {
    localStorage.setItem(HINT_KEY, "1");
  } catch {
    // The hint shows again next time.
  }
}

export function mountBoard(root: HTMLElement, options: BoardOptions): BoardView {
  let state: BoardState | null = null;
  let devices: DeviceChoices | null = null;
  let active = options.popOut;
  let query = "";
  /** The category chip that filters the list; "" = All. */
  let category = "";
  let devicesOpen = false;
  /** Rename fields and hotkey captures open: redraws wait until they close. */
  let editing = 0;
  let pending = false;
  let notice = { text: "", tone: "" };
  let armedDelete: string | null = null;
  let armedTimer: number | undefined;
  let listBox: HTMLElement | null = null;
  root.classList.add("sb");

  async function refresh() {
    state = await api.state();
    if (!devices) devices = await api.devices().catch(() => null);
    render();
  }

  function render() {
    if (editing > 0) {
      pending = true;
      return;
    }
    pending = false;
    if (!state) return;
    if (category && !state.board.categories.some((c) => c.id === category)) category = "";
    const focused = document.activeElement as HTMLElement | null;
    const focusKey = focused && root.contains(focused) ? focused.dataset.key : undefined;
    const caret = focused instanceof HTMLInputElement && focused.type === "text" ? focused.selectionStart : null;
    root.replaceChildren(...build(state));
    if (focusKey) {
      const again = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`);
      again?.focus();
      if (again instanceof HTMLInputElement && again.type === "text" && caret !== null) again.setSelectionRange(caret, caret);
    }
    showPlaying(state.playing);
  }

  function setNotice(text: string, tone = "") {
    notice = { text, tone };
    render();
  }

  function build(s: BoardState): HTMLElement[] {
    if (!options.popOut && s.board.window.poppedOut) return [popped()];
    listBox = el("div", "sb-list");
    fillList(listBox, s);
    const parts = [top(s), devicesBox(s), ...hints(s), toolbar(), chips(s)];
    if (notice.text) {
      const line = el("p", "sb-notice", notice.text);
      line.dataset.tone = notice.tone;
      line.setAttribute("role", "status");
      parts.push(line);
    }
    parts.push(listBox);
    return parts;
  }

  function row(label: string, hint: string, ...controls: HTMLElement[]): HTMLElement {
    const r = el("div", "setting-row");
    const l = el("div", "setting-label");
    l.append(el("span", "label-text", label));
    if (hint) l.append(el("span", "label-hint", hint));
    const c = el("div", "setting-control sb-control");
    c.append(...controls);
    r.append(l, c);
    return r;
  }

  function toggle(key: string, label: string, checked: boolean, onChange: (on: boolean, input: HTMLInputElement) => void): HTMLElement {
    const wrap = el("label", "switch");
    const input = el("input");
    input.type = "checkbox";
    input.checked = checked;
    input.dataset.key = key;
    input.setAttribute("aria-label", label);
    input.addEventListener("change", () => onChange(input.checked, input));
    wrap.append(input, el("span", "switch-slider"));
    return wrap;
  }

  function slider(key: string, label: string, value: number, onChange: (value: number) => void): HTMLElement {
    const wrap = el("div", "sb-slider");
    const input = el("input");
    input.type = "range";
    input.min = "0";
    input.max = "100";
    input.value = String(Math.round(value * 100));
    input.dataset.key = key;
    input.setAttribute("aria-label", label);
    const shown = el("span", "sb-slider-value", `${input.value} %`);
    input.addEventListener("input", () => (shown.textContent = `${input.value} %`));
    input.addEventListener("change", () => onChange(Number(input.value) / 100));
    wrap.append(input, shown);
    return wrap;
  }

  function hotkeyControl(key: string, current: string, taken: boolean, save: (combo: string) => Promise<unknown>): HTMLElement {
    const wrap = el("div", "hotkey-control sb-hotkey");
    const kbd = el("kbd", "", hotkeyLabel(current));
    const btn = button("hotkey-btn", "", key, () => {
      const started = startCapture({
        button: btn,
        text: kbd,
        allowBare: true,
        apply: async (combo) => {
          await save(combo);
          current = combo;
        },
        render: () => (kbd.textContent = hotkeyLabel(current)),
        done: () => {
          editing--;
          if (pending) render();
        },
      });
      if (started) editing++;
    });
    btn.append(kbd);
    btn.setAttribute("aria-label", `${t("sb_hotkey")}: ${hotkeyLabel(current)}`);
    wrap.append(btn);
    if (current) wrap.append(iconButton(X_ICON, t("paste_last_clear"), `${key}-clear`, () => void save("").catch(console.error)));
    if (taken) wrap.append(el("span", "sb-note", t("sb_hotkey_elsewhere")));
    return wrap;
  }

  function top(s: BoardState): HTMLElement {
    const b = s.board;
    const list = el("div", "settings-list sb-top");
    const onSwitch = toggle("enabled", t("sb_switch_label"), s.status.state === "on", async (wanted, input) => {
      input.disabled = true;
      try {
        const status = await api.setEnabled(wanted);
        if (state) state.status = status;
      } catch (e) {
        console.error("soundboard_set_enabled failed:", e);
      }
      render();
    });
    const switchRow = row(t("sb_switch_label"), t("sb_switch_hint"), onSwitch);
    const status = el("span", "label-hint sb-status", statusText(s.status));
    status.dataset.tone = s.status.state;
    switchRow.querySelector(".setting-label")?.append(status);
    list.append(
      switchRow,
      row(t("sb_others_label"), t("sb_others_hint"), slider("others", t("sb_others_label"), b.othersVolume, (v) => void api.setVolumes(v, b.meVolume).catch(console.error))),
      row(t("sb_me_label"), t("sb_me_hint"), slider("me", t("sb_me_label"), b.meVolume, (v) => void api.setVolumes(b.othersVolume, v).catch(console.error))),
      row(t("sb_layer_label"), t("sb_layer_hint"), toggle("layer", t("sb_layer_label"), b.layer, (on) => void api.setLayer(on).catch(console.error))),
      row(
        t("sb_stop_hotkey_label"),
        t("sb_stop_hotkey_hint"),
        hotkeyControl("stop-hotkey", b.stopHotkey, s.hotkeysTaken.includes("stopSounds"), (combo) => api.setStopHotkey(combo)),
      ),
    );
    if (options.popOut) {
      list.append(row(t("sb_always_on_top"), "", toggle("on-top", t("sb_always_on_top"), b.window.alwaysOnTop, (on) => void api.setAlwaysOnTop(on).catch(console.error))));
    }
    return list;
  }

  function devicesBox(s: BoardState): HTMLElement {
    const box = el("details", "sb-devices");
    box.open = devicesOpen;
    const summary = el("summary", "", t("sb_devices"));
    summary.dataset.key = "devices";
    box.append(summary);
    box.addEventListener("toggle", () => {
      // A redraw makes a new, already open element: not a user's toggle.
      if (box.open === devicesOpen) return;
      devicesOpen = box.open;
      if (devicesOpen) {
        api
          .devices()
          .then((d) => {
            devices = d;
            render();
          })
          .catch(console.error);
      }
    });
    const list = el("div", "settings-list");
    const pick = (kind: keyof Devices, label: string) => {
      const select = el("select");
      select.dataset.key = `device-${kind}`;
      select.setAttribute("aria-label", label);
      const saved = s.board.devices[kind];
      const names = (kind === "microphone" ? devices?.inputs : devices?.outputs) ?? [];
      const auto = devices?.automatic[kind];
      select.append(option("", auto ? t("sb_auto").replace("{name}", auto) : t("sb_auto_none")));
      for (const name of names) select.append(option(name, name));
      if (saved && !names.includes(saved)) select.append(option(saved, `${saved} (${t("mic_not_connected")})`));
      select.value = saved;
      select.addEventListener("change", () => {
        void api.setDevices({ ...s.board.devices, [kind]: select.value }).catch(console.error);
      });
      return row(label, "", select);
    };
    list.append(pick("microphone", t("sb_dev_microphone")), pick("cable", t("sb_dev_cable")), pick("headphones", t("sb_dev_headphones")));
    box.append(list);
    return box;
  }

  function hints(s: BoardState): HTMLElement[] {
    const noCable = devices !== null && !devices.automatic.cable && !s.board.devices.cable;
    const box = el("div", "sb-hint");
    if (noCable) {
      box.append(
        el("p", "", t("sb_cable_missing")),
        button("btn-secondary", t("sb_cable_link"), "cable-link", () => void openExternal(CABLE_URL).catch(console.error)),
        el("p", "", t("sb_discord_hint")),
      );
      return [box];
    }
    if (hintSeen()) return [];
    box.append(
      el("p", "", t("sb_discord_hint")),
      button("btn-ghost", t("sb_hint_dismiss"), "hint-dismiss", () => {
        setHintSeen();
        render();
      }),
    );
    return [box];
  }

  function toolbar(): HTMLElement {
    const bar = el("div", "sb-toolbar");
    const search = el("input", "sb-search");
    search.type = "text";
    search.value = query;
    search.placeholder = t("sb_search");
    search.dataset.key = "search";
    search.setAttribute("aria-label", t("sb_search"));
    search.addEventListener("input", () => {
      query = search.value;
      if (state && listBox) {
        fillList(listBox, state);
        showPlaying(state.playing);
      }
    });
    bar.append(
      button("btn-secondary", t("sb_add"), "add", () => void chooseFiles()),
      search,
      button("btn-secondary", t("sb_stop_all"), "stop-all", () => void api.stopAll().catch(console.error)),
    );
    if (!options.popOut) bar.append(button("btn-secondary", t("sb_pop_out"), "pop-out", () => void api.popOut(true).catch(console.error)));
    return bar;
  }

  function chips(s: BoardState): HTMLElement {
    const bar = el("div", "sb-chips");
    const chip = (label: string, id: string) => {
      const c = button("speaker-chip sb-chip", label, `chip-${id || "all"}`, () => {
        category = id;
        render();
      });
      c.setAttribute("aria-pressed", String(category === id));
      return c;
    };
    bar.append(chip(t("sb_all"), ""));
    for (const c of s.board.categories) {
      bar.append(chip(c.name, c.id));
      if (category === c.id) {
        const rename = iconButton(PEN_ICON, t("sb_category_rename"), `chip-${c.id}-rename`, () =>
          inlineEdit(rename, c.name, t("sb_category_placeholder"), (name) => api.categoryRename(c.id, name)),
        );
        const remove = iconButton(X_ICON, t("sb_category_delete"), `chip-${c.id}-delete`, () => {
          api.categoryRemove(c.id).catch((e) => setNotice(reasonText(String(e)), "error"));
        });
        bar.append(rename, remove);
      }
    }
    const add = button("speaker-chip sb-chip", t("sb_new_category"), "chip-new", () =>
      inlineEdit(add, "", t("sb_category_placeholder"), async (name) => {
        category = await api.categoryAdd(name);
      }),
    );
    bar.append(add);
    return bar;
  }

  /** Put a text field where `anchor` is; Enter or leaving it saves, Escape cancels. */
  function inlineEdit(anchor: HTMLElement, value: string, placeholder: string, commit: (value: string) => Promise<unknown>) {
    const input = el("input", "speaker-chip-input");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    input.setAttribute("aria-label", placeholder);
    // After the redraw, focus goes back to the control this field replaced.
    input.dataset.key = anchor.dataset.key ?? "";
    editing++;
    let over = false;
    const finish = async (save: boolean) => {
      if (over) return;
      over = true;
      const text = input.value.trim();
      if (save && text && text !== value) {
        try {
          await commit(text);
        } catch (e) {
          notice = { text: reasonText(String(e)), tone: "error" };
        }
      }
      editing--;
      render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void finish(true);
      else if (e.key === "Escape") void finish(false);
    });
    input.addEventListener("blur", () => void finish(true));
    anchor.replaceWith(input);
    input.focus();
    input.select();
  }

  function fillList(box: HTMLElement, s: BoardState) {
    box.replaceChildren();
    if (s.board.sounds.length === 0) {
      box.append(el("p", "empty-state", t("sb_empty")));
      return;
    }
    const q = query.trim().toLowerCase();
    const shown = s.board.sounds.filter((x) => (!category || x.category === category) && (!q || x.name.toLowerCase().includes(q)));
    if (shown.length === 0) box.append(el("p", "empty-state", t("sb_empty_filter")));
    for (const sound of shown) box.append(soundRow(sound, s));
  }

  function soundRow(sound: Sound, s: BoardState): HTMLElement {
    const on = s.status.state === "on";
    const missing = s.missing.includes(sound.id);
    const r = el("div", "sb-row");
    r.dataset.id = sound.id;
    r.dataset.name = sound.name;

    const play = button("sb-play", "", `${sound.id}-play`, () => {
      api.play(sound.id).catch((e) => setNotice(`${sound.name}: ${reasonText(String(e))}`, "error"));
    });
    play.innerHTML = PLAY_ICON;
    play.dataset.icon = "play";
    play.disabled = !on || missing;
    play.title = !on ? t("sb_play_off_hint") : missing ? t("sb_missing") : t("sb_play");
    play.setAttribute("aria-label", `${t("sb_play")}: ${sound.name}`);

    const main = el("div", "sb-main");
    const name = button("sb-name", sound.name, `${sound.id}-name`, () =>
      inlineEdit(name, sound.name, t("sb_rename_placeholder"), (v) => api.rename(sound.id, v)),
    );
    name.title = t("sb_rename_hint");
    const progress = el("div", "sb-progress");
    progress.append(el("div", "sb-progress-fill"));
    main.append(name, progress);
    if (missing) main.append(el("span", "sb-note", t("sb_missing")));

    const side = el("div", "sb-side");
    side.append(el("span", "sb-length", clock(sound.durationMs)), deleteButton(sound));

    const controls = el("div", "sb-controls");
    const cat = el("select", "sb-category");
    cat.dataset.key = `${sound.id}-category`;
    cat.setAttribute("aria-label", `${t("sb_category")}: ${sound.name}`);
    cat.append(option("", t("sb_no_category")), ...s.board.categories.map((c) => option(c.id, c.name)));
    cat.value = sound.category;
    cat.addEventListener("change", () => void api.setCategory(sound.id, cat.value).catch(console.error));
    controls.append(
      cat,
      hotkeyControl(`${sound.id}-hotkey`, sound.hotkey, s.hotkeysTaken.includes(sound.id), (combo) => api.setHotkey(sound.id, combo)),
      slider(`${sound.id}-volume`, `${t("sb_volume")}: ${sound.name}`, sound.volume, (v) => void api.setSoundVolume(sound.id, v).catch(console.error)),
    );
    r.append(play, main, side, controls);
    return r;
  }

  function deleteButton(sound: Sound): HTMLElement {
    const armed = armedDelete === sound.id;
    const label = t(armed ? "sb_delete_confirm" : "sb_delete");
    const b = button(`btn-ghost sb-delete${armed ? " armed" : ""}`, label, `${sound.id}-delete`, () => {
      window.clearTimeout(armedTimer);
      if (armedDelete !== sound.id) {
        armedDelete = sound.id;
        armedTimer = window.setTimeout(() => {
          armedDelete = null;
          render();
        }, 3000);
        render();
        return;
      }
      armedDelete = null;
      api.remove(sound.id).catch((e) => setNotice(`${sound.name}: ${reasonText(String(e))}`, "error"));
    });
    b.setAttribute("aria-label", `${label}: ${sound.name}`);
    return b;
  }

  function showPlaying(voices: PlayingVoice[]) {
    const byId = new Map(voices.map((v) => [v.id, v]));
    root.querySelectorAll<HTMLElement>(".sb-row").forEach((r) => {
      const voice = byId.get(r.dataset.id ?? "");
      r.classList.toggle("playing", voice !== undefined);
      const fill = r.querySelector<HTMLElement>(".sb-progress-fill");
      if (fill) fill.style.width = voice && voice.durationMs > 0 ? `${Math.min(100, (voice.posMs / voice.durationMs) * 100)}%` : "0%";
      const play = r.querySelector<HTMLButtonElement>(".sb-play");
      const icon = voice ? "stop" : "play";
      if (play && play.dataset.icon !== icon) {
        play.dataset.icon = icon;
        play.innerHTML = voice ? STOP_ICON : PLAY_ICON;
        play.setAttribute("aria-label", `${t(voice ? "sb_stop" : "sb_play")}: ${r.dataset.name ?? ""}`);
      }
    });
  }

  async function chooseFiles() {
    const picked = await open({ multiple: true, directory: false, filters: [{ name: t("sb_filter_name"), extensions: EXTENSIONS }] });
    if (!picked) return;
    await addPaths(Array.isArray(picked) ? picked : [picked]);
  }

  async function addPaths(paths: string[]) {
    if (paths.length === 0) return;
    setNotice(paths.length === 1 ? t("sb_adding_one") : t("sb_adding").replace("{n}", String(paths.length)));
    let results: AddResult[];
    try {
      results = await api.add(paths);
    } catch (e) {
      setNotice(reasonText(String(e)), "error");
      return;
    }
    const failed = results.filter((r) => r.error);
    const added = results.length - failed.length;
    const lines: string[] = [];
    if (added > 0) lines.push(added === 1 ? t("sb_added_one") : t("sb_added").replace("{n}", String(added)));
    for (const f of failed) lines.push(`${f.name}: ${reasonText(f.error ?? "")}`);
    setNotice(lines.join("\n"), failed.length > 0 ? "error" : "ok");
  }

  function popped(): HTMLElement {
    const box = el("div", "sb-popped");
    box.append(el("p", "empty-state", t("sb_popped")), button("btn-secondary", t("sb_bring_back"), "dock", () => void api.dock().catch(console.error)));
    return box;
  }

  listen("soundboard-changed", () => void refresh().catch(console.error));
  listen<PlayingVoice[]>("soundboard-playing", (e) => {
    if (state) state.playing = e.payload;
    showPlaying(e.payload);
  });
  listen<Status>("soundboard-status", (e) => {
    if (!state) return;
    state.status = e.payload;
    render();
  });
  getCurrentWebview().onDragDropEvent((event) => {
    if (!active) return;
    const p = event.payload;
    if (p.type === "enter" || p.type === "over") root.classList.add("dragging");
    else if (p.type === "leave") root.classList.remove("dragging");
    else if (p.type === "drop") {
      root.classList.remove("dragging");
      void addPaths(p.paths);
    }
  });
  void refresh().catch(console.error);

  return {
    refresh,
    setActive(on: boolean) {
      active = on;
      if (on) void refresh().catch(console.error);
    },
  };
}
```

- [ ] **Step 3: The tab, drop routing, strings, styles, link permission**

`index.html`:
- In `#sidebar-nav`, after the Files `<a class="nav-item" data-section="files">…</a>`, add:

```html
          <a class="nav-item" data-section="soundboard">
            <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
              <path d="M10.5 6a2.8 2.8 0 010 4M12.3 4.3a5.2 5.2 0 010 7.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
            <span data-i18n="nav_soundboard">Soundboard</span>
          </a>
```

- After `</section>` of `#section-files` (just above `</main>`), add:

```html
        <section id="section-soundboard" class="content-section">
          <div class="section-header">
            <h2 class="section-title" data-i18n="sb_title">Soundboard</h2>
            <p class="section-desc" data-i18n="sb_desc">Play sounds into Discord or a game with a hotkey. Your friends hear your voice and the sounds through a virtual microphone.</p>
          </div>
          <div id="sb-root"></div>
        </section>
```

`src/files.ts`:
- In `interface FilesHost`, after `showSection(): void;` add:

```ts
  /** False while another tab takes files dropped on the window (the Soundboard). */
  acceptsDrops(): boolean;
```

- In `getCurrentWebview().onDragDropEvent((event) => {`, make the first statement:

```ts
    if (!host.acceptsDrops()) {
      drop.classList.remove("dragging");
      return;
    }
```

`src/main.ts`:
- After `const historyClear = document.getElementById("history-clear") as HTMLButtonElement;` add:

```ts
const soundboardSection = document.getElementById("section-soundboard")!;
// The Soundboard tab; the same component runs in the pop-out window.
const soundboard = mountBoard(document.getElementById("sb-root")!, { popOut: false });
```

- In `showSection`, add as its last line `soundboard.setActive(target === "soundboard");`.
- In `loadSettings`, after `renderFiles();` add `void soundboard.refresh();`.
- In the `uiLanguageSelect` change listener, after `renderFiles();` add `void soundboard.refresh();`.
- In `initFiles({ … })`, after `showSection: () => showSection("files"),` add:

```ts
  acceptsDrops: () => !soundboardSection.classList.contains("active"),
```

`src/i18n.ts`, in `en`, after `history_delete: "Delete",`:

```ts
  nav_soundboard: "Soundboard",
  sb_title: "Soundboard",
  sb_desc: "Play sounds into Discord or a game with a hotkey. Your friends hear your voice and the sounds through a virtual microphone.",
  sb_switch_label: "Virtual microphone",
  sb_switch_hint: "Sends your microphone and the sounds to the virtual cable. In your voice app, choose “CABLE Output” as the microphone.",
  sb_status_off: "Off. Nothing is recorded or played.",
  sb_status_on: "On: your mic + sounds → {cable}",
  sb_err_no_cable: "No virtual cable found. Install VB-Audio Virtual Cable, then turn this on again.",
  sb_err_no_device: "{device}: none found. Connect one or choose one under Devices.",
  sb_err_not_connected: "{device} “{name}” is not connected. Plug it in or choose another under Devices.",
  sb_err_mic_is_cable: "The microphone “{name}” is the virtual cable itself and would echo. Choose your real microphone under Devices.",
  sb_err_open_failed: "{device} “{name}” could not be opened: {detail}",
  sb_err_lost: "{device} “{name}” stopped working ({detail}). The virtual microphone is off.",
  sb_dev_microphone: "Microphone",
  sb_dev_cable: "Virtual cable",
  sb_dev_headphones: "Headphones",
  sb_others_label: "Others hear",
  sb_others_hint: "Volume of the sounds in the virtual microphone",
  sb_me_label: "You hear",
  sb_me_hint: "Volume of the sounds on your headphones",
  sb_layer_label: "Play sounds over each other",
  sb_layer_hint: "Off: a new sound replaces the one that is playing",
  sb_stop_hotkey_label: "Stop all sounds",
  sb_stop_hotkey_hint: "Hotkey that stops every sound. Works while the virtual microphone is on.",
  sb_always_on_top: "Always on top",
  sb_devices: "Devices",
  sb_auto: "Automatic ({name})",
  sb_auto_none: "Automatic (none found)",
  sb_add: "Add sounds…",
  sb_filter_name: "Audio files",
  sb_search: "Search sounds",
  sb_stop_all: "Stop all",
  sb_pop_out: "Pop out",
  sb_all: "All",
  sb_new_category: "+ New",
  sb_category: "Category",
  sb_category_placeholder: "Category name",
  sb_category_rename: "Rename category",
  sb_category_delete: "Delete category (its sounds stay)",
  sb_no_category: "No category",
  sb_play: "Play",
  sb_stop: "Stop",
  sb_play_off_hint: "Turn on the virtual microphone to play",
  sb_rename_hint: "Click to rename",
  sb_rename_placeholder: "Sound name",
  sb_volume: "Volume",
  sb_hotkey: "Hotkey",
  sb_delete: "Delete",
  sb_delete_confirm: "Click again to delete",
  sb_missing: "File missing",
  sb_hotkey_elsewhere: "Taken by another program",
  sb_empty: "No sounds yet. Add audio files with “Add sounds…” or drop them here: AAC, FLAC, M4A, MP3, OGG, OPUS, WAV, WMA.",
  sb_empty_filter: "No sound matches.",
  sb_cable_missing: "The soundboard plays into a virtual audio cable, which Discord or your game then uses as the microphone. Install the free VB-Audio Virtual Cable, restart the PC if the installer asks, then turn the virtual microphone on.",
  sb_cable_link: "Get VB-Audio Virtual Cable",
  sb_discord_hint: "In Discord, choose “CABLE Output (VB-Audio Virtual Cable)” as the input device (Settings → Voice & Video), and turn off Noise Suppression and Echo Cancellation there: they can cut sound effects and music.",
  sb_hint_dismiss: "Got it",
  sb_adding: "Adding {n} sounds…",
  sb_adding_one: "Adding the sound…",
  sb_added: "Added {n} sounds.",
  sb_added_one: "Added 1 sound.",
  sb_reason_unsupported: "this file type is not supported",
  sb_reason_too_long: "longer than 30 minutes",
  sb_reason_no_audio: "the file has no audio",
  sb_reason_unreadable: "the file could not be read",
  sb_reason_disk: "it could not be saved ({detail})",
  sb_reason_missing: "its file is missing",
  sb_reason_off: "turn on the virtual microphone first",
  sb_reason_no_sound: "the sound was deleted",
  sb_reason_exists: "a category with this name exists",
  sb_reason_empty_name: "the name is empty",
  sb_popped: "The soundboard is open in its own window.",
  sb_bring_back: "Bring back",
  hotkey_taken_by: "Already used by {name}",
  hotkey_owner_dictation: "Dictation",
  quoted: "“{name}”",
```

and in `de`, after `history_delete: "Löschen",`:

```ts
  nav_soundboard: "Soundboard",
  sb_title: "Soundboard",
  sb_desc: "Spiele Sounds per Tastenkürzel in Discord oder ein Spiel. Deine Freunde hören deine Stimme und die Sounds über ein virtuelles Mikrofon.",
  sb_switch_label: "Virtuelles Mikrofon",
  sb_switch_hint: "Schickt dein Mikrofon und die Sounds in das virtuelle Kabel. Wähle in deiner Sprach-App „CABLE Output“ als Mikrofon.",
  sb_status_off: "Aus. Es wird nichts aufgenommen oder abgespielt.",
  sb_status_on: "Ein: dein Mikrofon + Sounds → {cable}",
  sb_err_no_cable: "Kein virtuelles Kabel gefunden. Installiere VB-Audio Virtual Cable und schalte dann wieder ein.",
  sb_err_no_device: "{device}: keines gefunden. Schließe eines an oder wähle eines unter Geräte.",
  sb_err_not_connected: "{device} „{name}“ ist nicht verbunden. Schließe es an oder wähle unter Geräte ein anderes.",
  sb_err_mic_is_cable: "Das Mikrofon „{name}“ ist das virtuelle Kabel selbst und würde hallen. Wähle unter Geräte dein echtes Mikrofon.",
  sb_err_open_failed: "{device} „{name}“ ließ sich nicht öffnen: {detail}",
  sb_err_lost: "{device} „{name}“ funktioniert nicht mehr ({detail}). Das virtuelle Mikrofon ist aus.",
  sb_dev_microphone: "Mikrofon",
  sb_dev_cable: "Virtuelles Kabel",
  sb_dev_headphones: "Kopfhörer",
  sb_others_label: "Andere hören",
  sb_others_hint: "Lautstärke der Sounds im virtuellen Mikrofon",
  sb_me_label: "Du hörst",
  sb_me_hint: "Lautstärke der Sounds in deinen Kopfhörern",
  sb_layer_label: "Sounds übereinander abspielen",
  sb_layer_hint: "Aus: Ein neuer Sound ersetzt den, der gerade läuft",
  sb_stop_hotkey_label: "Alle Sounds stoppen",
  sb_stop_hotkey_hint: "Tastenkürzel, das jeden Sound stoppt. Wirkt, solange das virtuelle Mikrofon an ist.",
  sb_always_on_top: "Immer im Vordergrund",
  sb_devices: "Geräte",
  sb_auto: "Automatisch ({name})",
  sb_auto_none: "Automatisch (keines gefunden)",
  sb_add: "Sounds hinzufügen…",
  sb_filter_name: "Audiodateien",
  sb_search: "Sounds suchen",
  sb_stop_all: "Alle stoppen",
  sb_pop_out: "Eigenes Fenster",
  sb_all: "Alle",
  sb_new_category: "+ Neu",
  sb_category: "Kategorie",
  sb_category_placeholder: "Name der Kategorie",
  sb_category_rename: "Kategorie umbenennen",
  sb_category_delete: "Kategorie löschen (ihre Sounds bleiben)",
  sb_no_category: "Keine Kategorie",
  sb_play: "Abspielen",
  sb_stop: "Stoppen",
  sb_play_off_hint: "Schalte das virtuelle Mikrofon ein, um abzuspielen",
  sb_rename_hint: "Klicken zum Umbenennen",
  sb_rename_placeholder: "Name des Sounds",
  sb_volume: "Lautstärke",
  sb_hotkey: "Tastenkürzel",
  sb_delete: "Löschen",
  sb_delete_confirm: "Nochmals klicken zum Löschen",
  sb_missing: "Datei fehlt",
  sb_hotkey_elsewhere: "Von einem anderen Programm belegt",
  sb_empty: "Noch keine Sounds. Füge Audiodateien mit „Sounds hinzufügen…“ hinzu oder ziehe sie hierher: AAC, FLAC, M4A, MP3, OGG, OPUS, WAV, WMA.",
  sb_empty_filter: "Kein Sound passt.",
  sb_cable_missing: "Das Soundboard spielt in ein virtuelles Audiokabel, das Discord oder dein Spiel dann als Mikrofon nutzt. Installiere das kostenlose VB-Audio Virtual Cable, starte den PC neu, wenn das Installationsprogramm danach fragt, und schalte dann das virtuelle Mikrofon ein.",
  sb_cable_link: "VB-Audio Virtual Cable holen",
  sb_discord_hint: "Wähle in Discord „CABLE Output (VB-Audio Virtual Cable)“ als Eingabegerät (Einstellungen → Sprache & Video) und schalte dort Rauschunterdrückung und Echounterdrückung aus: Sie können Soundeffekte und Musik abschneiden.",
  sb_hint_dismiss: "Verstanden",
  sb_adding: "{n} Sounds werden hinzugefügt…",
  sb_adding_one: "Sound wird hinzugefügt…",
  sb_added: "{n} Sounds hinzugefügt.",
  sb_added_one: "1 Sound hinzugefügt.",
  sb_reason_unsupported: "dieser Dateityp wird nicht unterstützt",
  sb_reason_too_long: "länger als 30 Minuten",
  sb_reason_no_audio: "die Datei enthält kein Audio",
  sb_reason_unreadable: "die Datei ließ sich nicht lesen",
  sb_reason_disk: "sie ließ sich nicht speichern ({detail})",
  sb_reason_missing: "ihre Datei fehlt",
  sb_reason_off: "schalte zuerst das virtuelle Mikrofon ein",
  sb_reason_no_sound: "der Sound wurde gelöscht",
  sb_reason_exists: "eine Kategorie mit diesem Namen gibt es schon",
  sb_reason_empty_name: "der Name ist leer",
  sb_popped: "Das Soundboard ist in einem eigenen Fenster offen.",
  sb_bring_back: "Zurückholen",
  hotkey_taken_by: "Schon belegt von {name}",
  hotkey_owner_dictation: "Diktat",
  quoted: "„{name}“",
```

`src/style.css`, at the end:

```css
/* ── Soundboard ─────────────────────────────────────── */

.sb {
  display: flex;
  flex-direction: column;
  gap: 16px;
  border-radius: var(--radius-lg);
  outline: 1px dashed transparent;
  outline-offset: 6px;
  transition: outline-color var(--transition);
}
.sb.dragging {
  outline-color: var(--accent);
}
.sb-control {
  align-items: center;
  gap: 8px;
}
.sb-status {
  margin-top: 6px;
}
.sb-status[data-tone="on"] { color: var(--green); }
.sb-status[data-tone="error"] { color: var(--red); }
.sb-slider {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.sb-slider input[type="range"] {
  width: 140px;
}
.sb-slider-value {
  min-width: 40px;
  text-align: right;
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.sb-devices {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 10px 14px;
}
.sb-devices > summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.sb-devices > summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.sb-devices[open] > summary {
  margin-bottom: 14px;
}
.sb-hint {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  background: var(--accent-subtle);
  color: var(--text);
  font-size: 12px;
  line-height: 1.5;
}
.sb-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.sb-toolbar .sb-search {
  flex: 1;
  min-width: 140px;
  max-width: none;
}
.sb-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.sb-chip[aria-pressed="true"] {
  border-color: var(--accent);
  background: var(--accent-subtle);
}
.sb-chip:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.sb-notice {
  font-size: 12px;
  white-space: pre-line;
  color: var(--text-secondary);
}
.sb-notice[data-tone="ok"] { color: var(--green); }
.sb-notice[data-tone="error"] { color: var(--red); }
.sb-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 24px;
}
.sb-row {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  grid-template-areas:
    "play main side"
    ". controls controls";
  align-items: center;
  gap: 6px 12px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-lg);
  background: var(--surface);
}
.sb-row.playing {
  border-color: var(--accent);
  background: var(--accent-subtle);
}
.sb-play {
  grid-area: play;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  background: var(--surface-hover);
  color: var(--text);
  cursor: pointer;
  transition: border-color var(--transition);
}
.sb-play svg {
  width: 12px;
  height: 12px;
}
.sb-play:hover:not(:disabled) {
  border-color: var(--accent);
}
.sb-play:disabled {
  opacity: 0.4;
  cursor: default;
}
.sb-main {
  grid-area: main;
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.sb-name {
  align-self: flex-start;
  max-width: 100%;
  padding: 0;
  border: none;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  text-align: left;
  cursor: text;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-play:focus-visible,
.sb-name:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.sb-progress {
  height: 3px;
  border-radius: 2px;
  background: var(--border);
  overflow: hidden;
}
.sb-progress-fill {
  width: 0;
  height: 100%;
  background: var(--accent);
  transition: width 100ms linear;
}
.sb-side {
  grid-area: side;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sb-length {
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.sb-delete.armed {
  color: var(--red);
}
.sb-controls {
  grid-area: controls;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.sb-controls select {
  width: auto;
  min-width: 140px;
  padding-top: 4px;
  padding-bottom: 4px;
  font-size: 12px;
}
.sb-controls .sb-slider input[type="range"] {
  width: 110px;
}
.sb-note {
  font-size: 11px;
  color: var(--yellow);
}
.sb-popped {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
@media (prefers-reduced-motion: reduce) {
  .sb,
  .sb-play,
  .sb-progress-fill {
    transition: none;
  }
}
```

`src-tauri/capabilities/default.json`: replace the `shell:allow-open` entry with:

```json
    {
      "identifier": "shell:allow-open",
      "allow": [{ "url": "https://0ggi.ch" }, { "url": "https://vb-audio.com/Cable/" }]
    }
```

Run (repo root): `npx tsc --noEmit`. Expected: no errors.

- [ ] **Step 4: Live check over CDP**

Build the app (the frontend is embedded), check the headroom, give the test instance a fresh board (`Remove-Item -Recurse -Force C:\t\rf-test-data\soundboard -ErrorAction SilentlyContinue`) and start it. Its UI language is German. You need `$S/corrupt.mp3` from Task 7 (make it again with `head -c 4096 /dev/urandom > "$S/corrupt.mp3"` if the scratch folder is new). Write these files to `$S`, replacing `SCRATCH` with `$S`, and run each with `node E:/claude/RudariFlow/.superpowers/tools/cdp.mjs $S/<file>.js`:

`ui_open.js`:
```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
document.querySelector('[data-section="soundboard"]').click();
await sleep(800);
const root = document.getElementById("sb-root");
return JSON.stringify({
  nav: document.querySelector('[data-section="soundboard"]').textContent.trim(),
  active: document.getElementById("section-soundboard").classList.contains("active"),
  switchOn: root.querySelector('[data-key="enabled"]').checked,
  status: root.querySelector(".sb-status").textContent,
  rows: root.querySelectorAll(".sb-row").length,
  empty: root.querySelector(".sb-list .empty-state")?.textContent ?? null,
  hint: root.querySelector(".sb-hint")?.textContent.slice(0, 40) ?? null,
  nativeControls: [...root.querySelectorAll("[data-key]")].every((e) => ["BUTTON", "INPUT", "SELECT", "SUMMARY"].includes(e.tagName)),
});
```

`ui_drop.js`:
```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const F = "E:/claude/RudariFlow/src-tauri/tests/fixtures/soundboard";
const paths = [`${F}/tone.wav`, `${F}/tone.mp3`, "SCRATCH/corrupt.mp3"];
const root = document.getElementById("sb-root");
const settled = () => ["ok", "error"].includes(root.querySelector(".sb-notice")?.dataset.tone ?? "");
await window.__TAURI__.event.emit("tauri://drag-drop", { paths, position: { x: 300, y: 300 } });
for (let n = 0; n < 50 && !settled(); n++) await sleep(200);
let via = "emit";
if (!settled()) {
  // As in drop_file.js: call each registered callback with a drop until one adds the files.
  via = "callbacks";
  const ti = window.__TAURI_INTERNALS__;
  for (const id of [...ti.callbacks.keys()]) {
    try {
      ti.callbacks.get(id)({ event: "tauri://drag-drop", id: 0, payload: { paths, position: { x: 300, y: 300 } } });
    } catch (e) {
      continue;
    }
    for (let n = 0; n < 15 && !settled(); n++) await sleep(200);
    if (settled()) break;
  }
}
await sleep(500);
return JSON.stringify({
  via,
  rows: [...root.querySelectorAll(".sb-row")].map((r) => r.dataset.name),
  notice: root.querySelector(".sb-notice")?.textContent,
  filesTabUntouched: document.getElementById("file-job").classList.contains("hidden"),
});
```

`ui_edit.js`:
```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const i = window.__TAURI_INTERNALS__.invoke;
const root = document.getElementById("sb-root");
const typeInto = async (input, text) => {
  input.value = text;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await sleep(600);
};
root.querySelector(".sb-row .sb-name").click();
await sleep(100);
await typeInto(root.querySelector(".sb-row .speaker-chip-input"), "airhorn");
root.querySelector('[data-key="chip-new"]').click();
await sleep(100);
await typeInto(root.querySelector(".sb-chips .speaker-chip-input"), "Memes");
let st = await i("soundboard_state");
const memes = st.board.categories.find((c) => c.name === "Memes").id;
const air = st.board.sounds.find((s) => s.name === "airhorn").id;
root.querySelector('[data-key="chip-all"]').click();
await sleep(200);
const select = root.querySelector(`[data-key="${air}-category"]`);
select.value = memes;
select.dispatchEvent(new Event("change"));
await sleep(600);
root.querySelector(`[data-key="chip-${memes}"]`).click();
await sleep(200);
const inMemes = [...root.querySelectorAll(".sb-row")].map((r) => r.dataset.name);
root.querySelector(`[data-key="chip-${memes}-rename"]`).click();
await sleep(100);
await typeInto(root.querySelector(".sb-chips .speaker-chip-input"), "Funny");
const renamed = (await i("soundboard_state")).board.categories.map((c) => c.name);
root.querySelector('[data-key="chip-all"]').click();
await sleep(200);
const search = root.querySelector('[data-key="search"]');
search.value = "air";
search.dispatchEvent(new Event("input"));
await sleep(100);
const searched = [...root.querySelectorAll(".sb-row")].map((r) => r.dataset.name);
search.value = "";
search.dispatchEvent(new Event("input"));
root.querySelector(`[data-key="chip-${memes}"]`).click();
await sleep(200);
root.querySelector(`[data-key="chip-${memes}-delete"]`).click();
await sleep(600);
st = await i("soundboard_state");
return JSON.stringify({
  names: st.board.sounds.map((s) => s.name).sort(),
  inMemes,
  renamed,
  searched,
  categoriesAfterDelete: st.board.categories.length,
  airCategoryAfterDelete: st.board.sounds.find((s) => s.id === air).category,
  chipAllPressed: root.querySelector('[data-key="chip-all"]').getAttribute("aria-pressed"),
});
```

`ui_hotkey.js`:
```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const i = window.__TAURI_INTERNALS__.invoke;
const root = document.getElementById("sb-root");
let st = await i("soundboard_state");
const air = st.board.sounds.find((s) => s.name === "airhorn").id;
const tone = st.board.sounds.find((s) => s.name === "tone").id;
const press = async (key, code, mods = {}) => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...mods }));
  await sleep(700);
};
root.querySelector(`[data-key="${air}-hotkey"]`).click();
await sleep(200);
await press("F13", "F13");
const airShown = root.querySelector(`[data-key="${air}-hotkey"] kbd`).textContent;
root.querySelector(`[data-key="${tone}-hotkey"]`).click();
await sleep(200);
await press("F13", "F13");
const refused = root.querySelector(`[data-key="${tone}-hotkey"] kbd`).textContent;
await sleep(2600);
root.querySelector(`[data-key="${tone}-hotkey"]`).click();
await sleep(200);
await press(" ", "Space", { ctrlKey: true, shiftKey: true });
const dictation = root.querySelector(`[data-key="${tone}-hotkey"] kbd`).textContent;
await sleep(2600);
root.querySelector('[data-key="stop-hotkey"]').click();
await sleep(200);
await press("1", "Numpad1");
st = await i("soundboard_state");
const settings = await i("get_settings");
return JSON.stringify({ airShown, refused, dictation, dictationHotkey: settings.hotkey, saved: st.board.sounds.find((x) => x.id === air).hotkey, stop: st.board.stopHotkey });
```

`ui_play.js`:
```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const i = window.__TAURI_INTERNALS__.invoke;
const root = document.getElementById("sb-root");
// Never the speakers.
await i("soundboard_set_devices", { devices: { microphone: "", cable: "", headphones: "CABLE In 16 Ch (VB-Audio Virtual Cable)" } });
await sleep(300);
root.querySelector('[data-key="enabled"]').click();
for (let n = 0; n < 40 && (await i("soundboard_state")).status.state !== "on"; n++) await sleep(250);
await sleep(300);
const status = root.querySelector(".sb-status").textContent;
const air = (await i("soundboard_state")).board.sounds.find((s) => s.name === "airhorn").id;
const playButton = () => root.querySelector(`[data-key="${air}-play"]`);
const row = () => root.querySelector(`.sb-row[data-id="${air}"]`);
const enabled = !playButton().disabled;
playButton().click();
await sleep(300);
const playing = row().classList.contains("playing");
const label = playButton().getAttribute("aria-label");
playButton().click();
await sleep(400);
const stopped = !row().classList.contains("playing");
root.querySelector('[data-key="enabled"]').click();
for (let n = 0; n < 20 && (await i("soundboard_state")).status.state === "on"; n++) await sleep(250);
await sleep(300);
return JSON.stringify({ status, enabled, playing, label, stopped, offStatus: root.querySelector(".sb-status").textContent, disabledAfter: playButton().disabled });
```

`ui_rest.js`:
```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const i = window.__TAURI_INTERNALS__.invoke;
const root = document.getElementById("sb-root");
let st = await i("soundboard_state");
const air = st.board.sounds.find((s) => s.name === "airhorn").id;
const tone = st.board.sounds.find((s) => s.name === "tone").id;
const volume = root.querySelector(`[data-key="${air}-volume"]`);
volume.value = "40";
volume.dispatchEvent(new Event("change"));
await sleep(500);
root.querySelector('[data-key="layer"]').click();
await sleep(500);
root.querySelector(`[data-key="${tone}-delete"]`).click();
await sleep(150);
const armedText = root.querySelector(`[data-key="${tone}-delete"]`).textContent;
root.querySelector(`[data-key="${tone}-delete"]`).click();
await sleep(700);
root.querySelector('[data-key="hint-dismiss"]')?.click();
await sleep(200);
document.querySelector('[data-section="general"]').click();
document.querySelector('[data-section="soundboard"]').click();
await sleep(600);
const hintGone = !root.querySelector(".sb-hint");
const lang = document.getElementById("ui-language-select");
lang.value = "en";
lang.dispatchEvent(new Event("change"));
await sleep(900);
const english = root.querySelector(".sb-status").textContent;
lang.value = "de";
lang.dispatchEvent(new Event("change"));
await sleep(600);
st = await i("soundboard_state");
return JSON.stringify({
  volume: st.board.sounds.find((s) => s.id === air).volume,
  layer: st.board.layer,
  armedText,
  left: st.board.sounds.map((s) => s.name),
  tone,
  hintGone,
  english,
});
```

`ui_recording_hotkey.js` (the Recording tab still captures through the shared module):
```js
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const i = window.__TAURI_INTERNALS__.invoke;
document.querySelector('[data-section="recording"]').click();
$("free-gpu-btn").click();
await sleep(200);
window.dispatchEvent(new KeyboardEvent("keydown", { key: "F9", code: "F9", ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
await sleep(800);
const shown = $("free-gpu-text").textContent;
const saved = (await i("get_settings")).freeGpuHotkey;
$("free-gpu-btn").click();
await sleep(200);
window.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", code: "F10", bubbles: true, cancelable: true }));
await sleep(400);
const bareIgnored = $("free-gpu-text").textContent;
window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
await sleep(300);
$("free-gpu-clear").click();
await sleep(500);
return JSON.stringify({ shown, saved, bareIgnored, cleared: (await i("get_settings")).freeGpuHotkey });
```

Run in this order and expect:
1. `ui_open.js`: `nav: "Soundboard"`, `active: true`, `switchOn: false`, `status: "Aus. Es wird nichts aufgenommen oder abgespielt."`, `rows: 0`, `empty` starts with `Noch keine Sounds.`, `hint` starts with `Wähle in Discord „CABLE Output`, `nativeControls: true`.
2. `ui_drop.js`: `rows: ["tone","tone"]`; `notice` is `2 Sounds hinzugefügt.` plus a line `corrupt: die Datei ließ sich nicht lesen` (or `corrupt: die Datei enthält kein Audio`); `filesTabUntouched: true`. Record `via`.
3. `ui_edit.js`: `names: ["airhorn","tone"]`, `inMemes: ["airhorn"]`, `renamed: ["Funny"]`, `searched: ["airhorn"]`, `categoriesAfterDelete: 0`, `airCategoryAfterDelete: ""`, `chipAllPressed: "true"`.
4. `ui_hotkey.js`: `airShown: "F13"`; `refused: "Schon belegt von „airhorn“"`; `dictation: "Schon belegt von Diktat"` (`dictationHotkey` is the test config's `CmdOrCtrl+Shift+Space`; if it is another chord, press that chord in this step instead); `saved: "F13"`, `stop: "Numpad1"`.
5. `ui_play.js`: `status: "Ein: dein Mikrofon + Sounds → Speakers (VB-Audio Virtual Cable)"`, `enabled: true`, `playing: true`, `label: "Stoppen: airhorn"`, `stopped: true`, `offStatus: "Aus. Es wird nichts aufgenommen oder abgespielt."`, `disabledAfter: true`.
6. `ui_rest.js`: `volume: 0.4`, `layer: true`, `armedText: "Nochmals klicken zum Löschen"`, `left: ["airhorn"]`, `hintGone: true`, `english: "Off. Nothing is recorded or played."`. In PowerShell, `Test-Path C:\t\rf-test-data\soundboard\cache\<tone>.wav` is `False`.
7. `ui_recording_hotkey.js`: `shown: "Ctrl+Alt+Shift+F9"`, `saved: "CmdOrCtrl+Alt+Shift+F9"`, `bareIgnored: "Tastenkombination oder Maus-Seitentaste drücken…"`, `cleared: ""`.

Stop the test instance.

- [ ] **Step 5: Commit**

```bash
cd /e/claude/RudariFlow
git add src/hotkey-capture.ts src/soundboard/api.ts src/soundboard/board.ts src/main.ts src/files.ts index.html src/i18n.ts src/style.css src-tauri/capabilities/default.json
git commit -F - <<'EOF'
feat: Soundboard tab with sounds, categories, search, hotkeys and devices

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---
### Task 9: The pop-out window

**Files:**
- Create: `soundboard.html`, `src/soundboard/page.ts`
- Modify: `vite.config.ts`, `src-tauri/capabilities/default.json`, `src-tauri/src/main.rs`, `src/style.css`
- Test: `npx tsc --noEmit`, `cargo check`; live: test instance over CDP

**Interfaces:**
- Consumes: `mountBoard(root, { popOut: true })` and `api.{popOut, dock, setAlwaysOnTop}` (Task 8); `Soundboard::set_window`, `Soundboard::board` (Task 6).
- Produces:
  - commands `soundboard_pop_out(focus: bool)`, `soundboard_dock()`, `soundboard_set_always_on_top(on: bool)`
  - window label `soundboard`, page `soundboard.html` (document title `Soundboard`, window title `RudariFlow Soundboard`)
  - `fn window_state_flags() -> tauri_plugin_window_state::StateFlags` in main.rs; the window-state filter covers `main` and `soundboard`; the state file is written when the pop-out closes

- [ ] **Step 1: The page**

Create `soundboard.html` in the repo root:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Soundboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body class="sb-page">
    <main class="sb-page-main">
      <h1 class="section-title" data-i18n="sb_title">Soundboard</h1>
      <div id="sb-root"></div>
    </main>
    <script type="module" src="/src/soundboard/page.ts"></script>
  </body>
</html>
```

Create `src/soundboard/page.ts`:

```ts
// The Soundboard in its own window (label "soundboard"): the same board as
// the tab, with an Always on top switch. Closing the window brings the
// board back to its tab (main.rs).
import { invoke } from "@tauri-apps/api/core";
import { detectDefaultLang, setLang } from "../i18n";
import { mountBoard } from "./board";

async function start() {
  const settings = await invoke<{ uiLanguage: string }>("get_settings").catch(() => ({ uiLanguage: "" }));
  setLang(settings.uiLanguage || detectDefaultLang());
  mountBoard(document.getElementById("sb-root")!, { popOut: true });
}

void start();
```

In `vite.config.ts`, change the input map to:

```ts
      input: {
        main: "index.html",
        overlay: "src/overlay.html",
        soundboard: "soundboard.html",
      },
```

and the comment above `build:` to `// Multi-page: the overlay pill and the soundboard pop-out`.

In `src/style.css`, after the Soundboard block, add:

```css
/* The soundboard in its own window (soundboard.html). */
body.sb-page {
  overflow-y: auto;
}
.sb-page-main {
  max-width: 680px;
  margin: 0 auto;
  padding: 20px 20px 0;
}
.sb-page-main > .section-title {
  margin-bottom: 16px;
}
.sb-page .setting-row {
  gap: 16px;
}
.sb-page .setting-label {
  min-width: 0;
}
.sb-page .sb-slider input[type="range"] {
  width: 110px;
}
```

In `src-tauri/capabilities/default.json`, change `"windows": ["main", "overlay"]` to `"windows": ["main", "overlay", "soundboard"]`.

Run (repo root): `npx tsc --noEmit`. Expected: no errors.

- [ ] **Step 2: Open, dock, always on top, and the window state**

In `main.rs`:

1. Below `use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};` add `use tauri_plugin_window_state::AppHandleExt;`.

2. Above `fn main()` add:

```rust
/// Window state kept for the main window and the soundboard pop-out.
fn window_state_flags() -> tauri_plugin_window_state::StateFlags {
    tauri_plugin_window_state::StateFlags::SIZE
        | tauri_plugin_window_state::StateFlags::POSITION
        | tauri_plugin_window_state::StateFlags::MAXIMIZED
}
```

3. Replace the window-state plugin block in `main()` with:

```rust
        // Size, position and maximised state of the main window and the
        // soundboard pop-out, restored when they open (not the overlay pill
        // or the hidden PDF export windows). A saved position on no current
        // monitor is not restored; the window then opens centred.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(window_state_flags())
                .with_filter(|label| label == "main" || label == "soundboard")
                // The state file lives in the app's own data folder, so a
                // RUDARIFLOW_DATA_DIR build stays separate from the real one.
                .with_filename(get_app_dir().join(".window-state.json").to_string_lossy())
                .build(),
        )
```

4. After `soundboard_engine_stats` add:

```rust
/// Open the board in its own window (label "soundboard"), or bring that
/// window to the front. `focus` false leaves the focus where it is (the
/// live checks). Async: building a window in a sync command deadlocks on
/// Windows.
#[tauri::command]
async fn soundboard_pop_out(app: AppHandle, state: State<'_, AppState>, focus: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("soundboard") {
        let _ = window.show();
        let _ = window.unminimize();
        if focus {
            let _ = window.set_focus();
        }
    } else {
        let on_top = state.soundboard.board().window.always_on_top;
        WebviewWindowBuilder::new(&app, "soundboard", WebviewUrl::App("soundboard.html".into()))
            .title("RudariFlow Soundboard")
            .inner_size(460.0, 680.0)
            .min_inner_size(380.0, 420.0)
            .resizable(true)
            .always_on_top(on_top)
            .focused(focus)
            .build()
            .map_err(|e| e.to_string())?;
    }
    state.soundboard.set_window(Some(true), None);
    Ok(())
}

/// Close the pop-out window ("Bring back"); the board goes back to its tab.
#[tauri::command]
async fn soundboard_dock(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("soundboard") {
        window.close().map_err(|e| e.to_string())?;
    }
    state.soundboard.set_window(Some(false), None);
    Ok(())
}

/// The pop-out's Always on top switch, remembered for the next pop-out.
#[tauri::command]
async fn soundboard_set_always_on_top(app: AppHandle, state: State<'_, AppState>, on: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("soundboard") {
        window.set_always_on_top(on).map_err(|e| e.to_string())?;
    }
    state.soundboard.set_window(None, Some(on));
    Ok(())
}
```

and add them to `generate_handler![…]` after `soundboard_engine_stats,`:

```rust
            soundboard_pop_out,
            soundboard_dock,
            soundboard_set_always_on_top,
```

5. In `.on_window_event(|window, event| { … })`, after the `if window.label() == "main" { … }` block, add:

```rust
            // The pop-out closed (its X or Bring back): the board goes back
            // to its tab, and the window's size and position are saved now,
            // not only at a clean exit.
            if window.label() == "soundboard" {
                if let WindowEvent::Destroyed = event {
                    let app = window.app_handle();
                    app.state::<AppState>().soundboard.set_window(Some(false), None);
                    let _ = app.save_window_state(window_state_flags());
                }
            }
```

Run:

```bash
source /e/claude/RudariFlow/.superpowers/tools/env13.sh
cd /e/claude/RudariFlow/src-tauri && CARGO_TARGET_DIR='C:\t\rf-cpu' cargo check --no-default-features --bins
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --bins hotkey
```

Expected: no errors or warnings in `main.rs`; 5 passed.

- [ ] **Step 3: Live check**

Build the app. Before starting the test instance, give the pop-out a remembered size (PowerShell; `WriteAllText` writes UTF-8 without the BOM the plugin cannot read):

```powershell
$f = "C:\t\rf-test-data\.window-state.json"
$j = if (Test-Path $f) { Get-Content $f -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$sb = [pscustomobject]@{ width = 520; height = 760; x = 240; y = 160; prev_x = 240; prev_y = 160; maximized = $false; visible = $true; decorated = $true; fullscreen = $false }
$j | Add-Member -NotePropertyName soundboard -NotePropertyValue $sb -Force
[System.IO.File]::WriteAllText($f, ($j | ConvertTo-Json -Depth 5))
$before = (Get-Item $f).LastWriteTime
```

Check the headroom and start the test instance. Write these files to `$S`, replacing `SCRATCH` with `$S`. Run the main-window ones with `node E:/claude/RudariFlow/.superpowers/tools/cdp.mjs $S/<file>.js` and the pop-out ones with `node E:/claude/RudariFlow/.superpowers/tools/cdp.mjs $S/<file>.js Soundboard`.

`pop_open.js` (main):
```js
const i = window.__TAURI_INTERNALS__.invoke;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The board of Task 8's check has "airhorn"; make it if that board is gone.
const st = await i("soundboard_state");
if (!st.board.sounds.some((s) => s.name === "airhorn")) {
  const [added] = await i("soundboard_add", { paths: ["E:/claude/RudariFlow/src-tauri/tests/fixtures/soundboard/tone.wav"] });
  await i("soundboard_rename", { id: added.id, name: "airhorn" });
}
if (!st.board.sounds.some((s) => s.name === "tone8s")) await i("soundboard_add", { paths: ["SCRATCH/tone8s.wav"] });
document.querySelector('[data-section="soundboard"]').click();
await i("soundboard_pop_out", { focus: false });
await sleep(2000);
const root = document.getElementById("sb-root");
return JSON.stringify({
  tab: root.querySelector(".sb-popped")?.textContent ?? null,
  rowsInTab: root.querySelectorAll(".sb-row").length,
  poppedOut: (await i("soundboard_state")).board.window.poppedOut,
});
```

`pop_view.js` (pop-out):
```js
const root = document.getElementById("sb-root");
return JSON.stringify({
  title: document.title,
  heading: document.querySelector("h1").textContent,
  rows: [...root.querySelectorAll(".sb-row")].map((r) => r.dataset.name).sort(),
  onTopSwitch: !!root.querySelector('[data-key="on-top"]'),
  popOutButton: !!root.querySelector('[data-key="pop-out"]'),
  size: [Math.round(innerWidth * devicePixelRatio), Math.round(innerHeight * devicePixelRatio)],
});
```

`pop_edit.js` (pop-out):
```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = document.getElementById("sb-root");
root.querySelector('[data-key="on-top"]').click();
await sleep(500);
const onTop = await window.__TAURI__.window.getCurrentWindow().isAlwaysOnTop().catch((e) => "error: " + e);
const name = [...root.querySelectorAll(".sb-row")].find((r) => r.dataset.name === "airhorn").querySelector(".sb-name");
name.click();
await sleep(100);
const input = root.querySelector(".sb-row .speaker-chip-input");
input.value = "horn";
input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await sleep(600);
return JSON.stringify({ onTop, saved: (await window.__TAURI_INTERNALS__.invoke("soundboard_state")).board.window.alwaysOnTop });
```

`pop_play.js` (main):
```js
const i = window.__TAURI_INTERNALS__.invoke;
await i("soundboard_set_devices", { devices: { microphone: "", cable: "", headphones: "CABLE In 16 Ch (VB-Audio Virtual Cable)" } });
const status = await i("soundboard_set_enabled", { enabled: true });
const st = await i("soundboard_state");
await i("soundboard_play", { id: st.board.sounds.find((s) => s.name === "tone8s").id });
return JSON.stringify({ status: status.state });
```

`pop_playing.js` (pop-out):
```js
await new Promise((r) => setTimeout(r, 400));
return JSON.stringify({
  playing: [...document.querySelectorAll(".sb-row.playing")].map((r) => r.dataset.name),
  status: document.querySelector(".sb-status").textContent,
  names: [...document.querySelectorAll(".sb-row")].map((r) => r.dataset.name).sort(),
});
```

`pop_dock.js` (main):
```js
const i = window.__TAURI_INTERNALS__.invoke;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await i("soundboard_stop_all");
await i("soundboard_set_enabled", { enabled: false });
const root = document.getElementById("sb-root");
root.querySelector('[data-key="dock"]').click();
await sleep(1500);
return JSON.stringify({
  popped: !!root.querySelector(".sb-popped"),
  rows: [...root.querySelectorAll(".sb-row")].map((r) => r.dataset.name).sort(),
  poppedOut: (await i("soundboard_state")).board.window.poppedOut,
});
```

Run in this order and expect:
1. `pop_open.js`: `tab: "Das Soundboard ist in einem eigenen Fenster offen.Zurückholen"`, `rowsInTab: 0`, `poppedOut: true`. The new window did not take the focus.
2. `pop_view.js`: `title: "Soundboard"`, `heading: "Soundboard"`, `rows: ["airhorn","tone8s"]`, `onTopSwitch: true`, `popOutButton: false`, `size: [520, 760]` (±2: the remembered size).
3. `pop_edit.js`: `onTop: true` (or an `error:` text if the window API is not allowed: then `saved` alone is the evidence), `saved: true`.
4. `pop_play.js`: `status: "on"`; right after, `pop_playing.js`: `playing: ["tone8s"]`, `status` starts with `Ein: dein Mikrofon + Sounds →`, `names: ["horn","tone8s"]` (the rename from the pop-out).
5. `pop_dock.js`: `popped: false`, `rows: ["horn","tone8s"]`, `poppedOut: false`. In PowerShell: `(Invoke-RestMethod http://127.0.0.1:9333/json).title` no longer lists `Soundboard`; `(Get-Item $f).LastWriteTime -gt $before` is `True`; `(Get-Content $f -Raw | ConvertFrom-Json).soundboard.width` is `520`.

Stop the test instance.

- [ ] **Step 4: Commit**

```bash
cd /e/claude/RudariFlow
git add soundboard.html src/soundboard/page.ts vite.config.ts src/style.css src-tauri/capabilities/default.json src-tauri/src/main.rs
git commit -F - <<'EOF'
feat: Soundboard pops out into its own window that can stay on top

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 10: Docs and the final check

**Files:**
- Modify: `README.md`, `README.de.md`, `CHANGELOG.md`

(The version line at the top of the READMEs changes with the release, not here.)

- [ ] **Step 1: README.md**

- In Features, after the `- **Transcribe files** (Files tab): …` bullet, add:

```markdown
- **Soundboard** (Soundboard tab): sounds on hotkeys for Discord and games, like Soundpad. Turn on the virtual microphone and RudariFlow sends your microphone plus the sounds to the free [VB-Audio Virtual Cable](https://vb-audio.com/Cable/), which your voice app uses as its microphone ("CABLE Output"); you hear the sounds on your headphones at your own volume, never your own voice. Add AAC, FLAC, M4A, MP3, OGG, OPUS, WAV or WMA files by picker or drag and drop (up to 30 minutes each; RudariFlow keeps copies in its data folder), sort them into categories, search them, and give each a hotkey: a key (numpad and F-keys also alone), a combination or a mouse side button. A new sound replaces the playing one or plays over it, the same hotkey stops it, and a Stop all hotkey stops everything; sound hotkeys are taken from other apps only while the virtual microphone is on. The board can pop out into its own window that stays on top
```

- In the hotkeys bullet, replace `for all four hotkeys,` with `for all four hotkeys and the soundboard's,`.
- In Architecture, after `- **Export:** Word via docx-rs, PDF through WebView2's PrintToPdf`, add:

```markdown
- **Soundboard:** [cpal](https://github.com/RustAudio/cpal) on WASAPI in shared mode: the microphone in, the virtual cable and the headphones out, each in its own format; the microphone reaches the cable through a buffer that keeps its delay near 20 ms when the two clocks drift. Sounds are decoded once by Media Foundation (Ogg Opus by libopus) to 48 kHz WAV copies, which a reader thread per playing sound streams about a second ahead
```

- [ ] **Step 2: README.de.md**

- After the `- **Dateien transkribieren** (Tab Dateien): …` bullet, add:

```markdown
- **Soundboard** (Tab Soundboard): Sounds per Tastenkürzel für Discord und Spiele, wie Soundpad. Schalte das virtuelle Mikrofon ein, und RudariFlow schickt dein Mikrofon und die Sounds in das kostenlose [VB-Audio Virtual Cable](https://vb-audio.com/Cable/), das deine Sprach-App als Mikrofon nutzt („CABLE Output“); du hörst die Sounds in deinen Kopfhörern in deiner eigenen Lautstärke, nie deine eigene Stimme. Füge AAC-, FLAC-, M4A-, MP3-, OGG-, OPUS-, WAV- oder WMA-Dateien per Auswahl oder Ziehen hinzu (bis 30 Minuten je Sound; RudariFlow legt Kopien in seinem Datenordner ab), ordne sie in Kategorien, durchsuche sie und gib jedem ein Tastenkürzel: eine Taste (Ziffernblock und F-Tasten auch allein), eine Kombination oder eine Maus-Seitentaste. Ein neuer Sound ersetzt den laufenden oder spielt darüber, dasselbe Kürzel stoppt ihn, und ein Kürzel „Alle Sounds stoppen“ stoppt alles; die Kürzel der Sounds sind anderen Programmen nur entzogen, solange das virtuelle Mikrofon an ist. Das Soundboard lässt sich in ein eigenes Fenster lösen, das im Vordergrund bleiben kann
```

- Replace `für alle vier Hotkeys,` with `für alle vier Hotkeys und die des Soundboards,`.
- In Architektur, after `- **Export:** Word über docx-rs, PDF über WebView2s PrintToPdf`, add:

```markdown
- **Soundboard:** [cpal](https://github.com/RustAudio/cpal) über WASAPI im geteilten Modus: das Mikrofon hinein, das virtuelle Kabel und die Kopfhörer hinaus, jedes in seinem eigenen Format; das Mikrofon erreicht das Kabel über einen Puffer, der seine Verzögerung bei auseinanderlaufenden Takten um 20 ms hält. Sounds werden einmal von Media Foundation (Ogg Opus von libopus) in 48-kHz-WAV-Kopien umgewandelt, die ein Lese-Thread pro laufendem Sound etwa eine Sekunde im Voraus streamt
```

- [ ] **Step 3: CHANGELOG.md**

Under `## [Unreleased]` → `### Added` (it exists on this branch), after the `- **The AI model for other programs:** …` bullet, add:

```markdown
- **Soundboard** (new tab, can pop out into its own window): sounds on
  hotkeys for Discord and games, like Soundpad. Turn on "Virtual
  microphone" and RudariFlow sends your microphone plus the sounds to the
  free VB-Audio Virtual Cable, which your voice app uses as its microphone
  ("CABLE Output"); you hear the sounds on your headphones at your own
  volume, never your own voice. Add AAC, FLAC, M4A, MP3, OGG, OPUS, WAV or
  WMA files (up to 30 minutes each; copies are kept in RudariFlow's data
  folder), sort them into categories, search, and give each a hotkey: a
  key (the numpad and F-keys also alone), a combination or a mouse side
  button. A new sound replaces the playing one, or plays over it; the same
  hotkey stops it, and a Stop all hotkey stops everything. Sound hotkeys
  are taken from other apps only while the virtual microphone is on. The
  pop-out window can stay on top and remembers its size and position.
```

- [ ] **Step 4: Final check (filtered: no clipboard tests)**

```bash
source /e/claude/RudariFlow/.superpowers/tools/env13.sh
cd /e/claude/RudariFlow/src-tauri
for f in media:: soundboard:: mouse_hotkey:: mute:: settings:: audio::; do CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --lib "$f" || break; done
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo test --no-default-features --bins hotkey
CARGO_TARGET_DIR='C:\t\rf-cpu' cargo clippy --no-default-features --lib --bins --examples 2>&1 | grep -A4 -E "^(warning|error)" | grep -E "main.rs|soundboard|media.rs|mouse_hotkey.rs|mute.rs" || echo "no findings in the changed files"
cd .. && npx tsc --noEmit
git diff --ignore-cr-at-eol --stat src-tauri/Cargo.toml
git status --short
```

Expected: every filtered run passes; clippy has no finding in the changed files (a finding in lines older than this plan stays); tsc is clean; the Cargo.toml diff is empty (else `git checkout -- src-tauri/Cargo.toml`); `git status` shows only the three docs files.

- [ ] **Step 5: Commit**

```bash
cd /e/claude/RudariFlow
git add README.md README.de.md CHANGELOG.md
git commit -F - <<'EOF'
docs: the soundboard in the READMEs and the changelog

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

Hand-off to the controller: the spec's last test, a real Discord call with the user (CABLE Output as Discord's input, noise suppression off), is for the user, after this plan.

---

## Live checks (test instance)

These checks use the isolated instance (`.superpowers/tools/live-checks.md`). It never touches the user's data or the installed app.

- **Scratch folder `$S`:** your session's scratchpad directory (forward slashes in JS). It holds the JS files, `tone8s.wav`, `beep8s.wav` and `corrupt.mp3` (Tasks 5 and 7).
- **Build:** `source /e/claude/RudariFlow/.superpowers/tools/env13.sh && cd /e/claude/RudariFlow && CARGO_TARGET_DIR='C:\r' npm run tauri build -- --no-bundle` (foreground, 600000 ms), then restore `src-tauri/Cargo.toml` if only its line endings changed. Plain `cargo build` is not enough: the exe would load the dev server.
- **Headroom first (PowerShell):** `nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader`. The test instance loads Whisper and the AI model (about 5.5 GB). If less than 6.5 GB of the 16 GB is free, do not start it; tell the controller.
- **Start:** `powershell -ExecutionPolicy Bypass -File E:\claude\RudariFlow\.superpowers\tools\start_test.ps1`. It stops only `C:\r\` instances, sets `RUDARIFLOW_DATA_DIR=C:\t\rf-test-data`, `RUDARIFLOW_TEST_COMMANDS=1` and CDP on port 9333, and waits for "llama-server ready". Keep `autostart: true` in `C:\t\rf-test-data\config.json`. The test board lives in `C:\t\rf-test-data\soundboard\`.
- **Drive:** `node E:/claude/RudariFlow/.superpowers/tools/cdp.mjs $S/<file>.js` for the main window (page title "RudariFlow"); add a last argument `Soundboard` for the pop-out (page title "Soundboard"). The file is the body of an async function that `return`s a string.
- **Audio safety:** every check that turns the virtual microphone on first sets `headphones` to `CABLE In 16 Ch (VB-Audio Virtual Cable)`, so nothing plays on the user's speakers. If turning on reports `mic_is_cable`, Windows' default recording device is the cable: add `microphone: "Microphone (Scarlett Solo USB)"` to the `soundboard_set_devices` calls. The microphone (the Recording setting's, the user's Scarlett Solo) is captured in shared mode while the board is on; Windows shows its microphone icon.
- **Logs:** `C:\t\rf-test-data\startup.log` (`[soundboard]`, `[hotkey]`, `[check]` lines; `diag_log` writes the `[check]` markers).
- **Stop, right after each check:**

```powershell
Get-Process rudariflow -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "C:\r\*" } | Stop-Process -Force
Get-Process llama-server -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "E:\claude\RudariFlow\src-tauri\binaries\llama\*" } | Stop-Process -Force
```

- **Not driven:**
  - Real key presses: the registered F13/F14/Numpad1 hotkeys are checked through the log and the commands they call (`soundboard_play`, `soundboard_stop_all`); pressing them would need system key input.
  - The native file dialog behind "Add sounds…": files come in through the drop path.
  - The pop-out's own X button: "Bring back" closes the window the same way (`CloseRequested`, then `Destroyed`).
  - A device unplugged while on: `sb_lost.js` takes the cable away through the devices; the stream-error path is unit-tested (`a_lost_device_ends_the_engine_and_ticks_report_the_voices`).
  - "Mute other apps while recording" during a dictation: needs a dictation; covered by `mute.rs`'s own-process rule (Task 7, Step 5).
