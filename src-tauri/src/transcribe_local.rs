use std::path::PathBuf;
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

pub async fn transcribe_local(
    app: &AppHandle,
    model_path: &PathBuf,
    audio_path: &PathBuf,
    gpu_backend: &str,
    language: &str,
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

    let mut cmd = Command::new(&exe);
    cmd.current_dir(&dir)
        .arg("-m")
        .arg(model_path)
        .arg("-f")
        .arg(audio_path)
        .args(["--no-timestamps", "-np", "-l", language]);
    if backend == "cpu" {
        cmd.arg("-ng");
    }
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
        // If cuda failed but auto was active, fall back to cpu and retry once.
        if backend == "cuda" && gpu_backend == "auto" {
            eprintln!(
                "[RudariFlow] cuda failed at runtime ({}). Retrying on cpu.",
                stderr.trim()
            );
            *AUTO_CACHED.lock().unwrap() = Some("cpu");
            return Box::pin(transcribe_local(app, model_path, audio_path, "cpu", language)).await;
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
}
