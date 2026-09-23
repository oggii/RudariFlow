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
pub fn read() -> Target {
    for attempt in 1..=WAKE_UP_TRIES {
        let Some(info) = read_focus() else {
            return Target::None("no focused element");
        };
        if attempt < WAKE_UP_TRIES && chromium_waking_up(&info) {
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

#[cfg(windows)]
mod imp {
    use super::FocusInfo;
    use windows::Win32::UI::Accessibility::{
        IUIAutomationTextPattern, IUIAutomationValuePattern, UIA_TextPatternId, UIA_ValuePatternId,
    };

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
    fn newlines_and_words() {
        assert_eq!(normalize_newlines("a\rb\r\nc\nd"), "a\nb\nc\nd");
        assert_eq!(word_count("Hi Anna, the meeting\nmoved."), 5);
    }
}
