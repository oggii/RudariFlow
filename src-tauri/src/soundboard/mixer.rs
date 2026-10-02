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
