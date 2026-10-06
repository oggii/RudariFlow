//! PC check: Whisper on every usable GPU with flash attention on and off,
//! so RudariFlow picks the fastest setup on hardware it was never tested
//! on (NVIDIA through CUDA or Vulkan, RX 7000+ and Intel Arc where flash
//! attention can be the faster choice). The AI part and the report are put
//! together in main.rs.

use std::path::Path;

use crate::whisper_engine::{
    backend_candidates, flash_attn_default, list_gpu_devices, load_for_check, timed_run, ActiveBackend, GpuApi,
    GpuDevice,
};

/// Timed runs per variant; the median counts.
const RUNS: usize = 3;
/// The default setup stays unless another one is faster by more than this.
const KEEP_DEFAULT_WITHIN: f64 = 1.05;

/// One Whisper setup and how it did.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Measurement {
    #[serde(skip)]
    pub backend: ActiveBackend,
    pub label: String,
    pub flash_attn: bool,
    pub load_ms: u64,
    pub median_ms: Option<u64>,
    pub error: Option<String>,
}

/// Every setup to measure, see `variants_for`.
pub fn variants() -> Vec<(ActiveBackend, bool)> {
    variants_for(&list_gpu_devices())
}

/// The GPUs the settings can pick ("cuda" and "vulkan" each resolve to one),
/// with flash attention off and on; the CPU only when there is no GPU (a
/// large model takes seconds there). Other GPUs are left out, since no
/// setting would use them: the integrated Radeon next to an RTX 5080 took
/// 36 s per run, four of the check's five minutes.
fn variants_for(devices: &[GpuDevice]) -> Vec<(ActiveBackend, bool)> {
    let gpus: Vec<ActiveBackend> =
        ["cuda", "vulkan"].into_iter().flat_map(|api| backend_candidates(api, devices)).collect();
    if gpus.is_empty() {
        return vec![(ActiveBackend::Cpu, false)];
    }
    gpus.into_iter().flat_map(|gpu| [(gpu.clone(), false), (gpu, true)]).collect()
}

/// The setup RudariFlow uses without the check: `auto` with the default
/// flash attention for its API.
pub fn default_variant() -> (ActiveBackend, bool) {
    let backend = backend_candidates("auto", &list_gpu_devices()).into_iter().next().unwrap_or(ActiveBackend::Cpu);
    let flash_attn = match &backend {
        ActiveBackend::Gpu(d) => flash_attn_default(d.api, None, None),
        ActiveBackend::Cpu => false,
    };
    (backend, flash_attn)
}

fn label(backend: &ActiveBackend, flash_attn: bool) -> String {
    match backend {
        ActiveBackend::Gpu(d) => format!(
            "{} {}, flash attention {}",
            d.api.label(),
            d.name,
            if flash_attn { "on" } else { "off" }
        ),
        ActiveBackend::Cpu => "CPU".to_string(),
    }
}

/// Measure each variant on `clip`: load (with its warm-up run), then the
/// median of three transcriptions. `progress(done, total, label)`.
pub fn measure(
    model_path: &Path,
    clip: &[f32],
    language: &str,
    variants: &[(ActiveBackend, bool)],
    progress: impl Fn(usize, usize, &str),
) -> Vec<Measurement> {
    let mut out = Vec::new();
    for (i, (backend, flash_attn)) in variants.iter().enumerate() {
        let label = label(backend, *flash_attn);
        progress(i, variants.len(), &label);
        let started = std::time::Instant::now();
        let mut m = Measurement {
            backend: backend.clone(),
            label,
            flash_attn: *flash_attn,
            load_ms: 0,
            median_ms: None,
            error: None,
        };
        match load_for_check(model_path, backend, *flash_attn) {
            Ok((_ctx, mut state)) => {
                m.load_ms = started.elapsed().as_millis() as u64;
                let mut times = Vec::new();
                for _ in 0..RUNS {
                    match timed_run(&mut state, clip, language) {
                        Ok(ms) => times.push(ms as u64),
                        Err(e) => {
                            m.error = Some(e);
                            break;
                        }
                    }
                }
                times.sort();
                m.median_ms = (times.len() == RUNS).then(|| times[RUNS / 2]);
            }
            Err(e) => m.error = Some(e),
        }
        out.push(m);
    }
    progress(variants.len(), variants.len(), "");
    out
}

/// Index of the setup to use: the fastest, unless the default one is
/// within 5 % of it (measurement noise must not flip the setting).
pub fn choose(results: &[Measurement], default: &(ActiveBackend, bool)) -> Option<usize> {
    let best = results
        .iter()
        .enumerate()
        .filter_map(|(i, m)| m.median_ms.map(|ms| (i, ms)))
        .min_by_key(|&(_, ms)| ms)?;
    let default_index = results.iter().position(|m| m.backend == default.0 && m.flash_attn == default.1);
    match default_index.and_then(|i| results[i].median_ms.map(|ms| (i, ms))) {
        Some((i, ms)) if ms as f64 <= best.1 as f64 * KEEP_DEFAULT_WITHIN => Some(i),
        _ => Some(best.0),
    }
}

/// The `gpuBackend` and `whisperFlashAttn` settings for a chosen setup:
/// "auto" wherever the default already matches.
pub fn settings_for(chosen: &Measurement, default: &(ActiveBackend, bool)) -> (String, String) {
    let api = match &chosen.backend {
        ActiveBackend::Gpu(d) => Some(d.api),
        ActiveBackend::Cpu => None,
    };
    let backend = if chosen.backend == default.0 {
        "auto".to_string()
    } else {
        match api {
            Some(GpuApi::Cuda) => "cuda".to_string(),
            Some(GpuApi::Vulkan) => "vulkan".to_string(),
            None => "cpu".to_string(),
        }
    };
    let flash_attn = match api {
        Some(api) if chosen.flash_attn != flash_attn_default(api, None, None) => {
            if chosen.flash_attn { "on" } else { "off" }.to_string()
        }
        _ => "auto".to_string(),
    };
    (backend, flash_attn)
}

/// Windows version, CPU and memory, for the report.
pub fn system_summary() -> String {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    let (windows, cpu, ram_gb) = imp::system();
    format!("{}; {} ({} threads); {:.0} GB RAM", windows, cpu, threads, ram_gb)
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn registry_string(key: &str, value: &str) -> Option<String> {
        let (key, value) = (wide(key), wide(value));
        let mut buf = vec![0u16; 256];
        let mut size = (buf.len() * 2) as u32;
        // SAFETY: buffer and size describe `buf`; the call writes at most `size` bytes.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != 0 {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]).trim().to_string())
    }

    pub fn system() -> (String, String, f64) {
        let nt = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
        let build = registry_string(nt, "CurrentBuild").unwrap_or_default();
        let mut product = registry_string(nt, "ProductName").unwrap_or_else(|| "Windows".into());
        // Windows 11 still calls itself "Windows 10" in ProductName.
        if build.parse::<u32>().is_ok_and(|b| b >= 22_000) {
            product = product.replace("Windows 10", "Windows 11");
        }
        let windows = format!(
            "{} {} (build {})",
            product,
            registry_string(nt, "DisplayVersion").unwrap_or_default(),
            build
        );
        let cpu = registry_string(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString")
            .unwrap_or_else(|| "unknown CPU".into());
        // SAFETY: plain struct with its size set, filled by the call.
        let ram_gb = unsafe {
            let mut status: MEMORYSTATUSEX = std::mem::zeroed();
            status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut status) != 0 {
                status.ullTotalPhys as f64 / (1024.0 * 1024.0 * 1024.0)
            } else {
                0.0
            }
        };
        (windows, cpu, ram_gb)
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn system() -> (String, String, f64) {
        (std::env::consts::OS.to_string(), "unknown CPU".into(), 0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gpu(api: GpuApi) -> ActiveBackend {
        ActiveBackend::Gpu(GpuDevice { gpu_index: 0, api, name: "GPU".into(), integrated: false, memory_mib: 16384 })
    }

    fn device(gpu_index: i32, api: GpuApi, name: &str, integrated: bool) -> GpuDevice {
        GpuDevice { gpu_index, api, name: name.into(), integrated, memory_mib: 16_000 }
    }

    #[test]
    fn only_gpus_a_setting_can_pick_are_measured() {
        // RTX 5080 with a Ryzen iGPU: CUDA and Vulkan on the card, not the iGPU.
        let rtx_and_igpu = [
            device(0, GpuApi::Cuda, "RTX 5080", false),
            device(1, GpuApi::Vulkan, "RTX 5080", false),
            device(2, GpuApi::Vulkan, "AMD Radeon(TM) Graphics", true),
        ];
        let names: Vec<String> = variants_for(&rtx_and_igpu)
            .iter()
            .map(|(b, fa)| match b {
                ActiveBackend::Gpu(d) => format!("{:?} {} {}", d.api, d.name, fa),
                ActiveBackend::Cpu => "CPU".into(),
            })
            .collect();
        assert_eq!(names, ["Cuda RTX 5080 false", "Cuda RTX 5080 true", "Vulkan RTX 5080 false", "Vulkan RTX 5080 true"]);
        // A laptop with only an iGPU still measures it; no GPU means the CPU.
        let igpu_only = [device(0, GpuApi::Vulkan, "Intel Iris Xe", true)];
        assert_eq!(variants_for(&igpu_only).len(), 2);
        assert_eq!(variants_for(&[]), vec![(ActiveBackend::Cpu, false)]);
    }

    fn m(backend: ActiveBackend, flash_attn: bool, median_ms: Option<u64>) -> Measurement {
        Measurement { backend, label: String::new(), flash_attn, load_ms: 0, median_ms, error: None }
    }

    #[test]
    fn the_default_stays_unless_something_is_clearly_faster() {
        let default = (gpu(GpuApi::Vulkan), false);
        // RX 6800: flash attention off is faster anyway.
        let rx6800 = vec![m(gpu(GpuApi::Vulkan), false, Some(272)), m(gpu(GpuApi::Vulkan), true, Some(540))];
        assert_eq!(choose(&rx6800, &default), Some(0));
        // 3 % faster with flash attention: noise, keep the default.
        let close = vec![m(gpu(GpuApi::Vulkan), false, Some(300)), m(gpu(GpuApi::Vulkan), true, Some(291))];
        assert_eq!(choose(&close, &default), Some(0));
        // Clearly faster (an RX 7000 with matrix cores, say): switch.
        let rdna3 = vec![m(gpu(GpuApi::Vulkan), false, Some(300)), m(gpu(GpuApi::Vulkan), true, Some(200))];
        assert_eq!(choose(&rdna3, &default), Some(1));
        // The default failed: the best that worked.
        let failed = vec![m(gpu(GpuApi::Vulkan), false, None), m(gpu(GpuApi::Vulkan), true, Some(400))];
        assert_eq!(choose(&failed, &default), Some(1));
        assert_eq!(choose(&[m(gpu(GpuApi::Vulkan), false, None)], &default), None);
    }

    #[test]
    fn settings_say_auto_where_the_default_matches() {
        let default = (gpu(GpuApi::Cuda), true);
        assert_eq!(settings_for(&m(gpu(GpuApi::Cuda), true, Some(1)), &default), ("auto".into(), "auto".into()));
        assert_eq!(settings_for(&m(gpu(GpuApi::Vulkan), true, Some(1)), &default), ("vulkan".into(), "on".into()));
        assert_eq!(settings_for(&m(gpu(GpuApi::Cuda), false, Some(1)), &default), ("auto".into(), "off".into()));
        let cpu_default = (ActiveBackend::Cpu, false);
        assert_eq!(settings_for(&m(ActiveBackend::Cpu, false, Some(1)), &cpu_default), ("auto".into(), "auto".into()));
    }
}
