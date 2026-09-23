use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub percent: f64,
}

/// Download `url` to `dest`, emitting `event` with progress. The data goes to
/// `<dest>.part` first and is renamed when complete, so an interrupted
/// download never looks like a finished model.
pub async fn download_model(
    app: AppHandle,
    url: &str,
    dest: &PathBuf,
    event: &str,
) -> Result<(), String> {
    let part = part_path(dest);
    let result = download_to(&app, url, &part, event).await;
    match result {
        Ok(()) => std::fs::rename(&part, dest).map_err(|e| e.to_string()),
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

pub fn part_path(dest: &PathBuf) -> PathBuf {
    let mut name = dest.clone().into_os_string();
    name.push(".part");
    PathBuf::from(name)
}

async fn download_to(app: &AppHandle, url: &str, dest: &PathBuf, event: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);

    // Ensure parent directory exists
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    // At most ~10 progress events per second; per-chunk events would be
    // hundreds of thousands for a multi-GB model.
    let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);

    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        let done = total > 0 && downloaded >= total;
        if !done && last_emit.elapsed() < std::time::Duration::from_millis(100) {
            continue;
        }
        last_emit = std::time::Instant::now();
        let percent = if total > 0 {
            (downloaded as f64 / total as f64) * 100.0
        } else {
            0.0
        };

        let _ = app.emit(event, DownloadProgress {
            downloaded,
            total,
            percent,
        });
    }
    file.flush().map_err(|e| e.to_string())?;

    if total > 0 && downloaded != total {
        return Err(format!("Download incomplete ({} of {} bytes)", downloaded, total));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_file_sits_next_to_the_model() {
        let dest = PathBuf::from(r"C:\data\llm\gemma-4-E4B-it-Q4_K_M.gguf");
        assert_eq!(part_path(&dest), PathBuf::from(r"C:\data\llm\gemma-4-E4B-it-Q4_K_M.gguf.part"));
    }
}
