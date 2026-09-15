fn main() {
    // ggml's CUDA backend imports nvcuda.dll, which only an NVIDIA display
    // driver provides. As a normal import, rudariflow.exe would fail to start
    // on AMD / Intel / no-GPU machines. Delay-loading defers it until CUDA
    // memory APIs are called, which only happens once a CUDA device exists.
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    if windows && std::env::var_os("CARGO_FEATURE_CUDA").is_some() {
        println!("cargo:rustc-link-arg=/DELAYLOAD:nvcuda.dll");
        println!("cargo:rustc-link-arg=delayimp.lib");
    }
    tauri_build::build()
}
