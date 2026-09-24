use std::io::Write;
use std::path::PathBuf;

use reqwest::header::{CONTENT_RANGE, ETAG, IF_RANGE, RANGE};
use reqwest::StatusCode;
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub percent: f64,
}

/// Download `url` to `dest`, emitting `event` with progress.
pub async fn download_model(
    app: AppHandle,
    url: &str,
    dest: &PathBuf,
    event: &str,
) -> Result<(), String> {
    download_file(url, dest, |progress| {
        let _ = app.emit(event, progress);
    })
    .await
}

/// Download `url` to `dest`. The data goes to `<dest>.part` first and is
/// renamed when complete, so an interrupted download never looks like a
/// finished model. The part stays after an error, and the next try goes on
/// where it stopped instead of fetching gigabytes again.
pub async fn download_file(
    url: &str,
    dest: &PathBuf,
    mut on_progress: impl FnMut(DownloadProgress),
) -> Result<(), String> {
    let part = part_path(dest);
    // The server may not resume (or the file changed since): start over once.
    if download_to(url, &part, &mut on_progress).await? == Outcome::StartOver {
        let _ = std::fs::remove_file(&part);
        let _ = std::fs::remove_file(tag_path(&part));
        if download_to(url, &part, &mut on_progress).await? == Outcome::StartOver {
            return Err("The server did not send the file; please try again".to_string());
        }
    }
    std::fs::rename(&part, dest).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(tag_path(&part));
    Ok(())
}

pub fn part_path(dest: &PathBuf) -> PathBuf {
    let mut name = dest.clone().into_os_string();
    name.push(".part");
    PathBuf::from(name)
}

/// The server's ETag of the file a part belongs to: a resume only continues
/// the same file (If-Range).
fn tag_path(part: &PathBuf) -> PathBuf {
    let mut name = part.clone().into_os_string();
    name.push(".etag");
    PathBuf::from(name)
}

#[derive(Debug, PartialEq)]
enum Outcome {
    Complete,
    StartOver,
}

/// The first byte of a `Content-Range: bytes 100-999/1000` answer and the
/// full size, if given.
pub(crate) fn parse_content_range(value: &str) -> Option<(u64, Option<u64>)> {
    let rest = value.trim().strip_prefix("bytes ")?;
    let (range, total) = rest.split_once('/')?;
    let start = range.split_once('-')?.0.trim().parse().ok()?;
    Some((start, total.trim().parse().ok()))
}

async fn download_to(
    url: &str,
    part: &PathBuf,
    on_progress: &mut impl FnMut(DownloadProgress),
) -> Result<Outcome, String> {
    if let Some(parent) = part.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let have = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    let etag = std::fs::read_to_string(tag_path(part)).ok().filter(|t| !t.trim().is_empty());

    let client = reqwest::Client::new();
    let mut request = client.get(url);
    if let (true, Some(tag)) = (have > 0, &etag) {
        request = request.header(RANGE, format!("bytes={}-", have)).header(IF_RANGE, tag.trim());
    }
    let response = request.send().await.map_err(|e| format!("Download request failed: {}", e))?;
    let status = response.status();
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        return Ok(Outcome::StartOver);
    }
    if !status.is_success() {
        return Err(format!("Download failed with status: {}", status));
    }

    let resumed = status == StatusCode::PARTIAL_CONTENT;
    let (mut downloaded, total) = if resumed {
        let range = response.headers().get(CONTENT_RANGE).and_then(|v| v.to_str().ok()).and_then(parse_content_range);
        match range {
            Some((start, total)) if start == have => {
                (have, total.unwrap_or(have + response.content_length().unwrap_or(0)))
            }
            _ => return Ok(Outcome::StartOver),
        }
    } else {
        // A full answer: no part yet, no resume support, or the file changed.
        let tag = response.headers().get(ETAG).and_then(|v| v.to_str().ok()).unwrap_or("");
        let _ = std::fs::write(tag_path(part), tag);
        (0, response.content_length().unwrap_or(0))
    };

    let mut file = if resumed {
        std::fs::OpenOptions::new().append(true).open(part)
    } else {
        std::fs::File::create(part)
    }
    .map_err(|e| e.to_string())?;
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
        on_progress(DownloadProgress {
            downloaded,
            total,
            percent,
        });
    }
    file.flush().map_err(|e| e.to_string())?;

    if total > 0 && downloaded != total {
        return Err(format!("Download incomplete ({} of {} bytes)", downloaded, total));
    }
    Ok(Outcome::Complete)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_file_sits_next_to_the_model() {
        let dest = PathBuf::from(r"C:\data\llm\gemma-4-E4B-it-Q4_K_M.gguf");
        assert_eq!(part_path(&dest), PathBuf::from(r"C:\data\llm\gemma-4-E4B-it-Q4_K_M.gguf.part"));
        assert_eq!(tag_path(&part_path(&dest)), PathBuf::from(r"C:\data\llm\gemma-4-E4B-it-Q4_K_M.gguf.part.etag"));
    }

    #[test]
    fn content_range_gives_start_and_size() {
        assert_eq!(parse_content_range("bytes 5242880-77691712/77691713"), Some((5_242_880, Some(77_691_713))));
        assert_eq!(parse_content_range("bytes 0-99/*"), Some((0, None)));
        assert_eq!(parse_content_range("items 0-9/10"), None);
    }
}
