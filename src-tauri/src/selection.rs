//! The text selected in the focused app, read through UI Automation, for
//! Edit mode. Only apps that expose their text this way take part: nothing is
//! copied and no keys are sent, so a terminal can never get a Ctrl+C.

/// Longer selections are dictated over, like in Aqua Voice.
pub const MAX_CHARS: usize = 6000;

/// What UI Automation reports about the focused element.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FocusInfo {
    /// UIA control type id: 50004 Edit, 50030 Document, 50020 Text, ...
    pub control_type: i32,
    pub class_name: String,
    pub name: String,
    pub automation_id: String,
    /// UI framework: "Chrome" for Chromium browsers, Electron and WebView2.
    pub framework: String,
    /// Executable name without ".exe", lower-case.
    pub exe: String,
    pub password: bool,
    /// From the value pattern, when the element has one.
    pub read_only: Option<bool>,
    /// `None` when the element has no text pattern.
    pub selection: Option<String>,
}

const CONTROL_EDIT: i32 = 50004;
const CONTROL_DOCUMENT: i32 = 50030;

/// Programs whose text field is a command line; pasting a rewrite there
/// could run it.
const TERMINALS: &[&str] = &[
    "windowsterminal", "cmd", "powershell", "pwsh", "conhost", "openconsole", "wezterm-gui",
    "alacritty", "mintty", "putty", "kitty", "tabby", "hyper", "warp",
];

/// Words in a field's name or id that mark address and search bars. Clicking
/// into those selects their text, and the user wants to type over it.
const ADDRESS_OR_SEARCH: &[&str] = &["search", "suche", "suchleiste", "address", "adress", "url", "omnibox"];

/// The selection Edit mode works on, or why there is none.
#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    Selected(String),
    None(&'static str),
}

impl Target {
    pub fn selected(&self) -> Option<&str> {
        match self {
            Target::Selected(text) => Some(text),
            Target::None(_) => None,
        }
    }
}

/// Whether Edit mode applies to the focused element.
pub fn decide(info: &FocusInfo) -> Target {
    let class = info.class_name.to_lowercase();
    let name = info.name.to_lowercase();
    let id = info.automation_id.to_lowercase();
    if info.password {
        return Target::None("password field");
    }
    if TERMINALS.contains(&info.exe.as_str()) || class.contains("termcontrol") || class.contains("xterm") {
        return Target::None("terminal");
    }
    if class.contains("omnibox") || ADDRESS_OR_SEARCH.iter().any(|w| name.contains(w) || id.contains(w)) {
        return Target::None("address or search field");
    }
    let editable = match info.control_type {
        CONTROL_EDIT => true,
        // A web page's document (Chromium: "RootWebArea") is not editable;
        // Notepad's and Word's documents are.
        CONTROL_DOCUMENT => info.automation_id != "RootWebArea",
        _ => false,
    };
    if !editable || info.read_only == Some(true) {
        return Target::None("not an editable text field");
    }
    let Some(selection) = &info.selection else {
        return Target::None("the app does not expose its text");
    };
    if selection.trim().is_empty() {
        return Target::None("nothing selected");
    }
    if selection.chars().count() > MAX_CHARS {
        return Target::None("selection too long");
    }
    Target::Selected(selection.clone())
}

/// Line breaks as `\n`; RichEdit (Notepad) reports `\r`.
pub fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Words in a selection, for the overlay chip.
pub fn word_count(text: &str) -> usize {
    text.split_whitespace().count()
}

/// The focused element and its selection. Blocking; takes a few ms, at most
/// about half a second when the app does not answer.
pub fn read_focus() -> Option<FocusInfo> {
    imp::read_focus()
}

/// Chromium turns its accessibility on at the first request and then
/// reports only a container or the page as focused for a moment; the text
/// field shows up a few hundred ms later.
pub fn chromium_waking_up(info: &FocusInfo) -> bool {
    info.framework == "Chrome"
        && info.control_type != CONTROL_EDIT
        && (info.selection.is_none() || info.automation_id == "RootWebArea")
}

const WAKE_UP_TRIES: usize = 4;
const WAKE_UP_PAUSE: std::time::Duration = std::time::Duration::from_millis(150);

/// `decide(read_focus())`, with the selection's line breaks normalised.
/// Waits up to 450 ms for Chromium's accessibility to wake up, so use it
/// where the time is hidden: when the hotkey is pressed.
pub fn read() -> Target {
    read_tries(WAKE_UP_TRIES)
}

/// One read without waiting for Chromium, for the hotkey release: the read
/// at the press has woken it up already, and waiting cost every dictation
/// into a web page without a focused text field 450 ms.
pub fn read_now() -> Target {
    read_tries(1)
}

fn read_tries(tries: usize) -> Target {
    for attempt in 1..=tries {
        let Some(info) = read_focus() else {
            return Target::None("no focused element");
        };
        if attempt < tries && chromium_waking_up(&info) {
            std::thread::sleep(WAKE_UP_PAUSE);
            continue;
        }
        return match decide(&info) {
            Target::Selected(text) => Target::Selected(normalize_newlines(&text)),
            none => none,
        };
    }
    Target::None("no focused element")
}

/// Field text read to see what the user corrected after a dictation.
pub const MAX_FIELD_CHARS: usize = 20_000;

/// The focused field's program and text, to learn from what the user
/// corrected after a dictation. Only the fields Edit mode works in: no
/// terminals, address or search bars, password fields or web pages.
pub fn read_field() -> Option<(String, String)> {
    let info = read_focus()?;
    let probe = FocusInfo { selection: Some("x".into()), ..info };
    if decide(&probe) != Target::Selected("x".into()) {
        return None;
    }
    let text = imp::field_text(MAX_FIELD_CHARS)?;
    Some((probe.exe, normalize_newlines(&text)))
}

/// Why "rewrite last" did not find the last dictation to work on.
pub const NOT_FOUND: &str = "the last dictation is not in this field";

/// "Rewrite last": select `text` (the last dictation) in the focused field,
/// searching from the end, so the dictation that follows edits it like a
/// selection in Edit mode. The same fields are excluded as for Edit mode;
/// nothing changes when the text is not there (edited since, or another
/// field).
pub fn select_last(text: &str) -> Target {
    let text = text.trim();
    if text.is_empty() {
        return Target::None("nothing dictated yet");
    }
    let Some(info) = read_focus() else {
        return Target::None("no focused element");
    };
    if info.selection.is_none() {
        return Target::None("the app does not expose its text");
    }
    // Edit mode's rules, with the selection still to be made.
    let probe = FocusInfo { selection: Some(text.to_string()), ..info };
    if let Target::None(reason) = decide(&probe) {
        return Target::None(reason);
    }
    if imp::find_and_select(&line_break_variants(text)) {
        Target::Selected(text.to_string())
    } else {
        Target::None(NOT_FOUND)
    }
}

/// The text as it may sit in a field: `\n` as pasted, `\r` in RichEdit
/// (Notepad), `\r\n` elsewhere.
fn line_break_variants(text: &str) -> Vec<String> {
    let mut out = vec![text.to_string()];
    for variant in [text.replace('\n', "\r"), text.replace('\n', "\r\n")] {
        if !out.contains(&variant) {
            out.push(variant);
        }
    }
    out
}

#[cfg(windows)]
mod imp {
    use super::FocusInfo;
    use windows::core::BSTR;
    use windows::Win32::UI::Accessibility::{
        IUIAutomationTextPattern, IUIAutomationValuePattern, UIA_TextPatternId, UIA_ValuePatternId,
    };

    /// Select the last occurrence of the first variant found in the
    /// focused element's text.
    pub fn find_and_select(variants: &[String]) -> bool {
        let Some(uia) = crate::uia::automation() else { return false };
        unsafe {
            let Ok(el) = uia.GetFocusedElement() else { return false };
            let Ok(pattern) = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) else {
                return false;
            };
            let Ok(document) = pattern.DocumentRange() else { return false };
            for variant in variants {
                if let Ok(found) = document.FindText(&BSTR::from(variant.as_str()), true, false) {
                    return found.Select().is_ok();
                }
            }
            false
        }
    }

    /// The focused element's whole text (up to `max` characters).
    pub fn field_text(max: usize) -> Option<String> {
        let uia = crate::uia::automation()?;
        unsafe {
            let el = uia.GetFocusedElement().ok()?;
            if let Ok(pattern) = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
                if let Ok(text) = pattern.DocumentRange().and_then(|r| r.GetText(max as i32)) {
                    return Some(text.to_string());
                }
            }
            let value = el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).ok()?;
            value.CurrentValue().ok().map(|b| b.to_string())
        }
    }

    pub fn read_focus() -> Option<FocusInfo> {
        let uia = crate::uia::automation()?;
        unsafe {
            let el = uia.GetFocusedElement().ok()?;
            let pid = el.CurrentProcessId().unwrap_or(0) as u32;
            let mut info = FocusInfo {
                control_type: el.CurrentControlType().map(|c| c.0).unwrap_or(0),
                class_name: el.CurrentClassName().map(|b| b.to_string()).unwrap_or_default(),
                name: el.CurrentName().map(|b| b.to_string()).unwrap_or_default(),
                automation_id: el.CurrentAutomationId().map(|b| b.to_string()).unwrap_or_default(),
                framework: el.CurrentFrameworkId().map(|b| b.to_string()).unwrap_or_default(),
                exe: crate::foreground_app::process_name(pid),
                password: el.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false),
                read_only: None,
                selection: None,
            };
            if let Ok(value) = el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
                info.read_only = value.CurrentIsReadOnly().ok().map(|b| b.as_bool());
            }
            if let Ok(text) = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
                let mut selected = String::new();
                if let Ok(ranges) = text.GetSelection() {
                    for i in 0..ranges.Length().unwrap_or(0) {
                        if let Ok(range) = ranges.GetElement(i) {
                            // One more than the limit is enough to know it is too long.
                            let limit = (super::MAX_CHARS + 1) as i32;
                            selected.push_str(&range.GetText(limit).map(|b| b.to_string()).unwrap_or_default());
                        }
                    }
                }
                info.selection = Some(selected);
            }
            Some(info)
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn read_focus() -> Option<super::FocusInfo> {
        None
    }

    pub fn find_and_select(_variants: &[String]) -> bool {
        false
    }

    pub fn field_text(_max: usize) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(exe: &str, control_type: i32, selection: Option<&str>) -> FocusInfo {
        FocusInfo { control_type, exe: exe.into(), selection: selection.map(str::to_string), ..Default::default() }
    }

    #[test]
    fn selections_in_editable_fields_count() {
        let notepad =
            FocusInfo { class_name: "RichEditD2DPT".into(), ..field("notepad", CONTROL_DOCUMENT, Some("Hello Mister")) };
        assert_eq!(decide(&notepad), Target::Selected("Hello Mister".into()));
        let chat = FocusInfo { name: "Message input".into(), ..field("code", CONTROL_EDIT, Some("ok see you")) };
        assert_eq!(decide(&chat), Target::Selected("ok see you".into()));
    }

    #[test]
    fn nothing_selected_or_no_text_access_means_dictation() {
        assert_eq!(decide(&field("notepad", CONTROL_EDIT, Some(""))), Target::None("nothing selected"));
        assert_eq!(decide(&field("notepad", CONTROL_EDIT, Some(" \r"))), Target::None("nothing selected"));
        assert_eq!(decide(&field("legacy", CONTROL_EDIT, None)), Target::None("the app does not expose its text"));
        let long = "a".repeat(MAX_CHARS + 1);
        assert_eq!(decide(&field("notepad", CONTROL_EDIT, Some(&long))), Target::None("selection too long"));
    }

    #[test]
    fn terminals_address_bars_passwords_and_pages_are_excluded() {
        let terminal = FocusInfo { class_name: "TermControl".into(), ..field("windowsterminal", 50020, Some("ls")) };
        assert_eq!(decide(&terminal), Target::None("terminal"));
        let vscode_terminal =
            FocusInfo { class_name: "xterm-helper-textarea".into(), ..field("code", CONTROL_EDIT, Some("npm run")) };
        assert_eq!(decide(&vscode_terminal), Target::None("terminal"));
        let omnibox = FocusInfo {
            class_name: "BraveOmniboxViewViews".into(),
            name: "Adress- und Suchleiste".into(),
            ..field("brave", CONTROL_EDIT, Some("https://example.com"))
        };
        assert_eq!(decide(&omnibox), Target::None("address or search field"));
        let search = FocusInfo { name: "Search mail".into(), ..field("olk", CONTROL_EDIT, Some("invoice")) };
        assert_eq!(decide(&search), Target::None("address or search field"));
        let password = FocusInfo { password: true, ..field("brave", CONTROL_EDIT, Some("secret")) };
        assert_eq!(decide(&password), Target::None("password field"));
        let page =
            FocusInfo { automation_id: "RootWebArea".into(), ..field("brave", CONTROL_DOCUMENT, Some("page text")) };
        assert_eq!(decide(&page), Target::None("not an editable text field"));
        let read_only = FocusInfo { read_only: Some(true), ..field("brave", CONTROL_EDIT, Some("text")) };
        assert_eq!(decide(&read_only), Target::None("not an editable text field"));
        assert_eq!(decide(&field("explorer", 50000, Some("x"))), Target::None("not an editable text field"));
    }

    #[test]
    fn chromium_container_or_page_means_wait() {
        let chrome = |control_type, id: &str, selection: Option<&str>| FocusInfo {
            framework: "Chrome".into(),
            automation_id: id.into(),
            ..field("brave", control_type, selection)
        };
        assert!(chromium_waking_up(&chrome(50033, "", None)));
        assert!(chromium_waking_up(&chrome(CONTROL_DOCUMENT, "RootWebArea", Some(""))));
        assert!(!chromium_waking_up(&chrome(CONTROL_EDIT, "ta", Some(""))));
        assert!(!chromium_waking_up(&field("notepad", CONTROL_DOCUMENT, Some(""))));
    }

    #[test]
    fn last_dictation_is_searched_with_each_line_break_style() {
        assert_eq!(line_break_variants("one line"), vec!["one line".to_string()]);
        assert_eq!(
            line_break_variants("Hi Anna,\nsee you."),
            vec![
                "Hi Anna,\nsee you.".to_string(),
                "Hi Anna,\rsee you.".to_string(),
                "Hi Anna,\r\nsee you.".to_string()
            ]
        );
    }

    #[test]
    fn newlines_and_words() {
        assert_eq!(normalize_newlines("a\rb\r\nc\nd"), "a\nb\nc\nd");
        assert_eq!(word_count("Hi Anna, the meeting\nmoved."), 5);
    }
}
