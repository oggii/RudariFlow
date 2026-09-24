fn main() {
    // Delay-loaded DLLs: rudariflow.exe starts without them and loads each
    // the first time it is used.
    // - nvcuda.dll: ggml's CUDA backend imports it, and only an NVIDIA
    //   display driver provides it. As a normal import, rudariflow.exe would
    //   fail to start on AMD / Intel / no-GPU machines.
    // - sherpa-onnx-c-api.dll: speaker separation in the Files tab
    //   (src/speakers.rs checks that it loads before calling it), so a
    //   missing DLL only turns speaker separation off.
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    if windows {
        let mut delayed = vec!["sherpa-onnx-c-api.dll"];
        if std::env::var_os("CARGO_FEATURE_CUDA").is_some() {
            delayed.push("nvcuda.dll");
        }
        for dll in delayed {
            println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}");
        }
        println!("cargo:rustc-link-arg=delayimp.lib");
        // sherpa-rs-sys's build script always requests the debug CRT
        // (msvcrtd) in a debug build, for building sherpa-onnx itself from
        // source in Debug; we only link the prebuilt release DLLs
        // (SHERPA_LIB_PATH), so once src/speakers.rs calls into sherpa-onnx
        // this needlessly conflicts with Rust's own release CRT (msvcrt) —
        // harmless (nothing actually needs msvcrtd), so just silence it.
        println!("cargo:rustc-link-arg=/IGNORE:4098");
    }
    tauri_build::build()
}
