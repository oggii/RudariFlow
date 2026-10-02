//! The soundboard engine on the real devices, without the app: plays a
//! sound into the VB-Audio cable and measures what arrives on "CABLE
//! Output" and on the headphones output. The "headphones" are the cable's
//! own input endpoint, the same one as the cable, so nothing plays on the
//! speakers. Not the cable's 16-channel endpoint: the two cable inputs share
//! one driver pin, and on this PC the second to open fails (0x8889000A,
//! AUDCLNT_E_DEVICE_IN_USE). Two shared-mode streams on one endpoint are
//! fine; the loopback then measures that shared endpoint (both outputs'
//! sounds), not the headphones path alone.
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
    let cable = engine::auto_cable(&list.outputs).expect("no VB-Audio Virtual Cable");
    // Never a real output: the headphones are the cable endpoint itself.
    assert!(cable.contains("VB-Audio"), "not a VB-Audio cable endpoint: {}", cable);
    let devices = EngineDevices {
        microphone: list
            .default_input
            .clone()
            .filter(|n| !n.contains("VB-Audio"))
            .expect("no microphone, or Windows' default microphone is the cable itself"),
        cable: cable.clone(),
        headphones: cable,
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
