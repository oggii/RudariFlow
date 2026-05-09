use reqwest::multipart;
use std::path::PathBuf;

/// Build the non-file form fields for the Groq request as `(key, value)` pairs.
/// Pure function for testability; the multipart::Form is opaque.
pub(crate) fn groq_text_fields(language: &str, custom_prompt: &str) -> Vec<(&'static str, String)> {
    let mut fields: Vec<(&'static str, String)> = Vec::with_capacity(4);
    fields.push(("model", "whisper-large-v3-turbo".to_string()));
    fields.push(("response_format", "json".to_string()));
    if language != "auto" && !language.is_empty() {
        fields.push(("language", language.to_string()));
    }
    let trimmed_prompt = custom_prompt.trim();
    if !trimmed_prompt.is_empty() {
        fields.push(("prompt", trimmed_prompt.to_string()));
    }
    fields
}

pub async fn transcribe_groq(
    api_key: &str,
    audio_path: &PathBuf,
    language: &str,
    custom_prompt: &str,
) -> Result<String, String> {
    if api_key.is_empty() {
        return Err("Groq API key not set. Please enter your API key in settings.".to_string());
    }

    let audio_bytes = std::fs::read(audio_path)
        .map_err(|e| format!("Failed to read audio file: {}", e))?;

    let file_part = multipart::Part::bytes(audio_bytes)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;

    let mut form = multipart::Form::new().part("file", file_part);
    for (k, v) in groq_text_fields(language, custom_prompt) {
        form = form.text(k, v);
    }

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.groq.com/openai/v1/audio/transcriptions")
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Groq API request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Groq API error ({}): {}", status, body));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Groq response: {}", e))?;

    json["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or("No 'text' field in Groq response".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_empty_api_key() {
        let path = PathBuf::from("/tmp/test.wav");
        let result = transcribe_groq("", &path, "en", "").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("API key not set"));
    }

    #[test]
    fn groq_text_fields_auto_omits_language() {
        let fields = groq_text_fields("auto", "");
        assert!(fields.iter().any(|(k, v)| *k == "model" && v == "whisper-large-v3-turbo"));
        assert!(!fields.iter().any(|(k, _)| *k == "language"));
        assert!(!fields.iter().any(|(k, _)| *k == "prompt"));
    }

    #[test]
    fn groq_text_fields_explicit_language_passes_through() {
        let fields = groq_text_fields("de", "");
        assert!(fields.iter().any(|(k, v)| *k == "language" && v == "de"));
    }

    #[test]
    fn groq_text_fields_includes_prompt_when_non_empty() {
        let fields = groq_text_fields("en", "Tauri whisper.cpp");
        assert!(fields.iter().any(|(k, v)| *k == "prompt" && v == "Tauri whisper.cpp"));
    }

    #[test]
    fn groq_text_fields_omits_blank_prompt() {
        let fields = groq_text_fields("en", "   ");
        assert!(!fields.iter().any(|(k, _)| *k == "prompt"));
    }

    #[test]
    fn groq_text_fields_always_sets_response_format() {
        let fields = groq_text_fields("auto", "");
        assert!(fields.iter().any(|(k, v)| *k == "response_format" && v == "json"));
    }
}
