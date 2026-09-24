//! Decode media files the way file transcription does and report length,
//! time and level, optionally against a WAV reference of the same audio.
//!
//!   cargo run --release --example media_probe -- <file>... [--ref <16k mono wav>]

use std::path::Path;
use std::time::Instant;

use rudariflow_lib::history::read_wav;
use rudariflow_lib::media::decode_16k_mono;

fn rms(s: &[f32]) -> f32 {
    (s.iter().map(|x| x * x).sum::<f32>() / s.len().max(1) as f32).sqrt()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let reference = args.iter().position(|a| a == "--ref").map(|i| read_wav(Path::new(&args[i + 1])).expect("ref"));
    for file in args.iter().take_while(|a| *a != "--ref") {
        let started = Instant::now();
        match decode_16k_mono(Path::new(file), |_, _| {}) {
            Ok(samples) => {
                let mut line = format!(
                    "{}: {:.2} s audio in {} ms, rms {:.4}",
                    Path::new(file).file_name().unwrap().to_string_lossy(),
                    samples.len() as f32 / 16_000.0,
                    started.elapsed().as_millis(),
                    rms(&samples)
                );
                if let Some(r) = &reference {
                    line += &format!(", ref {:.2} s rms {:.4}", r.len() as f32 / 16_000.0, rms(r));
                }
                println!("{}", line);
            }
            Err(e) => println!("{}: ERROR {}", file, e),
        }
    }
}
