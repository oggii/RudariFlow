use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Cached backend choice for "auto" mode: "cuda" or "cpu". Cleared via `clear_backend_cache`.
static AUTO_CACHED: Mutex<Option<&'static str>> = Mutex::new(None);

pub fn clear_backend_cache() {
    *AUTO_CACHED.lock().unwrap() = None;
}

fn whisper_dir(app: &AppHandle, backend: &str) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;
    let dir_name = match backend {
        "cuda" => "whisper-cuda",
        "cpu" => "whisper-cpu",
        other => return Err(format!("Unknown backend: {}", other)),
    };
    Ok(resource_dir.join("binaries").join(dir_name))
}

fn whisper_exe(app: &AppHandle, backend: &str) -> Result<PathBuf, String> {
    let dir = whisper_dir(app, backend)?;
    let exe = dir.join("whisper-cli.exe");
    if !exe.exists() {
        return Err(format!(
            "whisper-cli.exe not found at {:?}. Bundle integrity error.",
            exe
        ));
    }
    Ok(exe)
}

/// Probe a backend by running `whisper-cli --help`. Returns Ok if the binary
/// loads its DLLs cleanly (proxy for "this backend works on this machine").
fn probe_backend(app: &AppHandle, backend: &str) -> bool {
    let Ok(exe) = whisper_exe(app, backend) else {
        return false;
    };
    let Ok(dir) = whisper_dir(app, backend) else {
        return false;
    };
    let mut cmd = Command::new(&exe);
    cmd.current_dir(&dir).arg("--help");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.output() {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

/// Resolve which backend to actually use. For "auto", probe cuda first; cache
/// the result so we only probe once per session.
fn resolve_backend(app: &AppHandle, requested: &str) -> &'static str {
    match requested {
        "cuda" => "cuda",
        "cpu" => "cpu",
        _ => {
            // auto
            let mut cached = AUTO_CACHED.lock().unwrap();
            if let Some(b) = *cached {
                return b;
            }
            let chosen = if probe_backend(app, "cuda") { "cuda" } else { "cpu" };
            println!("[RudariFlow] Auto-detected backend: {}", chosen);
            *cached = Some(chosen);
            chosen
        }
    }
}

fn cpu_thread_count() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(4)
        .min(8)
        .max(1)
}

pub(crate) fn build_whisper_args(
    model_path: &Path,
    audio_path: &Path,
    language: &str,
    custom_prompt: &str,
    backend: &str,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::with_capacity(16);
    args.push("-m".into());
    args.push(model_path.as_os_str().to_owned());
    args.push("-f".into());
    args.push(audio_path.as_os_str().to_owned());
    args.push("--no-timestamps".into());
    args.push("-np".into());
    args.push("-l".into());
    args.push(language.into());
    args.push("--temperature".into());
    args.push("0.0".into());
    args.push("--best-of".into());
    args.push("1".into());

    if backend == "cpu" {
        args.push("-ng".into());
        args.push("-t".into());
        args.push(cpu_thread_count().to_string().into());
    }

    let trimmed_prompt = custom_prompt.trim();
    if !trimmed_prompt.is_empty() {
        args.push("--prompt".into());
        args.push(trimmed_prompt.into());
    }

    args
}

pub async fn transcribe_local(
    app: &AppHandle,
    model_path: &PathBuf,
    audio_path: &PathBuf,
    gpu_backend: &str,
    language: &str,
    custom_prompt: &str,
) -> Result<String, String> {
    if !model_path.exists() {
        return Err("Whisper model not found. Please download a model first.".to_string());
    }

    let backend = resolve_backend(app, gpu_backend);
    let dir = whisper_dir(app, backend)?;
    let exe = whisper_exe(app, backend)?;

    println!(
        "[RudariFlow] Running whisper-cli (backend={}) with model {:?}",
        backend, model_path
    );

    let args = build_whisper_args(model_path, audio_path, language, custom_prompt, backend);

    let mut cmd = Command::new(&exe);
    cmd.current_dir(&dir).args(&args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run whisper-cli: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if backend == "cuda" && gpu_backend == "auto" {
            eprintln!(
                "[RudariFlow] cuda failed at runtime ({}). Retrying on cpu.",
                stderr.trim()
            );
            *AUTO_CACHED.lock().unwrap() = Some("cpu");
            return Box::pin(transcribe_local(
                app, model_path, audio_path, "cpu", language, custom_prompt,
            ))
            .await;
        }
        return Err(format!("whisper-cli failed: {}", stderr));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    println!("[RudariFlow] Whisper output: {}", text);
    Ok(text)
}

pub fn model_filename(model_size: &str) -> String {
    format!("ggml-{}.bin", model_size)
}

pub fn model_download_url(model_size: &str) -> String {
    format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{}.bin",
        model_size
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_model_filename() {
        assert_eq!(model_filename("small"), "ggml-small.bin");
        assert_eq!(model_filename("medium"), "ggml-medium.bin");
        assert_eq!(model_filename("large-v3-turbo"), "ggml-large-v3-turbo.bin");
    }

    #[test]
    fn test_model_download_url() {
        assert_eq!(
            model_download_url("small"),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
        );
    }

    #[test]
    fn build_args_cuda_minimal() {
        let args = build_whisper_args(
            std::path::Path::new("model.bin"),
            std::path::Path::new("audio.wav"),
            "auto",
            "",
            "cuda",
        );
        let s: Vec<String> = args.iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert!(s.contains(&"-m".to_string()));
        assert!(s.contains(&"model.bin".to_string()));
        assert!(s.contains(&"-f".to_string()));
        assert!(s.contains(&"audio.wav".to_string()));
        assert!(s.contains(&"--no-timestamps".to_string()));
        assert!(s.contains(&"-np".to_string()));
        assert!(s.contains(&"-l".to_string()));
        assert!(s.contains(&"auto".to_string()));
        assert!(s.contains(&"--temperature".to_string()));
        assert!(s.contains(&"0.0".to_string()));
        assert!(s.contains(&"--best-of".to_string()));
        assert!(s.contains(&"1".to_string()));
        assert!(!s.contains(&"-ng".to_string()));
        assert!(!s.contains(&"-t".to_string()));
        assert!(!s.contains(&"--prompt".to_string()));
    }

    #[test]
    fn build_args_cpu_adds_ng_and_threads() {
        let args = build_whisper_args(
            std::path::Path::new("model.bin"),
            std::path::Path::new("audio.wav"),
            "en",
            "",
            "cpu",
        );
        let s: Vec<String> = args.iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert!(s.contains(&"-ng".to_string()));
        assert!(s.contains(&"-t".to_string()));
        let t_idx = s.iter().position(|x| x == "-t").unwrap();
        let n: u32 = s[t_idx + 1].parse().expect("threads is a number");
        assert!((1..=8).contains(&n), "thread count {} out of range", n);
    }

    #[test]
    fn build_args_includes_prompt_when_non_empty() {
        let args = build_whisper_args(
            std::path::Path::new("m.bin"),
            std::path::Path::new("a.wav"),
            "de",
            "Tauri whisper.cpp ggml",
            "cuda",
        );
        let s: Vec<String> = args.iter().map(|s| s.to_string_lossy().into_owned()).collect();
        let i = s.iter().position(|x| x == "--prompt").expect("--prompt present");
        assert_eq!(s[i + 1], "Tauri whisper.cpp ggml");
    }

    #[test]
    fn build_args_omits_prompt_when_empty() {
        let args = build_whisper_args(
            std::path::Path::new("m.bin"),
            std::path::Path::new("a.wav"),
            "auto",
            "   ",
            "cuda",
        );
        let s: Vec<String> = args.iter().map(|s| s.to_string_lossy().into_owned()).collect();
        assert!(!s.contains(&"--prompt".to_string()));
    }
}
