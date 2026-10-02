//! The microphone on its way to the cable. Its frames are made stereo
//! (`mic_frames`) and wait in a `DriftBuffer`, converted to the cable's rate
//! (`Resampler`), until the cable's callback takes them. The two devices run
//! on their own clocks: the buffer keeps the voice's extra delay between
//! about 15 and 25 ms by converting a little faster or slower (at most
//! 0.4 %, a pitch change nobody hears, and without any periodic pattern),
//! and an excess that a stall left behind is skipped in one step with a
//! 5 ms crossfade.

use std::collections::VecDeque;
use std::f32::consts::FRAC_PI_2;

use super::mixer::add_frame;

/// Fill kept after each read of the cable (the lowest one in a window).
/// When the two devices' callbacks pass each other (every few minutes) the
/// fill after a read moves by one callback (10 ms), so this keeps room for one.
pub const TARGET_MS: u32 = 15;
/// More than this above the target is skipped at once.
pub const SKIP_OVER_MS: u32 = 20;
/// The lowest fill after a read is taken over this much of the cable's time.
const WINDOW_MS: u32 = 250;
/// The rate is corrected by this much per ms of fill above (below) the
/// target, plus this much more per ms and window for as long as it stays
/// so (which finds the clocks' difference; critically damped, about 5 s) ...
const PPM_PER_MS: f64 = 400.0;
const PPM_PER_MS_WINDOW: f64 = 10.0;
/// ... with the clocks' difference taken as at most 0.2 % and the whole
/// correction at most 0.4 % (7 cents).
const MAX_DRIFT_PPM: f64 = 2_000.0;
const MAX_PPM: f64 = 4_000.0;
/// A skip crossfades over this time.
const XFADE_MS: u32 = 5;
/// A cable that stopped reading: frames beyond this are dropped at once.
const CAP_MS: u32 = 200;
/// Microphone frames converted at a time, so a push never holds more than
/// the cap plus one slice (and never reallocates).
const SLICE: usize = 2_048;

#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftStats {
    /// Smoothed fill after a read of the cable.
    pub fill_ms: f32,
    pub max_fill_ms: f32,
    /// Frames dropped: skipped after a stall, or beyond the cap.
    pub dropped: u64,
    /// Skips (each one crossfaded).
    pub skips: u64,
    /// The rate correction now, in parts per million (above 0: the
    /// microphone's frames are converted to fewer).
    pub speed_ppm: f32,
    /// Times the cable found the buffer empty.
    pub underruns: u64,
    /// Frames the microphone delivered, at the cable's rate.
    pub pushed: u64,
    /// The longest time between two reads of the cable, and between two
    /// pushes of the microphone (the engine notes them), in ms.
    pub read_gap_ms: f32,
    pub push_gap_ms: f32,
}

pub struct DriftBuffer {
    frames: VecDeque<[f32; 2]>,
    resampler: Resampler,
    rate: u32,
    target: usize,
    skip_over: usize,
    window: usize,
    xfade: usize,
    cap: usize,
    /// Reading; off at the start and after an underrun until the fill is
    /// one read above the target.
    primed: bool,
    /// Smoothed fill after a read, in frames (for the stats).
    avg: Option<f64>,
    /// The lowest fill after a read in this window, and the frames read in it.
    floor: usize,
    seen: usize,
    /// Frames to skip at the next read.
    skip: usize,
    /// The correction the fill's history asks for (the clocks' difference), in ppm.
    drift_ppm: f64,
    stats: DriftStats,
}

impl DriftBuffer {
    /// A buffer for a microphone at `mic_rate` and a cable at `rate`.
    pub fn new(mic_rate: u32, rate: u32) -> DriftBuffer {
        let frames_in = |ms: u32| (rate as u64 * ms as u64 / 1000) as usize;
        let cap = frames_in(CAP_MS);
        DriftBuffer {
            // Room for the cap and a slice: a push past it after a stall must
            // not reallocate in the microphone callback before the excess is dropped.
            frames: VecDeque::with_capacity(2 * cap + 2 * SLICE),
            resampler: Resampler::new(mic_rate, rate),
            rate,
            target: frames_in(TARGET_MS),
            skip_over: frames_in(SKIP_OVER_MS),
            window: frames_in(WINDOW_MS),
            xfade: frames_in(XFADE_MS).max(1),
            cap,
            primed: false,
            avg: None,
            floor: usize::MAX,
            seen: 0,
            skip: 0,
            drift_ppm: 0.0,
            stats: DriftStats::default(),
        }
    }

    /// Microphone frames at the microphone's rate.
    pub fn push(&mut self, mic: &[[f32; 2]]) {
        for slice in mic.chunks(SLICE) {
            let before = self.frames.len();
            self.resampler.process(slice, &mut self.frames);
            self.stats.pushed += (self.frames.len() - before) as u64;
            let over = self.frames.len().saturating_sub(self.cap);
            if over > 0 {
                self.frames.drain(..over);
                self.stats.dropped += over as u64;
            }
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
        let mut from = 0;
        // A skip: the frames here fade out while those after the skip fade in.
        let skip = std::mem::take(&mut self.skip).min(self.frames.len().saturating_sub(n));
        if skip > 0 {
            let fade = self.xfade.min(n);
            for j in 0..fade {
                let (a, b) = (self.frames[j], self.frames[skip + j]);
                let x = (j as f32 + 0.5) / fade as f32 * FRAC_PI_2;
                let (fade_out, fade_in) = (x.cos(), x.sin());
                add_frame(out, channels, j, [a[0] * fade_out + b[0] * fade_in, a[1] * fade_out + b[1] * fade_in]);
            }
            self.frames.drain(..skip + fade);
            self.stats.dropped += skip as u64;
            self.stats.skips += 1;
            from = fade;
        }
        for i in from..n {
            let Some(frame) = self.frames.pop_front() else {
                // Underrun: the rest stays silent until it is primed again.
                self.stats.underruns += 1;
                self.primed = false;
                self.avg = None;
                self.floor = usize::MAX;
                self.seen = 0;
                return;
            };
            add_frame(out, channels, i, frame);
        }
        self.after_read(n);
    }

    /// Track the fill; at the end of a window correct the rate, or skip the
    /// excess a stall left.
    fn after_read(&mut self, n: usize) {
        let fill = self.frames.len();
        let avg = self.avg.map_or(fill as f64, |a| a * 0.9 + fill as f64 * 0.1);
        self.avg = Some(avg);
        let ms = |frames: f64| (frames * 1000.0 / self.rate as f64) as f32;
        self.stats.fill_ms = ms(avg);
        self.stats.max_fill_ms = self.stats.max_fill_ms.max(ms(fill as f64));
        self.floor = self.floor.min(fill);
        self.seen += n;
        if self.seen < self.window {
            return;
        }
        let mut floor = self.floor;
        if floor > self.target + self.skip_over {
            self.skip = floor - self.target;
            floor = self.target;
        }
        let error_ms = (floor as f64 - self.target as f64) * 1000.0 / self.rate as f64;
        self.drift_ppm = (self.drift_ppm + error_ms * PPM_PER_MS_WINDOW).clamp(-MAX_DRIFT_PPM, MAX_DRIFT_PPM);
        let ppm = (self.drift_ppm + error_ms * PPM_PER_MS).clamp(-MAX_PPM, MAX_PPM);
        self.resampler.set_speed(1.0 + ppm * 1e-6);
        self.stats.speed_ppm = ppm as f32;
        self.floor = usize::MAX;
        self.seen = 0;
    }

    /// The time since the cable's previous read, in ms.
    pub fn note_read_gap(&mut self, ms: f32) {
        self.stats.read_gap_ms = self.stats.read_gap_ms.max(ms);
    }

    /// The time since the microphone's previous push, in ms.
    pub fn note_push_gap(&mut self, ms: f32) {
        self.stats.push_gap_ms = self.stats.push_gap_ms.max(ms);
    }

    pub fn stats(&self) -> DriftStats {
        self.stats
    }
}

/// Linear rate conversion of a stream of stereo frames, chunk by chunk
/// (the microphone at its rate → the cable's rate), a little faster or
/// slower when asked (`set_speed`).
pub struct Resampler {
    /// Input frames per output frame at speed 1.
    base: f64,
    /// Input frames per output frame now.
    step: f64,
    /// Position of the next output frame; 0 is `prev`, k is input[k - 1].
    pos: f64,
    /// The last frame of the previous chunk.
    prev: [f32; 2],
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Resampler {
        let base = from as f64 / to.max(1) as f64;
        Resampler { base, step: base, pos: 1.0, prev: [0.0; 2] }
    }

    /// Above 1: the input is used up faster (fewer output frames).
    pub fn set_speed(&mut self, speed: f64) {
        self.step = self.base * speed;
    }

    /// Convert `input` and append the frames to `out`.
    pub fn process(&mut self, input: &[[f32; 2]], out: &mut impl Extend<[f32; 2]>) {
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
            out.extend(std::iter::once([a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac]));
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

    /// `secs` of a 48 kHz microphone and a cable whose clocks differ by
    /// `skew` (0.001: the microphone runs 0.1 % fast), both with 10 ms
    /// callbacks, the microphone 3 ms after the cable.
    /// Returns the buffer, the lowest fill after a read once primed (ms) and
    /// the mean correction after the first minute (ppm).
    fn simulate(skew: f64, secs: u32) -> (DriftBuffer, f32, f64) {
        let mut buffer = DriftBuffer::new(48_000, 48_000);
        let chunk = vec![[0.1f32, 0.1]; 480];
        let mut out = vec![0f32; 960];
        let mic_period = 10_000.0 / (1.0 + skew);
        let (mut mic_t, mut cable_t) = (3_000.0f64, 0.0f64);
        let (mut lowest, mut ppm_sum, mut reads) = (f32::MAX, 0.0f64, 0u32);
        let end = secs as f64 * 1e6;
        while mic_t < end || cable_t < end {
            if mic_t <= cable_t {
                buffer.push(&chunk);
                mic_t += mic_period;
            } else {
                out.fill(0.0);
                buffer.read_into(&mut out, 2);
                cable_t += 10_000.0;
                if buffer.primed {
                    lowest = lowest.min(buffer.frames.len() as f32 / 48.0);
                }
                if cable_t > 60e6 {
                    ppm_sum += buffer.stats.speed_ppm as f64;
                    reads += 1;
                }
            }
        }
        (buffer, lowest, ppm_sum / reads.max(1) as f64)
    }

    /// The amplitude of `f` Hz in `x` (Hann window).
    fn tone(x: &[f32], f: f64, rate: f64) -> f64 {
        let w = 2.0 * PI * f / rate;
        let c = 2.0 * w.cos();
        let len = x.len() as f64;
        let (mut s1, mut s2) = (0.0f64, 0.0f64);
        for (j, &v) in x.iter().enumerate() {
            let hann = 0.5 - 0.5 * (2.0 * PI * j as f64 / len).cos();
            let s0 = v as f64 * hann + c * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        4.0 * (s1 * s1 + s2 * s2 - c * s1 * s2).max(0.0).sqrt() / len
    }

    /// The strongest frequency between `lo` and `hi` Hz (0.5 Hz steps) and its amplitude.
    fn peak(x: &[f32], lo: f64, hi: f64) -> (f64, f64) {
        (0..=((hi - lo) * 2.0) as usize)
            .map(|i| lo + i as f64 * 0.5)
            .map(|f| (tone(x, f, 48_000.0), f))
            .fold((0.0, 0.0), |a, b| if b.0 > a.0 { b } else { a })
    }

    struct Run {
        /// (time in s, fill after the read in ms), one per read of the cable.
        trace: Vec<(f64, f32)>,
        /// The left channel the cable got.
        out: Vec<f32>,
        stats: DriftStats,
    }

    /// The engine's path: a 44.1 kHz microphone (441-frame callbacks, a
    /// `freq` Hz sine at 0.5) into the buffer, the 48 kHz cable taking 480
    /// frames every 10 ms on a clock `skew` slower. At `stall_at` s the cable
    /// stops for `stall_ms`, then takes a whole WASAPI buffer (960 frames).
    fn run_path(skew: f64, secs: f64, stall_at: f64, stall_ms: f64, freq: f64) -> Run {
        let mut buffer = DriftBuffer::new(44_100, 48_000);
        let mut frames = Vec::new();
        let (mut mic_t, mut cable_t, mut k) = (3_000.0f64, 0.0f64, 0u64);
        let mut stalled = stall_ms <= 0.0;
        let mut run = Run { trace: Vec::new(), out: Vec::new(), stats: DriftStats::default() };
        while cable_t < secs * 1e6 {
            if mic_t <= cable_t {
                let data: Vec<f32> = (k..k + 441)
                    .flat_map(|j| {
                        let s = ((2.0 * PI * freq * j as f64 / 44_100.0).sin() * 0.5) as f32;
                        [s, s]
                    })
                    .collect();
                k += 441;
                frames.clear();
                mic_frames(&data, 2, &mut frames);
                buffer.push(&frames);
                mic_t += 10_000.0;
                continue;
            }
            let n = if !stalled && cable_t >= stall_at * 1e6 {
                stalled = true;
                cable_t += stall_ms * 1000.0;
                960
            } else {
                480
            };
            let mut out = vec![0f32; n * 2];
            buffer.read_into(&mut out, 2);
            run.out.extend(out.iter().step_by(2));
            run.trace.push((cable_t / 1e6, buffer.frames.len() as f32 / 48.0));
            cable_t += 10_000.0 * (1.0 + skew);
        }
        run.stats = buffer.stats();
        run
    }

    /// The voice's 1 kHz carrier in the second from `from` s of the output,
    /// and the strongest line 480 Hz above and below it, in dB under it (a
    /// frame dropped or repeated every 100 frames puts lines there).
    fn sidebands(run: &Run, from: f64) -> (f64, f64) {
        let a = (from * 48_000.0) as usize;
        let w = &run.out[a..a + 48_000];
        let (c, fc) = peak(w, 985.0, 1015.0);
        let up = peak(w, fc + 465.0, fc + 495.0).0;
        let down = peak(w, fc - 495.0, fc - 465.0).0;
        (fc, 20.0 * (up.max(down) / c).log10())
    }

    /// When the fill is back within 10 ms of the target after the stall that
    /// ended at `stall_end` s, and stays there: seconds after `stall_end`.
    fn settled_after(run: &Run, stall_end: f64) -> f64 {
        let limit = (TARGET_MS + 10) as f32;
        let last_over = run.trace.iter().filter(|t| t.0 >= stall_end && t.1 > limit).map(|t| t.0).fold(stall_end, f64::max);
        last_over - stall_end
    }

    #[test]
    #[ignore]
    fn measure_the_cable_path() {
        // cargo test --lib soundboard::drift -- --ignored --nocapture
        for stall in [0.0, 50.0, 100.0, 200.0, 300.0] {
            let r = run_path(50e-6, 30.0, 5.0, stall, 1000.0);
            println!("stall {} ms: settled {:.2} s after it; {:?}", stall, settled_after(&r, 5.0 + stall / 1000.0), r.stats);
            for (fc, db) in [sidebands(&r, 3.0), sidebands(&r, 6.0 + stall / 1000.0), sidebands(&r, 25.0)] {
                print!("  carrier {} Hz, lines {:.1} dB;", fc, db);
            }
            println!();
        }
        let r = run_path(0.001, 30.0, 0.0, 0.0, 1000.0);
        println!("1000 ppm, no stall: {:?}; at 25 s {:?}", r.stats, sidebands(&r, 25.0));
    }


    #[test]
    fn the_delay_stays_near_the_target_when_the_clocks_drift() {
        // 0.1 % of 5 minutes at 48 kHz: 14,400 frames to make up, by the rate alone.
        for skew in [0.001, -0.001, 0.000_05] {
            let (buffer, lowest, mean_ppm) = simulate(skew, 300);
            let s = buffer.stats();
            assert_eq!((s.underruns, s.skips, s.dropped), (0, 0, 0), "{}: {:?}", skew, s);
            assert!(s.max_fill_ms <= (TARGET_MS + SKIP_OVER_MS) as f32, "{}: {:?}", skew, s);
            assert!(lowest >= 2.0, "{}: the fill fell to {} ms", skew, lowest);
            // On average the correction is the skew (microphone fast: its frames
            // are converted to fewer), give or take a callback's step it works off.
            let ppm = skew * 1e6;
            assert!((mean_ppm - ppm).abs() <= ppm.abs() * 0.1 + 50.0, "{}: {} ppm on average, {:?}", skew, mean_ppm, s);
        }
    }

    #[test]
    fn a_stall_is_skipped_within_a_second_with_one_crossfade() {
        for stall in [50.0, 100.0, 200.0, 300.0] {
            let r = run_path(50e-6, 8.0, 5.0, stall, 1000.0);
            let s = r.stats;
            assert_eq!((s.underruns, s.skips), (0, 1), "{} ms: {:?}", stall, s);
            let settled = settled_after(&r, 5.0 + stall / 1000.0);
            assert!(settled <= 1.0, "{} ms: back within target + 10 ms only after {} s", stall, settled);
            // Within the cap, nothing but the skip is dropped and the voice
            // stays continuous: no step larger than the 1 kHz sine's own
            // (0.065 per frame) by more than the crossfade's swell.
            if stall <= 100.0 {
                let step = r.out.windows(2).skip(4_800).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
                assert!(step < 0.1, "{} ms: a step of {}", stall, step);
            }
        }
    }

    #[test]
    fn no_frame_is_dropped_or_repeated_in_steady_state() {
        // The worst drift the rate covers comfortably, and none.
        for skew in [0.001, 0.0] {
            let r = run_path(skew, 12.0, 0.0, 0.0, 1000.0);
            assert_eq!((r.stats.underruns, r.stats.skips, r.stats.dropped), (0, 0, 0), "{:?}", r.stats);
            // No lines 480 Hz from the voice (the old one-frame-in-a-hundred
            // pattern: -33 dB); the linear resampler alone is below -60 dB.
            let (fc, db) = sidebands(&r, 10.0);
            assert!((fc - 1000.0).abs() <= 2.0, "the pitch moved to {} Hz", fc);
            assert!(db < -55.0, "{}: lines at {} dB", skew, db);
        }
    }

    #[test]
    fn a_push_past_the_cap_does_not_reallocate() {
        let mut buf = DriftBuffer::new(48_000, 48_000);
        let before = buf.frames.capacity();
        assert!(before >= 2 * buf.cap);
        buf.push(&vec![[0.0, 0.0]; buf.cap]);
        buf.push(&vec![[0.0, 0.0]; buf.cap]);
        assert_eq!(buf.frames.len(), buf.cap);
        assert_eq!(buf.frames.capacity(), before);
    }

    #[test]
    fn an_underrun_is_silence_and_it_starts_again_with_a_margin() {
        let mut buffer = DriftBuffer::new(48_000, 48_000);
        let mut out = vec![0f32; 960];
        buffer.read_into(&mut out, 2);
        assert!(out.iter().all(|&s| s == 0.0), "nothing before it is primed");
        // The target (15 ms) and a read on top: three reads.
        buffer.push(&vec![[0.5, 0.5]; 1_440]);
        for _ in 0..3 {
            out.fill(0.0);
            buffer.read_into(&mut out, 2);
            assert!(out.iter().all(|&s| s == 0.5));
        }
        out.fill(0.0);
        buffer.read_into(&mut out, 2);
        assert_eq!(buffer.stats().underruns, 1);
        assert!(out.iter().all(|&s| s == 0.0));
        // Primed again only with a read on top of the target (15 ms + 10 ms).
        buffer.push(&vec![[0.5, 0.5]; 1_000]);
        out.fill(0.0);
        buffer.read_into(&mut out, 2);
        assert!(out.iter().all(|&s| s == 0.0));
        assert_eq!(buffer.stats().pushed, 2_440);
    }

    #[test]
    fn a_stalled_cable_does_not_let_the_buffer_grow() {
        let mut buffer = DriftBuffer::new(48_000, 48_000);
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
        // 0.1 % faster: 0.1 % fewer frames.
        let mut faster = Resampler::new(44_100, 48_000);
        faster.set_speed(1.001);
        let mut fewer = Vec::new();
        for chunk in input.chunks(441) {
            faster.process(chunk, &mut fewer);
        }
        assert!((47_940..=47_956).contains(&fewer.len()), "{}", fewer.len());
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
