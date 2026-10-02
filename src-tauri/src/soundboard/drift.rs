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
        // Room for twice the cap: a push past it after a stall must not reallocate
        // in the microphone callback before the excess is dropped.
        let frames_in = |ms: u32| (rate as u64 * ms as u64 / 1000) as usize;
        DriftBuffer {
            frames: VecDeque::with_capacity(2 * frames_in(CAP_MS)),
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
            self.since_fix = self.since_fix.saturating_add(1);
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

/// The microphone's interleaved samples as stereo frames. One channel goes
/// on both sides. With several (a mono microphone on one input of an audio
/// interface leaves the others silent), the channel with the highest RMS
/// over this block is used on both sides; channels are never averaged, which
/// would halve the voice. Allocation-free (apart from growing `out`).
pub fn mic_frames(data: &[f32], channels: usize, out: &mut Vec<[f32; 2]>) {
    let channels = channels.max(1);
    let frames = data.len() / channels;
    if frames == 0 {
        return;
    }
    let mut best = 0;
    if channels > 1 {
        let mut best_power = -1.0f32;
        for c in 0..channels {
            let power: f32 = data[..frames * channels]
                .iter()
                .skip(c)
                .step_by(channels)
                .map(|s| s * s)
                .sum();
            if power > best_power {
                best_power = power;
                best = c;
            }
        }
    }
    out.extend(data.chunks_exact(channels).map(|f| [f[best], f[best]]));
}

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
    fn a_push_past_the_cap_does_not_reallocate() {
        let mut buf = DriftBuffer::new(48_000);
        let before = buf.frames.capacity();
        assert!(before >= 2 * buf.cap);
        buf.push(&vec![[0.0, 0.0]; buf.cap]);
        buf.push(&vec![[0.0, 0.0]; buf.cap]);
        assert_eq!(buf.frames.len(), buf.cap);
        assert_eq!(buf.frames.capacity(), before);
    }

    #[test]
    fn the_fix_counter_saturates() {
        let mut buf = DriftBuffer::new(48_000);
        buf.push(&[[0.1, 0.1]; 2000]);
        buf.since_fix = u32::MAX;
        let mut out = [0.0f32; 8];
        buf.read_into(&mut out, 2);
        assert!(buf.since_fix > 0);
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
    fn a_microphone_on_the_second_input_is_not_halved() {
        let mut out = Vec::new();
        mic_frames(&[0.0, 0.4, 0.0, -0.6], 2, &mut out);
        assert_eq!(out, vec![[0.4, 0.4], [-0.6, -0.6]]);
    }

    #[test]
    fn the_louder_channel_is_the_voice() {
        let mut out = Vec::new();
        mic_frames(&[0.5, 0.1, -0.5, 0.1, 0.5, -0.1], 2, &mut out);
        assert_eq!(out, vec![[0.5, 0.5], [-0.5, -0.5], [0.5, 0.5]]);
        // Three channels, the middle one carries the signal.
        let mut three = Vec::new();
        mic_frames(&[0.0, 0.3, 0.0, 0.0, -0.3, 0.0], 3, &mut three);
        assert_eq!(three, vec![[0.3, 0.3], [-0.3, -0.3]]);
    }

    #[test]
    fn a_mono_microphone_and_no_samples() {
        let mut out = Vec::new();
        mic_frames(&[0.5, -0.25], 1, &mut out);
        assert_eq!(out, vec![[0.5, 0.5], [-0.25, -0.25]]);
        let mut none = Vec::new();
        mic_frames(&[], 2, &mut none);
        mic_frames(&[], 1, &mut none);
        assert!(none.is_empty());
    }
}
