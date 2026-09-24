//! Speaker separation on a 16 kHz mono 16-bit WAV: turns, speakers, time.
//! <app dir> must hold speakers\segmentation.onnx and speakers\embedding.onnx;
//! the sherpa-onnx runtime must be on PATH (see speakers_probe).
//!   cargo run --release --example speakers_bench -- <app dir> <wav> [auto|2..8]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(args.len() >= 3, "usage: speakers_bench <app dir> <wav> [auto|2..8]");
    let app_dir = std::path::PathBuf::from(&args[1]);
    let audio = rudariflow_lib::history::read_wav(std::path::Path::new(&args[2])).expect("16 kHz mono 16-bit WAV");
    let count = rudariflow_lib::speakers::parse_setting(args.get(3).map_or("auto", String::as_str)).expect("auto or 2..8");
    let started = std::time::Instant::now();
    let turns = rudariflow_lib::speakers::separate(&audio, count, &app_dir, &mut |done, total| {
        eprint!("\r{done}/{total}");
    })
    .expect("separate");
    eprintln!();
    for t in &turns {
        println!("{:>8.2} -- {:>8.2}  speaker {}", t.start_ms as f64 / 1000.0, t.end_ms as f64 / 1000.0, t.speaker);
    }
    let mut speakers: Vec<u32> = turns.iter().map(|t| t.speaker).collect();
    speakers.sort_unstable();
    speakers.dedup();
    println!(
        "{} speakers, {} turns, {:.1} s for {:.1} s of audio ({} threads)",
        speakers.len(),
        turns.len(),
        started.elapsed().as_secs_f64(),
        audio.len() as f64 / 16_000.0,
        rudariflow_lib::speakers::threads()
    );
}
