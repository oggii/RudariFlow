use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub async fn transcribe_local(
    app: &AppHandle,
    model_path: &PathBuf,
    audio_path: &PathBuf,
    use_gpu: bool,
    language: &str,
) -> Result<String, String> {
    if !model_path.exists() {
        return Err("Whisper model not found. Please download a model first.".to_string());
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource dir: {}", e))?;
    let whisper_dir = resource_dir.join("binaries").join("whisper");
    let whisper_exe = whisper_dir.join("whisper-cli.exe");

    if !whisper_exe.exists() {
        return Err(format!(
            "whisper-cli.exe not found at {:?}. Bundle integrity error.",
            whisper_exe
        ));
    }

    println!(
        "[RudariFlow] Running whisper-cli with model {:?} (gpu={})",
        model_path, use_gpu
    );

    let mut cmd = Command::new(&whisper_exe);
    cmd.current_dir(&whisper_dir)
        .arg("-m")
        .arg(model_path)
        .arg("-f")
        .arg(audio_path)
        .args(["--no-timestamps", "-np", "-l", language]);
    if !use_gpu {
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
        assert_eq!(
            model_download_url("large-v3-turbo"),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
        );
    }
}
