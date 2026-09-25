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
    }
    tauri_build::build()
}
