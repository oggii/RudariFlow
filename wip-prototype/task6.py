# -*- coding: utf-8 -*-
# Task 6 on the scratch app (after tasks 3-5): Settings with five tabs, each
# with its main card and an Advanced fold, one-line hints with More.
import io, re, sys

APP = sys.argv[1]
SETTINGS_HTML = sys.argv[2]


def read(path):
    return io.open(APP + "/" + path, encoding="utf-8").read()


def write(path, s):
    io.open(APP + "/" + path, "w", encoding="utf-8", newline="\n").write(s)


def edit(path, pairs):
    s = read(path)
    for old, new in pairs:
        assert s.count(old) == 1, (path, old[:70], s.count(old))
        s = s.replace(old, new)
    write(path, s)


def cut(path, start, end, new=""):
    s = read(path)
    assert s.count(start) == 1 and s.count(end) >= 1, (path, start[:60], s.count(start), end[:60], s.count(end))
    a = s.index(start)
    b = s.index(end, a) + len(end)
    write(path, s[:a] + new + s[b:])


def set_keys(lang, values):
    """Change or add i18n texts in one language table ('en' / 'de')."""
    s = read("src/i18n.ts")
    start = s.index("const %s: Translations = {" % lang)
    end = s.index("\n};", start)
    table = s[start:end]
    added = []
    for key, value in values:
        line = '  %s: %s,' % (key, value)
        m = re.search(r"^  %s: .*,$" % re.escape(key), table, re.M)
        if m:
            table = table[: m.start()] + line + table[m.end():]
        else:
            added.append(line)
    if added:
        table += "\n" + "\n".join(added)
    write("src/i18n.ts", s[:start] + table + s[end:])


def drop_keys(keys):
    s = read("src/i18n.ts")
    for key in keys:
        s, n = re.subn(r"^  %s: .*,\n" % re.escape(key), "", s, flags=re.M)
        assert n == 2, (key, n)
    write("src/i18n.ts", s)


# ── index.html ────────────────────────────────────────────────────────────
cut("index.html", '        <section id="section-settings" class="content-section">\n', "        </section>\n", io.open(SETTINGS_HTML, encoding="utf-8").read())

# ── i18n ──────────────────────────────────────────────────────────────────
q = lambda s: '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
EN = [
    ("hint_more", "More"), ("hint_less", "Less"), ("advanced", "Advanced"),
    ("dictate_label", "Dictate"), ("dictate_hint", "Hold and speak, or press once to start and stop."),
    ("mode_label", "How the key works"), ("mode_ptt", "Hold"),
    ("paste_last_label", "Paste last dictation"),
    ("paste_last_hint", "Pastes your last dictation again, e.g. after the wrong window."),
    ("rewrite_last_hint", "Say how to change it: “shorter”, “more formal”."),
    ("rewrite_last_more", "Selects your last dictation and changes it the way you say. Needs AI cleanup and Edit mode."),
    ("microphone_hint", "The microphone you dictate with."),
    ("volume_label", "Start and stop sounds"), ("volume_hint", "How loud the soft sound at the start and the end is."),
    ("free_gpu_hint", "Unloads the models so a game gets the graphics card."),
    ("free_gpu_more", "Press again to load them; a dictation also loads them, the first one takes a few seconds longer."),
    ("meeting_hotkey_hint", "Starts a meeting, or stops the one that records."),
    ("mute_audio_hint", "Music and videos go quiet while you dictate."),
    ("send_command_hint", "End with “Send it.” to press Enter after pasting."),
    ("send_command_more", "Say it as its own sentence, for example in chats. German: “Abschicken.”"),
    ("ai_output_hint", "Translates every dictation into this language."),
    ("ai_output_more", "Only while AI cleanup runs; apps set to No AI keep the spoken language."),
    ("ai_output_warn", "Set Models & GPU → Language to Auto-detect, so Whisper hears other languages correctly before they are translated."),
    ("ai_edit_hint", "Select text, hold your hotkey and say what to change."),
    ("ai_edit_more", "Say “shorter”, “more formal”, “in Turkish”, or the new text. Works where the app shares its text, not in terminals or address bars. Ctrl+Z undoes it."),
    ("ai_rules_desc", "Instructions and the spoken language for one app or website."),
    ("ai_rules_more", "A rule matches the program name or a word in the window title, e.g. “whatsapp” also covers WhatsApp Web. The language is what Whisper hears in this app, also with AI cleanup off. No AI pastes the plain Whisper text."),
    ("ai_model_label", "AI model"),
    ("dict_words_title", "Words"),
    ("replacements_desc", "Say a short phrase, get longer text."),
    ("replacements_more", "Good for email addresses, links and signatures. {date}, {time}, {weekday}, {year} and {iso_date} in the text are filled in when it is pasted."),
    ("screen_context_hint", "Names in the window you dictate into help with spelling."),
    ("screen_context_more", "Whisper and the AI use them. They are read on your PC when you press the hotkey and never saved."),
    ("learn_hint", "Names you correct right after dictating are suggested."),
    ("learn_more", "Only the corrected word is kept, never your text."),
    ("dict_io_label", "Import and export"), ("dict_io_hint", "A text file with one entry per line, or separated by commas."),
    ("model_label", "Speech model"), ("model_hint", "Larger models are more accurate and need more memory."),
    ("model_note_tiny", "Fastest, lowest accuracy"), ("model_note_small", "A good start on any PC"),
    ("model_note_large_v3", "Highest accuracy"), ("model_note_turbo", "Large quality, about 8 times faster"),
    ("model_note_q8", "Same text as Turbo, faster, half the memory"),
    ("model_note_q5", "Saves about 0.3 GB of graphics memory over q8, same speed"),
    ("cloud_note", "The cloud engine (Groq) transcribes. Change it under Advanced."),
    ("language_hint", "Auto-detect, or the language you dictate in."),
    ("engine_label", "Engine"), ("engine_hint", "Local runs on this PC, Cloud needs an API key."),
    ("gpu_backend_label", "GPU backend"),
    ("pc_check_hint", "Measures this PC (about 20 seconds) and uses the fastest setup."),
    ("pc_check_more", "Whisper on your graphics card with and without flash attention, and the speed of the AI."),
    ("game_free_hint", "Unloads the models while a game or video runs in fullscreen."),
    ("idle_unload_hint", "Frees the graphics card after this long without a dictation."),
    ("idle_unload_more", "On mains power. The next dictation loads the models again and takes a few seconds longer. On battery it is always 10 minutes."),
    ("ui_language_hint", "The language of this window, the pill and the tray menu."),
    ("autostart_label", "Start with Windows"), ("autostart_hint", "Starts RudariFlow in the tray when you log in."),
    ("history_mode_hint", "The last 200 texts and 50 recordings are kept."),
    ("history_mode_more", "Recordings let you re-run a dictation with another model."),
    ("history_stored_label", "Stored on this PC"),
]
DE = [
    ("hint_more", "Mehr"), ("hint_less", "Weniger"), ("advanced", "Erweitert"),
    ("dictate_label", "Diktieren"), ("dictate_hint", "Halten und sprechen, oder einmal drücken zum Starten und Stoppen."),
    ("mode_label", "So funktioniert die Taste"), ("mode_ptt", "Halten"),
    ("paste_last_label", "Letztes Diktat einfügen"),
    ("paste_last_hint", "Fügt dein letztes Diktat erneut ein, z. B. nach dem falschen Fenster."),
    ("rewrite_last_hint", "Sag, wie es sich ändern soll: „kürzer“, „förmlicher“."),
    ("rewrite_last_more", "Markiert dein letztes Diktat und ändert es so, wie du sagst. Braucht KI-Korrektur und Bearbeiten."),
    ("microphone_hint", "Das Mikrofon, mit dem du diktierst."),
    ("volume_label", "Start- und Stopptöne"), ("volume_hint", "Wie laut der leise Ton am Anfang und am Ende ist."),
    ("free_gpu_hint", "Entlädt die Modelle, damit ein Spiel die Grafikkarte bekommt."),
    ("free_gpu_more", "Nochmals drücken lädt sie wieder; auch ein Diktat lädt sie, das erste dauert ein paar Sekunden länger."),
    ("meeting_hotkey_hint", "Startet ein Meeting oder beendet das laufende."),
    ("mute_audio_hint", "Musik und Videos verstummen, während du diktierst."),
    ("send_command_hint", "Ende mit „Abschicken.“, und nach dem Einfügen wird Enter gedrückt."),
    ("send_command_more", "Sag es als eigenen Satz, zum Beispiel im Chat. Englisch: „Send it.“"),
    ("ai_output_hint", "Übersetzt jedes Diktat in diese Sprache."),
    ("ai_output_more", "Nur wenn die KI-Korrektur läuft; Apps mit „Keine KI“ behalten die gesprochene Sprache."),
    ("ai_output_warn", "Stelle Modelle & GPU → Sprache auf Automatisch erkennen, damit Whisper andere Sprachen richtig hört, bevor sie übersetzt werden."),
    ("ai_edit_hint", "Text markieren, Hotkey halten und sagen, was sich ändern soll."),
    ("ai_edit_more", "Sag „kürzer“, „förmlicher“, „auf Türkisch“ oder den neuen Text. Klappt, wo die App ihren Text teilt, nicht in Terminals und Adressleisten. Strg+Z macht es rückgängig."),
    ("ai_rules_desc", "Anweisungen und die gesprochene Sprache für eine App oder Website."),
    ("ai_rules_more", "Eine Regel passt auf den Programmnamen oder ein Wort im Fenstertitel, z. B. deckt „whatsapp“ auch WhatsApp Web ab. Die Sprache ist die, die Whisper in dieser App hört, auch ohne KI-Korrektur. „Keine KI“ fügt den reinen Whisper-Text ein."),
    ("ai_model_label", "KI-Modell"),
    ("dict_words_title", "Wörter"),
    ("replacements_desc", "Sag einen kurzen Ausdruck, erhalte längeren Text."),
    ("replacements_more", "Praktisch für E-Mail-Adressen, Links und Signaturen. {date}, {time}, {weekday}, {year} und {iso_date} im Text werden beim Einfügen ausgefüllt."),
    ("screen_context_hint", "Namen im Fenster, in das du diktierst, helfen bei der Schreibweise."),
    ("screen_context_more", "Whisper und die KI nutzen sie. Sie werden beim Drücken des Hotkeys auf deinem PC gelesen und nie gespeichert."),
    ("learn_hint", "Namen, die du gleich nach dem Diktieren korrigierst, werden vorgeschlagen."),
    ("learn_more", "Gespeichert wird nur das korrigierte Wort, nie dein Text."),
    ("dict_io_label", "Import und Export"), ("dict_io_hint", "Eine Textdatei mit einem Eintrag pro Zeile oder durch Kommas getrennt."),
    ("model_label", "Sprachmodell"), ("model_hint", "Größere Modelle sind genauer und brauchen mehr Speicher."),
    ("model_note_tiny", "Am schnellsten, geringste Genauigkeit"), ("model_note_small", "Ein guter Anfang auf jedem PC"),
    ("model_note_large_v3", "Höchste Genauigkeit"), ("model_note_turbo", "Large-Qualität, etwa 8-mal schneller"),
    ("model_note_q8", "Gleicher Text wie Turbo, schneller, halber Speicher"),
    ("model_note_q5", "Spart etwa 0,3 GB Grafikspeicher gegenüber q8, gleich schnell"),
    ("cloud_note", "Die Cloud-Engine (Groq) transkribiert. Ändern unter Erweitert."),
    ("language_hint", "Automatisch erkennen oder die Sprache, in der du diktierst."),
    ("engine_label", "Engine"), ("engine_hint", "Lokal läuft auf diesem PC, Cloud braucht einen API-Schlüssel."),
    ("gpu_backend_label", "GPU-Backend"),
    ("pc_check_hint", "Misst diesen PC (etwa 20 Sekunden) und nutzt die schnellste Einstellung."),
    ("pc_check_more", "Whisper auf deiner Grafikkarte mit und ohne Flash Attention und das Tempo der KI."),
    ("game_free_hint", "Entlädt die Modelle, solange ein Spiel oder Video im Vollbild läuft."),
    ("idle_unload_hint", "Gibt die Grafikkarte nach so langer Zeit ohne Diktat frei."),
    ("idle_unload_more", "Am Strom. Das nächste Diktat lädt die Modelle wieder und dauert ein paar Sekunden länger. Im Akkubetrieb sind es immer 10 Minuten."),
    ("ui_language_hint", "Die Sprache dieses Fensters, der Pille und des Tray-Menüs."),
    ("autostart_label", "Mit Windows starten"), ("autostart_hint", "Startet RudariFlow im Tray, wenn du dich anmeldest."),
    ("history_mode_hint", "Behalten werden die letzten 200 Texte und 50 Aufnahmen."),
    ("history_mode_more", "Mit Aufnahmen kannst du ein Diktat mit einem anderen Modell neu transkribieren."),
    ("history_stored_label", "Auf diesem PC gespeichert"),
]
assert [k for k, _ in EN] == [k for k, _ in DE]
# The long texts of 0.16 become the "More" texts where the plan keeps them whole.
s = read("src/i18n.ts")
for key, more in [("game_free_hint", "game_free_more")]:
    s, n = re.subn(r"^  %s: " % key, "  %s: " % more, s, flags=re.M)
    assert n == 2, (key, n)
write("src/i18n.ts", s)
set_keys("en", [(k, q(v)) for k, v in EN])
set_keys("de", [(k, q(v)) for k, v in DE])
drop_keys([
    "recording_mode_label", "recording_mode_hint", "hotkey_label", "hotkey_hint",
    "model_tiny", "model_base", "model_small", "model_medium", "model_large_v3", "model_large_v3_turbo",
    "model_large_v3_turbo_q8", "model_large_v3_turbo_q5",
])

# ── styles ────────────────────────────────────────────────────────────────
edit("src/style.css", [('@import "./styles/home.css";\n', '@import "./styles/home.css";\n@import "./styles/settings.css";\n')])

# ── main.ts ───────────────────────────────────────────────────────────────
edit(
    "src/main.ts",
    [
        (
            'import { setup } from "./setup.ts";\n',
            'import { setup, sizeText } from "./setup.ts";\nimport { initHints, nameRows } from "./rows";\nimport { modelLabel, speechModel } from "./models.ts";\n',
        ),
        (
            "function setEngine(engine: string) {\n"
            "  currentSettings.engine = engine;\n"
            '  engineLocal.classList.toggle("active", engine === "local");\n'
            '  engineCloud.classList.toggle("active", engine === "cloud");\n'
            '  localSettings.classList.toggle("hidden", engine !== "local");\n'
            '  cloudSettings.classList.toggle("hidden", engine !== "cloud");\n'
            "}\n",
            "/** A segmented choice: the chosen button is `active` and pressed. */\n"
            "function choose(button: HTMLElement, on: boolean) {\n"
            '  button.classList.toggle("active", on);\n'
            '  button.setAttribute("aria-pressed", String(on));\n'
            "}\n"
            "\n"
            "function setEngine(engine: string) {\n"
            "  currentSettings.engine = engine;\n"
            '  choose(engineLocal, engine === "local");\n'
            '  choose(engineCloud, engine === "cloud");\n'
            '  localSettings.classList.toggle("hidden", engine !== "local");\n'
            '  cloudSettings.classList.toggle("hidden", engine !== "cloud");\n'
            "  // The speech model's row is gone with the cloud engine: say where the engine is.\n"
            '  document.getElementById("engine-cloud-note")!.classList.toggle("hidden", engine !== "cloud");\n'
            "}\n",
        ),
        (
            '  modeToggle.classList.toggle("active", mode === "toggle");\n  modePtt.classList.toggle("active", mode === "push-to-talk");\n',
            '  choose(modeToggle, mode === "toggle");\n  choose(modePtt, mode === "push-to-talk");\n',
        ),
        (
            "async function refreshModelStatusUI() {\n"
            "  const downloaded = await isCurrentModelDownloaded();\n"
            "  if (downloaded) {\n"
            '    downloadBtn.textContent = "\\u2713";\n'
            '    downloadBtn.removeAttribute("data-i18n");\n'
            "  } else {\n"
            '    downloadBtn.setAttribute("data-i18n", "download");\n'
            '    downloadBtn.textContent = t("download");\n'
            "  }\n"
            "  (downloadBtn as HTMLButtonElement).disabled = downloaded;\n"
            "  await refreshModelDropdownLabels();\n"
            "}\n"
            "\n"
            "async function refreshModelDropdownLabels() {\n"
            "  const opts = Array.from(modelSelect.options) as HTMLOptionElement[];\n"
            "  await Promise.all(opts.map(async (o) => {\n"
            '    const ok = await invoke<boolean>("check_model_downloaded", { modelSize: o.value });\n'
            '    const key = o.getAttribute("data-i18n");\n'
            '    const base = key ? t(key) : (o.dataset.baseText ?? o.textContent ?? "");\n'
            "    if (!o.dataset.baseText) o.dataset.baseText = base;\n"
            "    o.textContent = ok ? `${base} \\u2713` : base;\n"
            "  }));\n"
            "}\n",
            "/** The Download button shows only while the chosen model is missing (a\n"
            " *  downloaded one has its tick in the list), with the model's note under the label. */\n"
            "async function refreshModelStatusUI() {\n"
            "  const downloaded = await isCurrentModelDownloaded();\n"
            '  downloadBtn.setAttribute("data-i18n", "download");\n'
            '  downloadBtn.textContent = t("download");\n'
            '  downloadBtn.classList.toggle("hidden", downloaded);\n'
            "  (downloadBtn as HTMLButtonElement).disabled = false;\n"
            "  const note = speechModel(modelSelect.value).note;\n"
            '  document.getElementById("model-note")!.textContent = note ? t(note) : "";\n'
            "  await refreshModelDropdownLabels();\n"
            "}\n"
            "\n"
            "/** \"Large v3 Turbo q8 · 870 MB ✓\": name, size, and a tick when it is downloaded. */\n"
            "async function refreshModelDropdownLabels() {\n"
            "  const opts = Array.from(modelSelect.options) as HTMLOptionElement[];\n"
            "  await Promise.all(opts.map(async (o) => {\n"
            '    const ok = await invoke<boolean>("check_model_downloaded", { modelSize: o.value });\n'
            "    o.textContent = ok ? `${modelLabel(o.value)} \\u2713` : modelLabel(o.value);\n"
            "  }));\n"
            "}\n",
        ),
        (
            "  try {\n"
            '    await invoke("download_model", { modelSize: modelSelect.value });\n'
            '    downloadBtn.textContent = "\\u2713";\n'
            '    downloadBtn.removeAttribute("data-i18n");\n'
            "    return true;\n",
            "  try {\n"
            '    await invoke("download_model", { modelSize: modelSelect.value });\n'
            '    downloadBtn.classList.add("hidden");\n'
            "    return true;\n",
        ),
        (
            "  const { percent } = event.payload;\n  progressFill.style.width = `${percent}%`;\n",
            "  const { percent, downloaded, total } = event.payload;\n"
            "  progressFill.style.width = `${percent}%`;\n"
            "  // Always the numbers too: percent and size.\n"
            '  document.getElementById("download-numbers")!.textContent = t("progress_numbers")\n'
            '    .replace("{percent}", String(Math.round(percent)))\n'
            '    .replace("{done}", sizeText(downloaded))\n'
            '    .replace("{total}", sizeText(total));\n',
        ),
        (
            "  setLang(uiLanguageSelect.value);\n  populateLanguageSelect(languageSelect, getLang(), t(\"language_auto\"));\n  renderMicOptions();\n  renderHotkeys();\n",
            "  setLang(uiLanguageSelect.value);\n  populateLanguageSelect(languageSelect, getLang(), t(\"language_auto\"));\n  nameRows();\n  renderMicOptions();\n  renderHotkeys();\n  await refreshModelStatusUI();\n",
        ),
        (
            "// Sections and Settings tabs (src/shell.ts); what a page needs when it is shown.\ninitShell();\n",
            "// Sections and Settings tabs (src/shell.ts); what a page needs when it is shown.\ninitShell();\ninitHints();\n",
        ),
        (
            "  uiLanguageSelect.value = currentSettings.uiLanguage;\n  setLang(currentSettings.uiLanguage);\n",
            "  uiLanguageSelect.value = currentSettings.uiLanguage;\n  setLang(currentSettings.uiLanguage);\n  nameRows();\n",
        ),
    ],
)

# ── ai-settings.ts ────────────────────────────────────────────────────────
edit(
    "src/ai-settings.ts",
    [
        (
            'const downloadBtn = $<HTMLButtonElement>("ai-download-btn");\n',
            'const downloadBtn = $<HTMLButtonElement>("ai-download-btn");\n'
            "/** The same download, next to the switch it unlocks (the model's own row is under Advanced). */\n"
            'const downloadMain = $<HTMLButtonElement>("ai-download-main");\n',
        ),
        (
            '  downloadBtn.classList.toggle("hidden", downloaded);\n  downloadBtn.disabled = downloading;\n',
            '  downloadBtn.classList.toggle("hidden", downloaded);\n  downloadBtn.disabled = downloading;\n'
            '  downloadMain.classList.toggle("hidden", downloaded || !status.installed);\n  downloadMain.disabled = downloading;\n',
        ),
        (
            "  progress.classList.remove(\"hidden\");\n  downloadBtn.disabled = true;\n",
            "  progress.classList.remove(\"hidden\");\n  downloadBtn.disabled = true;\n  downloadMain.disabled = true;\n",
        ),
        (
            "function setStyle(style: string) {\n"
            '  stylePolished.classList.toggle("active", style !== "light");\n'
            '  styleLight.classList.toggle("active", style === "light");\n'
            "}\n",
            "function setStyle(style: string) {\n"
            "  for (const [button, on] of [\n"
            '    [stylePolished, style !== "light"],\n'
            '    [styleLight, style === "light"],\n'
            "  ] as const) {\n"
            '    button.classList.toggle("active", on);\n'
            '    button.setAttribute("aria-pressed", String(on));\n'
            "  }\n"
            "}\n",
        ),
        (
            '  downloadBtn.addEventListener("click", download);\n',
            '  downloadBtn.addEventListener("click", download);\n  downloadMain.addEventListener("click", download);\n',
        ),
        (
            "    progressText.textContent = total ? `${gb(downloaded)} / ${gb(total)} GB` : \"\";\n",
            "    // Always the numbers: percent and size.\n"
            "    progressText.textContent = total\n"
            '      ? t("progress_numbers").replace("{percent}", String(Math.round(percent))).replace("{done}", sizeText(downloaded)).replace("{total}", sizeText(total))\n'
            "      : `${Math.round(percent)} %`;\n",
        ),
        (
            'import { setDownload } from "./activity";\n',
            'import { setDownload } from "./activity";\nimport { sizeText } from "./setup.ts";\n',
        ),
    ],
)

# ── home.ts: names from the models table ──────────────────────────────────
cut(
    "src/home.ts",
    "/** The speech model's name as its dropdown shows it, without the \"downloaded\" mark. */\n",
    "}\n\n",
    "",
)
s = read("src/home.ts")
assert s.count("speechModelName(") == 3, s.count("speechModelName(")
s = s.replace("speechModelName(speech.model)", "speechModel(speech.model).name")
s = s.replace('speechModelName(speech?.model ?? "")', 'speechModel(speech?.model ?? "").name')
s = s.replace("const name = speechModelName(suggestion.model);", "const name = modelLabel(suggestion.model);")
assert "speechModelName" not in s
s = s.replace('import { recommend, setup, sizeText, type Gpu, type Recommendation } from "./setup.ts";\n',
              'import { recommend, setup, sizeText, type Gpu, type Recommendation } from "./setup.ts";\nimport { modelLabel, speechModel } from "./models.ts";\n')
write("src/home.ts", s)
print("ok")
