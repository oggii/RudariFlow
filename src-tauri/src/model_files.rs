//! Downloaded model files that no setting uses (Engine tab, "Unused
//! models"): Whisper models (`ggml-*.bin` in the data folder) and AI models
//! with their drafters (`*.gguf` in `llm\`), and unfinished downloads of
//! either (`.part`) that no download is writing. Nothing is deleted on its
//! own; `delete` removes one file the user picked, and only one of this list.

use std::path::{Path, PathBuf};

use crate::ai_models;
use crate::whisper_engine::model_filename;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ModelFile {
    /// "whisper" or "ai".
    pub kind: &'static str,
    /// The file name, e.g. "ggml-large-v3-turbo.bin".
    pub file: String,
    pub bytes: u64,
    /// An unfinished download (".part"), which a new download of the same
    /// model would resume.
    pub partial: bool,
    /// The file has other hard links (e.g. a test data folder): deleting
    /// it here frees no disk space.
    #[serde(rename = "otherLinks")]
    pub other_links: bool,
}

pub const WHISPER: &str = "whisper";
pub const AI: &str = "ai";

fn folder(app_dir: &Path, kind: &str) -> Option<PathBuf> {
    match kind {
        WHISPER => Some(app_dir.to_path_buf()),
        AI => Some(app_dir.join("llm")),
        _ => None,
    }
}

const PART: &str = ".part";

/// A model file of `kind` by its name, or an unfinished download of one
/// (".part").
fn is_model_file(kind: &str, name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let lower = lower.strip_suffix(PART).unwrap_or(&lower);
    match kind {
        WHISPER => lower.starts_with("ggml-") && lower.ends_with(".bin"),
        AI => lower.ends_with(".gguf"),
        _ => false,
    }
}

/// The files the settings use: the Whisper model, and the AI model with its
/// drafter (whether AI cleanup is on or not: the Files tab's summary and a
/// meeting's notes use it either way).
fn is_part(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(PART)
}

fn in_use(kind: &str, whisper_model: &str, ai_model: &str) -> Vec<String> {
    match kind {
        WHISPER => vec![model_filename(whisper_model)],
        AI => ai_models::find(ai_model)
            .map(|m| vec![m.file.to_string(), m.draft_file.to_string()])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn unused_of(app_dir: &Path, kind: &'static str, whisper_model: &str, ai_model: &str) -> Vec<ModelFile> {
    let Some(dir) = folder(app_dir, kind) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let used = in_use(kind, whisper_model, ai_model);
    let mut files: Vec<ModelFile> = entries
        .flatten()
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            let file = entry.file_name().into_string().ok()?;
            let partial = is_part(&file);
            let unused = meta.is_file()
                && is_model_file(kind, &file)
                && !used.iter().any(|u| u.eq_ignore_ascii_case(&file))
                && !(partial && crate::downloader::downloading(&entry.path()));
            let other_links = unused && imp::links(&entry.path()) > 1;
            unused.then_some(ModelFile { kind, file, bytes: meta.len(), partial, other_links })
        })
        .collect();
    files.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.file.cmp(&b.file)));
    files
}

/// Downloaded model files the settings do not use, Whisper's first, the
/// largest first.
pub fn unused(app_dir: &Path, whisper_model: &str, ai_model: &str) -> Vec<ModelFile> {
    let mut files = unused_of(app_dir, WHISPER, whisper_model, ai_model);
    files.extend(unused_of(app_dir, AI, whisper_model, ai_model));
    files
}

/// A bare file name: no folder, no "..", nothing Windows reads as a path.
fn plain_name(file: &str) -> bool {
    !file.is_empty()
        && file != "."
        && file != ".."
        && !file.contains(['/', '\\', ':', '\0'])
        && Path::new(file).file_name().is_some_and(|n| n == file)
}

/// Delete one unused model file; returns the bytes freed. Refused for the
/// models the settings use and for anything that is not in `unused` (a
/// name with a folder in it, another kind of file).
pub fn delete(app_dir: &Path, whisper_model: &str, ai_model: &str, kind: &str, file: &str) -> Result<u64, String> {
    if !plain_name(file) {
        return Err(format!("'{}' is not a model file name", file));
    }
    let dir = folder(app_dir, kind).ok_or_else(|| format!("unknown model kind '{}'", kind))?;
    if in_use(kind, whisper_model, ai_model).iter().any(|u| u.eq_ignore_ascii_case(file)) {
        return Err("in_use".to_string());
    }
    let found = unused(app_dir, whisper_model, ai_model)
        .into_iter()
        .find(|m| m.kind == kind && m.file == file)
        .ok_or_else(|| format!("'{}' is not an unused model", file))?;
    let path = dir.join(&found.file);
    if path.parent() != Some(dir.as_path()) {
        return Err(format!("'{}' is not in the model folder", file));
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    if found.partial {
        // The resume tag of the part.
        let _ = std::fs::remove_file(crate::downloader::tag_path(&path));
    }
    Ok(found.bytes)
}

#[cfg(windows)]
mod imp {
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};

    /// How many hard links the file has; 1 when Windows does not say.
    pub fn links(path: &Path) -> u32 {
        let Ok(file) = std::fs::File::open(path) else { return 1 };
        // SAFETY: an open file's handle, valid while `file` lives, and a
        // struct the call fills.
        unsafe {
            let mut info = std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>();
            if GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) == 0 {
                return 1;
            }
            info.nNumberOfLinks.max(1)
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn links(_path: &std::path::Path) -> u32 {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A data folder with the Whisper models `whisper` and the AI files `ai`
    /// (each file holds as many bytes as its name is long).
    fn folder_with(name: &str, whisper: &[&str], ai: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("llm")).unwrap();
        for f in whisper {
            fs::write(dir.join(f), f.as_bytes()).unwrap();
        }
        for f in ai {
            fs::write(dir.join("llm").join(f), f.as_bytes()).unwrap();
        }
        dir
    }

    fn names(files: &[ModelFile]) -> Vec<(&str, &str)> {
        files.iter().map(|m| (m.kind, m.file.as_str())).collect()
    }

    const E4B: &str = "gemma-4-E4B-it-Q4_K_M.gguf";
    const E4B_DRAFT: &str = "mtp-gemma-4-E4B-it.gguf";
    const E2B: &str = "gemma-4-E2B-it-Q4_K_M.gguf";
    const E2B_DRAFT: &str = "mtp-gemma-4-E2B-it.gguf";

    #[test]
    fn lists_the_models_no_setting_uses() {
        let dir = folder_with(
            "rf_unused_models_list",
            &["ggml-large-v3-turbo.bin", "ggml-large-v3-turbo-q8_0.bin", "config.json"],
            &[E4B, E4B_DRAFT, E2B, E2B_DRAFT],
        );
        fs::create_dir_all(dir.join("ggml-folder.bin")).unwrap();
        let unused = unused(&dir, "large-v3-turbo-q8_0", "gemma-4-e4b");
        assert_eq!(
            names(&unused),
            vec![("whisper", "ggml-large-v3-turbo.bin"), ("ai", E2B), ("ai", E2B_DRAFT)],
            "not the models in use, folders or other files"
        );
        assert_eq!(unused[0].bytes, "ggml-large-v3-turbo.bin".len() as u64);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_ai_model_counts_as_used_with_ai_cleanup_off_and_unknown_files_are_listed() {
        let dir = folder_with("rf_unused_models_ai", &["ggml-small.bin"], &[E4B, E4B_DRAFT, "spike-IQ4_XS.gguf"]);
        assert_eq!(names(&unused(&dir, "small", "gemma-4-e4b")), vec![("ai", "spike-IQ4_XS.gguf")]);
        // No AI folder at all: nothing to list, no error.
        let _ = fs::remove_dir_all(dir.join("llm"));
        assert!(unused(&dir, "small", "gemma-4-e4b").is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_q5_model_is_a_whisper_model_like_the_others() {
        let dir = folder_with(
            "rf_unused_models_q5",
            &["ggml-large-v3-turbo-q8_0.bin", "ggml-large-v3-turbo-q5_0.bin"],
            &[E4B, E4B_DRAFT],
        );
        assert_eq!(names(&unused(&dir, "large-v3-turbo-q8_0", "gemma-4-e4b")), vec![("whisper", "ggml-large-v3-turbo-q5_0.bin")]);
        assert_eq!(names(&unused(&dir, "large-v3-turbo-q5_0", "gemma-4-e4b")), vec![("whisper", "ggml-large-v3-turbo-q8_0.bin")]);
        let in_use = delete(&dir, "large-v3-turbo-q5_0", "gemma-4-e4b", "whisper", "ggml-large-v3-turbo-q5_0.bin");
        assert_eq!(in_use, Err("in_use".to_string()));
        let freed = delete(&dir, "large-v3-turbo-q8_0", "gemma-4-e4b", "whisper", "ggml-large-v3-turbo-q5_0.bin");
        assert_eq!(freed, Ok("ggml-large-v3-turbo-q5_0.bin".len() as u64));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unfinished_downloads_are_listed_and_deleted_with_their_tag() {
        let dir = folder_with(
            "rf_unused_models_parts",
            &["ggml-small.bin", "ggml-medium.bin.part", "ggml-medium.bin.part.etag", "other.part"],
            &[E4B, E4B_DRAFT, "gemma-4-12b-it-Q4_K_M.gguf.part"],
        );
        let unused = unused(&dir, "small", "gemma-4-e4b");
        assert_eq!(
            names(&unused),
            vec![("whisper", "ggml-medium.bin.part"), ("ai", "gemma-4-12b-it-Q4_K_M.gguf.part")],
            "not the resume tag, not other files"
        );
        assert!(unused.iter().all(|m| m.partial));
        assert!(delete(&dir, "small", "gemma-4-e4b", "whisper", "ggml-medium.bin.part").is_ok());
        assert!(!dir.join("ggml-medium.bin.part").exists());
        assert!(!dir.join("ggml-medium.bin.part.etag").exists(), "its tag goes too");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_part_that_is_being_downloaded_is_left_alone() {
        // Only the downloader marks a part as active; one that is not
        // marked is a leftover.
        let dir = folder_with("rf_unused_models_active", &["ggml-small.bin", "ggml-base.bin.part"], &[E4B]);
        assert!(!crate::downloader::downloading(&dir.join("ggml-base.bin.part")));
        assert_eq!(names(&unused(&dir, "small", "gemma-4-e4b")), vec![("whisper", "ggml-base.bin.part")]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_model_with_other_hard_links_says_so() {
        let dir = folder_with("rf_unused_models_links", &["ggml-small.bin", "ggml-base.bin", "ggml-tiny.bin"], &[E4B]);
        let elsewhere = std::env::temp_dir().join("rf_unused_models_links_other.bin");
        let _ = fs::remove_file(&elsewhere);
        fs::hard_link(dir.join("ggml-base.bin"), &elsewhere).unwrap();
        let unused = unused(&dir, "small", "gemma-4-e4b");
        let base = unused.iter().find(|m| m.file == "ggml-base.bin").unwrap();
        let tiny = unused.iter().find(|m| m.file == "ggml-tiny.bin").unwrap();
        assert!(base.other_links, "deleting it frees no disk space");
        assert!(!tiny.other_links);
        assert!(!base.partial && !tiny.partial);
        let _ = fs::remove_file(&elsewhere);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn deletes_an_unused_model() {
        let dir = folder_with("rf_unused_models_delete", &["ggml-small.bin", "ggml-large-v3.bin"], &[E4B, E2B]);
        assert_eq!(delete(&dir, "small", "gemma-4-e4b", "whisper", "ggml-large-v3.bin"), Ok(17));
        assert!(!dir.join("ggml-large-v3.bin").exists());
        assert_eq!(delete(&dir, "small", "gemma-4-e4b", "ai", E2B), Ok(E2B.len() as u64));
        assert!(!dir.join("llm").join(E2B).exists());
        assert!(unused(&dir, "small", "gemma-4-e4b").is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_the_models_in_use() {
        let dir = folder_with("rf_unused_models_in_use", &["ggml-small.bin"], &[E4B, E4B_DRAFT]);
        assert_eq!(delete(&dir, "small", "gemma-4-e4b", "whisper", "ggml-small.bin"), Err("in_use".to_string()));
        assert_eq!(delete(&dir, "small", "gemma-4-e4b", "ai", E4B), Err("in_use".to_string()));
        assert_eq!(delete(&dir, "small", "gemma-4-e4b", "ai", E4B_DRAFT), Err("in_use".to_string()));
        assert!(dir.join("ggml-small.bin").exists() && dir.join("llm").join(E4B).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_anything_outside_the_model_folders() {
        let dir = folder_with("rf_unused_models_outside", &["ggml-small.bin", "ggml-base.bin"], &[E2B]);
        fs::write(dir.join("config.json"), "{}").unwrap();
        fs::write(dir.join("llm").join("ggml-base.bin"), "x").unwrap();
        let refused = [
            ("whisper", "config.json"),
            ("whisper", "../ggml-base.bin"),
            ("whisper", "..\\ggml-base.bin"),
            ("whisper", "llm\\ggml-base.bin"),
            ("whisper", "llm/ggml-base.bin"),
            ("whisper", "C:\\Windows\\ggml-base.bin"),
            ("whisper", "C:ggml-base.bin"),
            ("whisper", ".."),
            ("whisper", ""),
            ("ai", "../config.json"),
            ("ai", "ggml-base.bin"),
            ("ai", "..\\..\\" ),
            ("other", "ggml-base.bin"),
            ("whisper", "ggml-missing.bin"),
        ];
        for (kind, file) in refused {
            assert!(delete(&dir, "small", "gemma-4-e4b", kind, file).is_err(), "{} {}", kind, file);
        }
        assert!(dir.join("config.json").exists());
        assert!(dir.join("ggml-base.bin").exists());
        assert!(dir.join("llm").join("ggml-base.bin").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
