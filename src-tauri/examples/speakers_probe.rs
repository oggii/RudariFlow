//! The sherpa-onnx runtime loads and answers. Run with the runtime on PATH:
//!   $env:PATH = "$PWD\binaries\sherpa-onnx\lib;$env:PATH"
//!   cargo run --release --example speakers_probe

#[cfg(windows)]
fn main() {
    assert!(
        rudariflow_lib::speakers::runtime_available(),
        "sherpa-onnx-c-api.dll does not load; is binaries\\sherpa-onnx\\lib on PATH?"
    );
    let version = unsafe { std::ffi::CStr::from_ptr(sherpa_rs_sys::SherpaOnnxGetVersionStr()) };
    println!("sherpa-onnx {}", version.to_string_lossy());
}

#[cfg(not(windows))]
fn main() {}
