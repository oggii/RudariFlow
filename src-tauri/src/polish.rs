//! The text step after Whisper: AI cleanup when it is on, replacements
//! always. Shared by dictation, History re-runs and the settings test box.
//! Every failure falls back to the text without AI cleanup.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::ai_cleanup::{self, AppContext};
use crate::ai_models;
use crate::llm_server::LlmServer;
use crate::replacements::{apply_replacements, protect, restore, Protected};
use crate::settings::Settings;
use crate::startup_log;

/// How long a dictation waits for a model that is still loading.
const WAIT_FOR_MODEL: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Polished {
    /// What gets pasted.
    pub text: String,
    /// The text without AI cleanup, when the AI changed it.
    pub raw: Option<String>,
    /// Why AI cleanup did not run or its answer was discarded.
    pub fallback: Option<String>,
    /// Time spent in the AI step; 0 when it did not run.
    #[serde(rename = "aiMs")]
    pub ai_ms: u64,
}

impl Polished {
    fn plain(text: String, fallback: Option<&str>) -> Self {
        Self { text, raw: None, fallback: fallback.map(str::to_string), ai_ms: 0 }
    }
}

/// Swiss spelling on everything that is pasted or shown as the original.
fn finish(settings: &Settings, mut polished: Polished) -> Polished {
    if settings.swiss_spelling {
        polished.text = crate::dictionary::swiss_spelling(&polished.text);
        polished.raw = polished.raw.map(|raw| crate::dictionary::swiss_spelling(&raw));
    }
    polished
}

/// The system message of every dictation with these settings. It only
/// changes with the settings; the AI server keeps it in its prompt cache
/// (`LlmServer::set_warm_prompt`), so a dictation only computes its own part.
pub fn system_prompt(settings: &Settings) -> String {
    let dictionary = crate::dictionary::terms(&settings.custom_prompt);
    let target = crate::whisper_engine::language_name(&settings.ai_output_language);
    ai_cleanup::build_messages(
        &settings.ai_style,
        &settings.ai_instructions,
        &dictionary,
        &[],
        &AppContext::default(),
        None,
        target.as_deref(),
        "",
    )
    .0
}

/// `text` is Whisper's text after capitalisation and "send it" stripping.
/// `language` is the language Whisper heard (English name); without it, it
/// is detected from the text. `on_ai_start` runs right before the model is
/// asked (overlay state).
pub async fn polish(
    settings: &Settings,
    app_dir: &Path,
    llm: &Arc<LlmServer>,
    ctx: &AppContext,
    text: &str,
    language: Option<&str>,
    on_ai_start: impl FnOnce(),
) -> Polished {
    let polished = polish_inner(settings, app_dir, llm, ctx, text, language, on_ai_start).await;
    finish(settings, polished)
}

async fn polish_inner(
    settings: &Settings,
    app_dir: &Path,
    llm: &Arc<LlmServer>,
    ctx: &AppContext,
    text: &str,
    language: Option<&str>,
    on_ai_start: impl FnOnce(),
) -> Polished {
    let plain = apply_replacements(text, &settings.replacements);
    if !settings.ai_cleanup || text.trim().is_empty() {
        return Polished::plain(plain, None);
    }
    if ai_cleanup::ai_disabled_for(&settings.ai_rules, ctx) {
        return Polished::plain(plain, Some("AI is off for this app"));
    }
    let Some(model) = ai_models::find(&settings.ai_model) else {
        return Polished::plain(plain, Some("Unknown AI model"));
    };
    let model_path = ai_models::model_path(app_dir, model);
    if !model_path.exists() {
        return Polished::plain(plain, Some("The AI model is not downloaded"));
    }
    let (protected, values) = match protect(text, &settings.replacements) {
        Protected::Whole(replacement) => return Polished::plain(replacement, None),
        Protected::Text { text, values } => (text, values),
    };

    on_ai_start();
    let started = Instant::now();
    let result: Result<String, String> = async {
        let endpoint = llm
            .wait_ready(&model_path, Some(settings.gpu_backend.clone()), WAIT_FOR_MODEL)
            .await?;
        let rules = ai_cleanup::matching_rules(&settings.ai_rules, ctx);
        let language = language.map(str::to_string).or_else(|| ai_cleanup::detect_language(&protected));
        let dictionary = crate::dictionary::terms(&settings.custom_prompt);
        let target = crate::whisper_engine::language_name(&settings.ai_output_language);
        let (system, user) = ai_cleanup::build_messages(
            &settings.ai_style,
            &settings.ai_instructions,
            &dictionary,
            &rules,
            ctx,
            language.as_deref(),
            target.as_deref(),
            &protected,
        );
        let (temperature, max_tokens) = ai_cleanup::sampling(&settings.ai_style, &protected);
        let timeout = ai_cleanup::request_timeout(&protected, max_tokens, endpoint.on_cpu, llm.speed());
        let answer = ai_cleanup::complete(&endpoint, &system, &user, temperature, max_tokens, timeout)
            .await
            .inspect_err(|e| {
                if e.starts_with(ai_cleanup::UNREACHABLE) {
                    llm.request_failed(model_path.clone(), Some(settings.gpu_backend.clone()));
                } else if e == ai_cleanup::TIMED_OUT {
                    llm.note_timeout();
                }
            })?;
        llm.note_speed(answer.speed);
        ai_cleanup::guard(&protected, &answer.text, values.len(), target.as_deref()).map_err(str::to_string)
    }
    .await;
    let ai_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(cleaned) => {
            let text = restore(&cleaned, &values);
            startup_log::log(&format!("[ai] cleaned in {} ms (app '{}')", ai_ms, ctx.exe));
            let raw = (text != plain).then_some(plain);
            Polished { text, raw, fallback: None, ai_ms }
        }
        Err(reason) => {
            startup_log::log(&format!("[ai] fallback after {} ms: {}", ai_ms, reason));
            Polished { text: plain, raw: None, fallback: Some(reason), ai_ms }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_cleanup::AppRule;
    use crate::replacements::Replacement;
    use std::path::PathBuf;

    fn setup(name: &str) -> (PathBuf, Arc<LlmServer>, Settings) {
        let dir = std::env::temp_dir().join(format!("rudariflow_polish_{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // No llama-server in this folder: any start fails.
        let llm = Arc::new(LlmServer::new(dir.join("llama"), dir.join("llm-server.log"), Box::new(|_| {})));
        let mut settings = Settings::default();
        settings.replacements = vec![Replacement { from: "my email".into(), to: "info@0ggi.ch".into() }];
        (dir, llm, settings)
    }

    fn run(settings: &Settings, dir: &Path, llm: &Arc<LlmServer>, ctx: &AppContext, text: &str) -> (Polished, bool) {
        let mut asked = false;
        let result = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(polish(settings, dir, llm, ctx, text, None, || asked = true));
        (result, asked)
    }

    #[test]
    fn warm_prompt_matches_the_system_prompt_of_a_dictation() {
        let mut settings = Settings::default();
        settings.custom_prompt = "Grüssen-Shop, GitHub".into();
        settings.ai_instructions = "Use ss instead of ß.".into();
        settings.ai_output_language = "en".into();
        settings.ai_style = "light".into();
        let rule = AppRule { app: "code".into(), instructions: "short".into(), off: false };
        let ctx = AppContext {
            exe: "code".into(),
            title: "main.rs".into(),
            screen_terms: vec!["Yılmaz".into()],
        };
        let (system, _) = ai_cleanup::build_messages(
            &settings.ai_style,
            &settings.ai_instructions,
            &crate::dictionary::terms(&settings.custom_prompt),
            &[&rule],
            &ctx,
            Some("German"),
            Some("English"),
            "hallo zusammen",
        );
        assert_eq!(system_prompt(&settings), system);
    }

    #[test]
    fn off_applies_replacements_only() {
        let (dir, llm, settings) = setup("off");
        let (p, asked) = run(&settings, &dir, &llm, &AppContext::default(), "Write to my email.");
        assert_eq!(p, Polished::plain("Write to info@0ggi.ch.".into(), None));
        assert!(!asked);
    }

    #[test]
    fn no_ai_rule_and_missing_model_fall_back() {
        let (dir, llm, mut settings) = setup("skip");
        settings.ai_cleanup = true;
        settings.ai_rules = vec![AppRule { app: "code".into(), instructions: String::new(), off: true }];
        let code = AppContext { exe: "code".into(), title: "main.rs".into(), ..Default::default() };
        let (p, asked) = run(&settings, &dir, &llm, &code, "hello");
        assert_eq!(p.fallback.as_deref(), Some("AI is off for this app"));
        assert!(!asked);

        let (p, _) = run(&settings, &dir, &llm, &AppContext::default(), "hello");
        assert_eq!(p.text, "hello");
        assert_eq!(p.fallback.as_deref(), Some("The AI model is not downloaded"));
    }

    #[test]
    fn swiss_spelling_applies_without_ai() {
        let (dir, llm, mut settings) = setup("swiss");
        settings.swiss_spelling = true;
        let (p, _) = run(&settings, &dir, &llm, &AppContext::default(), "Grüße, ich weiß es.");
        assert_eq!(p.text, "Grüsse, ich weiss es.");
    }

    #[test]
    fn whole_trigger_skips_the_model() {
        let (dir, llm, mut settings) = setup("whole");
        settings.ai_cleanup = true;
        let model = ai_models::find(&settings.ai_model).unwrap();
        std::fs::create_dir_all(dir.join("llm")).unwrap();
        std::fs::write(ai_models::model_path(&dir, model), b"not a model").unwrap();
        let (p, asked) = run(&settings, &dir, &llm, &AppContext::default(), "My email.");
        assert_eq!(p.text, "info@0ggi.ch");
        assert!(!asked);
    }

    #[test]
    fn server_failure_pastes_plain_text() {
        let (dir, llm, mut settings) = setup("fail");
        settings.ai_cleanup = true;
        let model = ai_models::find(&settings.ai_model).unwrap();
        std::fs::create_dir_all(dir.join("llm")).unwrap();
        std::fs::write(ai_models::model_path(&dir, model), b"not a model").unwrap();
        let started = Instant::now();
        let (p, asked) = run(&settings, &dir, &llm, &AppContext::default(), "Send it to my email today.");
        assert!(asked);
        assert_eq!(p.text, "Send it to info@0ggi.ch today.");
        assert!(p.fallback.unwrap().contains("llama-server not found"));
        assert!(started.elapsed() < WAIT_FOR_MODEL, "a failed start must not wait the full budget");
    }
}
