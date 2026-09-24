//! Speaker separation for the Files tab: who speaks when, with sherpa-onnx
//! (pyannote segmentation 3.0 and the 3D-Speaker ERes2Net voice embedding).

/// sherpa-onnx's C API, next to rudariflow.exe (delay-loaded, see build.rs).
const RUNTIME_DLL: &str = "sherpa-onnx-c-api.dll";

/// Whether the sherpa-onnx runtime loads. Checked before every call into
/// it: a delay-loaded DLL that is missing would end the process.
pub fn runtime_available() -> bool {
    imp::load(RUNTIME_DLL)
}

#[cfg(windows)]
mod imp {
    pub fn load(dll: &str) -> bool {
        use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;
        let wide: Vec<u16> = dll.encode_utf16().chain(std::iter::once(0)).collect();
        // The module stays loaded; the delay-load helper then finds it.
        !unsafe { LoadLibraryW(wide.as_ptr()) }.is_null()
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn load(_dll: &str) -> bool {
        false
    }
}
