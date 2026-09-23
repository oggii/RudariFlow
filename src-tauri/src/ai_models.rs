//! Curated language models for AI cleanup. All are Apache-2.0 GGUF files on
//! Hugging Face that download without an account.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct AiModel {
    pub id: &'static str,
    pub label: &'static str,
    #[serde(skip)]
    pub repo: &'static str,
    pub file: &'static str,
    pub bytes: u64,
}

/// Picked by `examples/ai_bench.rs` on an RX 6800 (see the AI cleanup spec):
/// the Qwen models translated German or turned sentences into lists.
pub const MODELS: &[AiModel] = &[
    AiModel {
        id: "gemma-4-e4b",
        label: "Gemma 4 E4B",
        repo: "unsloth/gemma-4-E4B-it-GGUF",
        file: "gemma-4-E4B-it-Q4_K_M.gguf",
        bytes: 4_977_171_584,
    },
    AiModel {
        id: "gemma-4-12b",
        label: "Gemma 4 12B",
        repo: "unsloth/gemma-4-12b-it-GGUF",
        file: "gemma-4-12b-it-Q4_K_M.gguf",
        bytes: 7_121_861_440,
    },
    AiModel {
        id: "gemma-4-e2b",
        label: "Gemma 4 E2B",
        repo: "unsloth/gemma-4-E2B-it-GGUF",
        file: "gemma-4-E2B-it-Q4_K_M.gguf",
        bytes: 3_106_738_272,
    },
];

pub const DEFAULT_MODEL: &str = "gemma-4-e4b";

pub fn find(id: &str) -> Option<&'static AiModel> {
    MODELS.iter().find(|m| m.id == id)
}

/// Where a model lives: `<data folder>\llm\<file>`.
pub fn model_path(app_dir: &Path, model: &AiModel) -> PathBuf {
    app_dir.join("llm").join(model.file)
}

pub fn download_url(model: &AiModel) -> String {
    format!("https://huggingface.co/{}/resolve/main/{}", model.repo, model.file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_model_exists_and_ids_are_unique() {
        assert!(find(DEFAULT_MODEL).is_some());
        let mut ids: Vec<&str> = MODELS.iter().map(|m| m.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), MODELS.len());
    }

    #[test]
    fn paths_and_urls() {
        let m = find("gemma-4-e4b").unwrap();
        assert_eq!(
            download_url(m),
            "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf"
        );
        assert!(model_path(Path::new(r"C:\data"), m).ends_with(r"llm\gemma-4-E4B-it-Q4_K_M.gguf"));
    }
}
