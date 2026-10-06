// Every language Whisper can transcribe (whisper.cpp's language table).
// Names come from the browser's Intl data, so they follow the UI language.
const WHISPER_LANGUAGES = [
  "af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo", "br", "bs", "ca",
  "cs", "cy", "da", "de", "el", "en", "es", "et", "eu", "fa", "fi", "fo", "fr",
  "gl", "gu", "ha", "haw", "he", "hi", "hr", "ht", "hu", "hy", "id", "is", "it",
  "ja", "jw", "ka", "kk", "km", "kn", "ko", "la", "lb", "ln", "lo", "lt", "lv",
  "mg", "mi", "mk", "ml", "mn", "mr", "ms", "mt", "my", "ne", "nl", "nn", "no",
  "oc", "pa", "pl", "ps", "pt", "ro", "ru", "sa", "sd", "si", "sk", "sl", "sn",
  "so", "sq", "sr", "su", "sv", "sw", "ta", "te", "tg", "th", "tk", "tl", "tr",
  "tt", "uk", "ur", "uz", "vi", "yi", "yo", "yue", "zh",
];

// Whisper uses "jw" for Javanese; the ISO code Intl knows is "jv".
const INTL_CODE: Record<string, string> = { jw: "jv" };

function displayName(code: string, inLang: string): string {
  try {
    return new Intl.DisplayNames([inLang], { type: "language" }).of(INTL_CODE[code] ?? code) ?? code;
  } catch {
    return code;
  }
}

/// Fill the language dropdown: "Auto-detect" first, then every Whisper
/// language as "Name (native name)", sorted in the UI language.
export function populateLanguageSelect(select: HTMLSelectElement, uiLang: string, autoLabel: string, autoValue = "auto") {
  const selected = select.value || autoValue;
  const options = WHISPER_LANGUAGES.map((code) => {
    const name = displayName(code, uiLang);
    const native = displayName(code, INTL_CODE[code] ?? code);
    const cap = (s: string) => s.charAt(0).toLocaleUpperCase(uiLang) + s.slice(1);
    const label = native.toLowerCase() === name.toLowerCase() ? cap(name) : `${cap(name)} (${cap(native)})`;
    return { code, label };
  }).sort((a, b) => a.label.localeCompare(b.label, uiLang));

  select.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = autoValue;
  auto.textContent = autoLabel;
  select.appendChild(auto);
  for (const { code, label } of options) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = label;
    select.appendChild(opt);
  }
  select.value = selected;
}
