# -*- coding: utf-8 -*-
# Task 8 on the scratch app (after task 7): Files, the Soundboard's bar and
# settings panel, the German overflows. (The pill's language and notice are
# Task 3's; they are applied here too, to check them.)
import io, re, sys

APP = sys.argv[1]


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
    s = read("src/i18n.ts")
    start = s.index("const %s: Translations = {" % lang)
    end = s.index("\n};", start)
    table = s[start:end]
    added = []
    for key, value in values:
        line = '  %s: "%s",' % (key, value.replace("\\", "\\\\").replace('"', '\\"'))
        m = re.search(r"^  %s: .*,$" % re.escape(key), table, re.M)
        if m:
            table = table[: m.start()] + line + table[m.end():]
        else:
            added.append(line)
    if added:
        table += "\n" + "\n".join(added)
    write("src/i18n.ts", s[:start] + table + s[end:])


# ── i18n ──────────────────────────────────────────────────────────────────
set_keys("en", [
    ("files_title", "Files"),
    ("sb_settings", "Soundboard settings"),
    ("sb_stop_hotkey_hint", "Stops every sound."),
    ("sb_hotkey_more", "Works while the virtual microphone is on."),
    ("sb_sound_hotkeys_hint", "Off: the sounds' keys do nothing."),
    ("sb_sound_hotkeys_more", "The keys then work normally in other apps; Stop all still works. Click a sound to play it."),
    ("sb_toggle_hotkey_label", "Key for sound hotkeys on/off"),
    ("sb_toggle_hotkey_hint", "So you don't play a sound by accident."),
])
set_keys("de", [
    ("files_title", "Dateien"),
    ("sb_settings", "Soundboard-Einstellungen"),
    ("sb_stop_hotkey_hint", "Stoppt jeden Sound."),
    ("sb_hotkey_more", "Wirkt, solange das virtuelle Mikrofon an ist."),
    ("sb_sound_hotkeys_hint", "Aus: Die Tasten der Sounds bewirken nichts."),
    ("sb_sound_hotkeys_more", "Die Tasten funktionieren dann in anderen Apps normal; „Alle stoppen“ wirkt weiter. Klicke einen Sound an, um ihn abzuspielen."),
    ("sb_toggle_hotkey_label", "Taste für Sound-Tastenkürzel ein/aus"),
    ("sb_toggle_hotkey_hint", "Damit du nicht aus Versehen einen Sound abspielst."),
])

# ── Files ─────────────────────────────────────────────────────────────────
edit(
    "index.html",
    [
        ('<h2 class="section-title" data-i18n="files_title">Transcribe a file</h2>', '<h2 class="section-title" data-i18n="files_title">Files</h2>'),
        (
            '<textarea id="file-text" class="file-text" spellcheck="false"></textarea>',
            '<textarea id="file-text" class="file-text" spellcheck="false" data-i18n-aria-label="files_transcript" aria-label="Transcript"></textarea>',
        ),
    ],
)
edit(
    "src/files.ts",
    [
        (
            'const drop = document.getElementById("file-drop")!;\n',
            'const section = document.getElementById("section-files")!;\nconst drop = document.getElementById("file-drop")!;\n',
        ),
        (
            "  nameEl.textContent = fileName;\n  job.classList.remove(\"hidden\");\n",
            "  nameEl.textContent = fileName;\n  job.classList.remove(\"hidden\");\n  // A file is loaded: the drop zone shrinks, so the transcript starts on the first screen.\n  section.classList.add(\"has-file\");\n",
        ),
        (
            "  job.classList.add(\"hidden\");\n  result.classList.add(\"hidden\");\n  // The Clear button went with the file line.\n",
            "  job.classList.add(\"hidden\");\n  result.classList.add(\"hidden\");\n  section.classList.remove(\"has-file\");\n  // The Clear button went with the file line.\n",
        ),
    ],
)

# ── rows.ts: the Soundboard's own "More" buttons ──────────────────────────
edit(
    "src/rows.ts",
    [
        (
            "    const more = (e.target as HTMLElement).closest<HTMLElement>(\".hint-more\");\n    if (!more) return;\n",
            "    const more = (e.target as HTMLElement).closest<HTMLElement>(\".hint-more\");\n    // The Soundboard redraws its rows and keeps their state itself.\n    if (!more || more.dataset.own !== undefined) return;\n",
        ),
    ],
)

# ── soundboard/board.ts ───────────────────────────────────────────────────
edit(
    "src/soundboard/board.ts",
    [
        (
            'import { deleteButton } from "../confirm-delete";\n',
            'import { deleteButton } from "../confirm-delete";\nimport { prefs, rememberPrefs } from "../shell";\n',
        ),
        (
            "  let devicesOpen = false;\n",
            "  let devicesOpen = false;\n"
            "  /** Hints whose \"More\" is open, by row; kept over redraws. */\n"
            "  const openHints = new Set<string>();\n",
        ),
        (
            '''  function build(s: BoardState): HTMLElement[] {
    if (!options.popOut && s.board.window.poppedOut) return [popped()];
    listBox = el("div", "sb-list");
    fillList(listBox, s);
    // Two groups: settings (left in a wide main window) and the sound library (right).
    const settings = el("div", "sb-col sb-col-settings");
    settings.append(top(s), devicesBox(s), ...hints(s));
    const library = el("div", "sb-col sb-col-library");
    library.append(toolbar(), chips(s));
    if (notice.text) {
      const line = el("p", "sb-notice", notice.text);
      line.dataset.tone = notice.tone;
      line.setAttribute("role", "status");
      library.append(line);
    }
    library.append(listBox);
    return [settings, library];
  }

  function row(label: string, hint: string, ...controls: HTMLElement[]): HTMLElement {
    const r = el("div", "setting-row");
    const l = el("div", "setting-label");
    l.append(el("span", "label-text", label));
    if (hint) l.append(el("span", "label-hint", hint));
    const c = el("div", "setting-control sb-control");
    c.append(...controls);
    r.append(l, c);
    return r;
  }
''',
            '''  /** The window the board is in: the pop-out, or the tab with room for two columns or not. */
  function layout(): "popout" | "wide" | "narrow" {
    if (options.popOut) return "popout";
    return (document.getElementById("content")?.clientWidth ?? 0) >= 900 ? "wide" : "narrow";
  }

  /** The settings panel: as the user left it for this layout; else open only where it has a column of its own. */
  function panelOpen(): boolean {
    return prefs.panels[layout()] ?? layout() === "wide";
  }

  /** The sounds first: a bar (virtual microphone, Stop all, Pop out, Soundboard settings),
   *  then the settings panel if it is open (the left column in a wide window) and the library. */
  function build(s: BoardState): HTMLElement[] {
    const open = panelOpen();
    root.classList.toggle("wide", layout() === "wide");
    root.classList.toggle("panel-open", open);
    if (!options.popOut && s.board.window.poppedOut) return [popped()];
    listBox = el("div", "sb-list");
    fillList(listBox, s);
    const library = el("div", "sb-col sb-col-library");
    library.append(toolbar(), chips(s));
    if (notice.text) {
      const line = el("p", "sb-notice", notice.text);
      line.dataset.tone = notice.tone;
      line.setAttribute("role", "status");
      library.append(line);
    }
    library.append(listBox);
    const body = el("div", "sb-body");
    if (open) body.append(panel(s));
    body.append(library);
    return [bar(s, open), ...cableHint(s), body];
  }

  function bar(s: BoardState, open: boolean): HTMLElement {
    const b = el("div", "sb-bar");
    const onSwitch = toggle("enabled", t("sb_switch_label"), s.status.state === "on", async (wanted, input) => {
      if (switching) return;
      switching = true;
      input.disabled = true;
      try {
        const status = await api.setEnabled(wanted);
        if (state) state.status = status;
      } catch (e) {
        console.error("soundboard_set_enabled failed:", e);
        notice = { text: reasonText(String(e)), tone: "error" };
      }
      switching = false;
      render();
    });
    onSwitch.querySelector("input")!.disabled = switching;
    const text = el("div", "sb-bar-text");
    const status = el("span", "label-hint sb-status status-line", statusText(s.status));
    status.dataset.tone = s.status.state;
    text.append(el("span", "label-text", t("sb_switch_label")), status);
    const mic = el("div", "sb-bar-mic");
    mic.append(onSwitch, text);

    const actions = el("div", "sb-bar-actions");
    actions.append(button("btn-secondary", t("sb_stop_all"), "stop-all", () => void api.stopAll().catch(fail)));
    if (!options.popOut) actions.append(button("btn-secondary", t("sb_pop_out"), "pop-out", () => void api.popOut(true).catch(fail)));
    const settings = button("btn-secondary", t("sb_settings"), "settings", () => {
      prefs.panels[layout()] = !panelOpen();
      rememberPrefs();
      render();
    });
    settings.setAttribute("aria-expanded", String(open));
    settings.setAttribute("aria-controls", PANEL_ID);
    actions.append(settings);
    b.append(mic, actions);
    return b;
  }

  function row(label: string, hint: string, ...controls: HTMLElement[]): HTMLElement {
    return rowWithMore("", label, hint, "", ...controls);
  }

  /** A row whose one-line hint has a longer text behind "More" (`id` keeps it open over redraws). */
  function rowWithMore(id: string, label: string, hint: string, more: string, ...controls: HTMLElement[]): HTMLElement {
    const r = el("div", "setting-row");
    const l = el("div", "setting-label");
    l.append(el("span", "label-text", label));
    if (hint) {
      const h = el("span", "label-hint");
      h.append(el("span", "", hint));
      l.append(h);
      if (more) {
        const open = openHints.has(id);
        const longId = `${PANEL_ID}-more-${id}`;
        const b = button("hint-more", t(open ? "hint_less" : "hint_more"), `more-${id}`, () => {
          if (open) openHints.delete(id);
          else openHints.add(id);
          render();
        });
        // rows.ts leaves it alone: this board redraws and keeps the state itself.
        b.dataset.own = "";
        b.setAttribute("aria-expanded", String(open));
        b.setAttribute("aria-controls", longId);
        h.append(" ", b);
        const long = el("span", "label-hint hint-long", more);
        long.id = longId;
        long.hidden = !open;
        l.append(long);
      }
    }
    const c = el("div", "setting-control sb-control");
    c.append(...controls);
    r.append(l, c);
    return r;
  }
''',
        ),
        (
            '''  function top(s: BoardState): HTMLElement {
    const b = s.board;
    const list = el("div", "settings-list sb-top");
    const onSwitch = toggle("enabled", t("sb_switch_label"), s.status.state === "on", async (wanted, input) => {
      if (switching) return;
      switching = true;
      input.disabled = true;
      try {
        const status = await api.setEnabled(wanted);
        if (state) state.status = status;
      } catch (e) {
        console.error("soundboard_set_enabled failed:", e);
        notice = { text: reasonText(String(e)), tone: "error" };
      }
      switching = false;
      render();
    });
    onSwitch.querySelector("input")!.disabled = switching;
    const switchRow = row(t("sb_switch_label"), t("sb_switch_hint"), onSwitch);
    const status = el("span", "label-hint sb-status", statusText(s.status));
    status.dataset.tone = s.status.state;
    switchRow.querySelector(".setting-label")?.append(status);
    list.append(
      switchRow,
      row(t("sb_others_label"), t("sb_others_hint"), slider("others", t("sb_others_label"), b.othersVolume, (v) => void api.setVolumes(v, b.meVolume).catch(fail))),
      row(t("sb_me_label"), t("sb_me_hint"), slider("me", t("sb_me_label"), b.meVolume, (v) => void api.setVolumes(b.othersVolume, v).catch(fail))),
      row(t("sb_layer_label"), t("sb_layer_hint"), toggle("layer", t("sb_layer_label"), b.layer, (on) => void api.setLayer(on).catch(fail))),
      row(
        t("sb_stop_hotkey_label"),
        t("sb_stop_hotkey_hint"),
        hotkeyControl("stop-hotkey", b.stopHotkey, s.hotkeysTaken.includes("stopSounds"), (combo) => api.setStopHotkey(combo)),
      ),
      row(
        t("sb_sound_hotkeys_label"),
        t("sb_sound_hotkeys_hint"),
        toggle("sound-hotkeys", t("sb_sound_hotkeys_label"), b.soundHotkeys, (on) => void api.setSoundHotkeys(on).catch(fail)),
      ),
      row(
        t("sb_toggle_hotkey_label"),
        t("sb_toggle_hotkey_hint"),
        hotkeyControl("toggle-hotkey", b.toggleHotkey, s.hotkeysTaken.includes("toggleSoundHotkeys"), (combo) => api.setToggleHotkey(combo)),
      ),
    );
    if (options.popOut) {
      list.append(row(t("sb_always_on_top"), "", toggle("on-top", t("sb_always_on_top"), b.window.alwaysOnTop, (on) => void api.setAlwaysOnTop(on).catch(fail))));
    }
    return list;
  }
''',
            '''  /** "Soundboard settings": what is set once. The virtual microphone's switch is in the bar. */
  function panel(s: BoardState): HTMLElement {
    const b = s.board;
    const box = el("div", "sb-col sb-col-settings");
    box.id = PANEL_ID;
    const list = el("div", "settings-list sb-top");
    list.append(
      row(t("sb_others_label"), t("sb_others_hint"), slider("others", t("sb_others_label"), b.othersVolume, (v) => void api.setVolumes(v, b.meVolume).catch(fail))),
      row(t("sb_me_label"), t("sb_me_hint"), slider("me", t("sb_me_label"), b.meVolume, (v) => void api.setVolumes(b.othersVolume, v).catch(fail))),
      row(t("sb_layer_label"), t("sb_layer_hint"), toggle("layer", t("sb_layer_label"), b.layer, (on) => void api.setLayer(on).catch(fail))),
      rowWithMore(
        "sound-hotkeys",
        t("sb_sound_hotkeys_label"),
        t("sb_sound_hotkeys_hint"),
        t("sb_sound_hotkeys_more"),
        toggle("sound-hotkeys", t("sb_sound_hotkeys_label"), b.soundHotkeys, (on) => void api.setSoundHotkeys(on).catch(fail)),
      ),
      rowWithMore(
        "toggle-hotkey",
        t("sb_toggle_hotkey_label"),
        t("sb_toggle_hotkey_hint"),
        t("sb_hotkey_more"),
        hotkeyControl("toggle-hotkey", b.toggleHotkey, s.hotkeysTaken.includes("toggleSoundHotkeys"), (combo) => api.setToggleHotkey(combo)),
      ),
      rowWithMore(
        "stop-hotkey",
        t("sb_stop_hotkey_label"),
        t("sb_stop_hotkey_hint"),
        t("sb_hotkey_more"),
        hotkeyControl("stop-hotkey", b.stopHotkey, s.hotkeysTaken.includes("stopSounds"), (combo) => api.setStopHotkey(combo)),
      ),
    );
    if (options.popOut) {
      list.append(row(t("sb_always_on_top"), "", toggle("on-top", t("sb_always_on_top"), b.window.alwaysOnTop, (on) => void api.setAlwaysOnTop(on).catch(fail))));
    }
    box.append(el("p", "label-hint sb-panel-lead", t("sb_switch_hint")), list, devicesBox(s), ...discordHint());
    return box;
  }
''',
        ),
        (
            '''  function hints(s: BoardState): HTMLElement[] {
    const noCable = devices !== null && !devices.automatic.cable && !s.board.devices.cable;
    const box = el("div", "sb-hint");
    if (noCable) {
      box.append(
        el("p", "", t("sb_cable_missing")),
        button("btn-secondary", t("sb_cable_link"), "cable-link", () => void openExternal(CABLE_URL).catch(console.error)),
        el("p", "", t("sb_discord_hint")),
      );
      return [box];
    }
    if (hintSeen()) return [];
    box.append(
''',
            '''  /** No virtual cable: the board cannot work, so this shows whether the panel is open or not. */
  function cableHint(s: BoardState): HTMLElement[] {
    const noCable = devices !== null && !devices.automatic.cable && !s.board.devices.cable;
    if (!noCable) return [];
    const box = el("div", "sb-hint");
    box.append(
      el("p", "", t("sb_cable_missing")),
      button("btn-secondary", t("sb_cable_link"), "cable-link", () => void openExternal(CABLE_URL).catch(console.error)),
    );
    return [box];
  }

  /** How to choose the cable in Discord, in the panel until "Got it". */
  function discordHint(): HTMLElement[] {
    if (hintSeen()) return [];
    const box = el("div", "sb-hint");
    box.append(
''',
        ),
        (
            '''    bar.append(
      button("btn-secondary", t("sb_add"), "add", () => void chooseFiles()),
      search,
      button("btn-secondary", t("sb_stop_all"), "stop-all", () => void api.stopAll().catch(fail)),
    );
    if (!options.popOut) bar.append(button("btn-secondary", t("sb_pop_out"), "pop-out", () => void api.popOut(true).catch(fail)));
    return bar;
''',
            '''    bar.append(button("btn-secondary", t("sb_add"), "add", () => void chooseFiles()), search);
    return bar;
''',
        ),
        (
            "  void refresh().catch(console.error);\n\n  return {\n",
            "  // The tab got room for two columns, or lost it: the panel follows its layout's choice.\n"
            "  const content = document.getElementById(\"content\");\n"
            "  if (content) {\n"
            "    let was = layout();\n"
            "    new ResizeObserver(() => {\n"
            "      if (layout() === was) return;\n"
            "      was = layout();\n"
            "      render();\n"
            "    }).observe(content);\n"
            "  }\n"
            "  void refresh().catch(console.error);\n\n  return {\n",
        ),
        (
            "const CABLE_URL = \"https://vb-audio.com/Cable/\";\n",
            "const CABLE_URL = \"https://vb-audio.com/Cable/\";\n/** The settings panel's id (one board per window). */\nconst PANEL_ID = \"sb-panel\";\n",
        ),
    ],
)

# ── styles: the Soundboard's layout ───────────────────────────────────────
s = read("src/style.css")
a = s.index("/* Soundboard layout: with room")
b = s.index(".sb-control {\n", a)
s = s[:a] + '''/* The sounds first: a bar, then the settings panel (if it is open) and the
   library. In a wide window (class "wide", set by board.ts) the open panel
   is the left column. */
.sb-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--s3);
  padding: var(--s3) var(--s4);
  border-radius: var(--radius-card);
  background: var(--surface);
}
.sb-bar-mic {
  flex: 1 1 240px;
  display: flex;
  align-items: center;
  gap: var(--s3);
  min-width: 0;
}
.sb-bar-text {
  min-width: 0;
}
.sb-bar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s2);
}
.sb-body {
  display: flex;
  flex-direction: column;
  gap: var(--s4);
}
.sb.wide.panel-open .sb-body {
  display: grid;
  grid-template-columns: minmax(340px, 420px) minmax(0, 1fr);
  column-gap: var(--s5);
  align-items: start;
}
.sb-col-settings {
  padding: var(--s3) var(--s4);
  border-radius: var(--radius-card);
  background: var(--surface);
}
/* A device's dropdown takes the panel's width, under its label. */
.sb-devices .setting-row {
  flex-direction: column;
  align-items: stretch;
}
.sb-devices .setting-control {
  max-width: none;
  justify-content: flex-start;
}
.sb-devices select {
  width: 100%;
  max-width: none;
}
''' + s[b:]
old = '''#section-soundboard {
  max-width: none;
  container: sbmain / inline-size;
}
#section-soundboard .sb-layout {
  max-width: 680px;
  margin: 0 auto;
}
'''
assert s.count(old) == 1
s = s.replace(old, '''#section-soundboard {
  max-width: none;
}
#section-soundboard .sb-layout {
  max-width: 880px;
  margin: 0 auto;
}
#section-soundboard .sb-layout:has(.sb.wide) {
  max-width: 1800px;
}
''')
old = '''.file-drop.dragging {
  border-color: var(--accent);
  background: var(--accent-subtle);
}
'''
assert s.count(old) == 1
s = s.replace(old, old + '''/* A file is loaded: one line, so the transcript starts on the first screen. */
#section-files.has-file .file-drop {
  flex-direction: row;
  justify-content: center;
  gap: var(--s3);
  padding: var(--s2) var(--s3);
  margin-bottom: var(--s3);
}
#section-files.has-file .file-drop .label-hint,
#section-files.has-file .section-desc {
  display: none;
}
#section-files.has-file .file-drop .btn-secondary {
  margin-top: 0;
}
#section-files.has-file .section-header {
  margin-bottom: var(--s3);
}
''')
write("src/style.css", s)

# ── soundboard/page.ts: the pop-out's More buttons need nothing; names ────
# ── overlay.html: language from the setting, the no-model notice ──────────
edit(
    "src/overlay.html",
    [
        (
            "        opacity: 0;\n        pointer-events: none;\n        transition: opacity 200ms ease;\n      }\n      body[data-state=\"notice\"] .notice { opacity: 1; }\n",
            "        /* A long notice takes two lines. */\n        padding: 0 18px;\n        line-height: 1.25;\n        text-align: center;\n        opacity: 0;\n        pointer-events: none;\n        transition: opacity 200ms ease;\n      }\n      body[data-state=\"notice\"] .notice { opacity: 1; }\n",
        ),
        (
            "          mt_failed: \"The meeting could not start\",\n        },\n",
            "          mt_failed: \"The meeting could not start\",\n"
            "          no_model: \"No speech model yet — open RudariFlow to download one\", cancel: \"Cancel recording\",\n        },\n",
        ),
        (
            "          mt_failed: \"Das Meeting konnte nicht starten\",\n        },\n",
            "          mt_failed: \"Das Meeting konnte nicht starten\",\n"
            "          no_model: \"Noch kein Sprachmodell – öffne RudariFlow, um eines herunterzuladen\", cancel: \"Aufnahme abbrechen\",\n        },\n",
        ),
        (
            "      function pickLang() {\n        const nav = (navigator.language || \"en\").toLowerCase();\n        return nav.startsWith(\"de\") ? \"de\" : \"en\";\n      }\n",
            "      // The pill speaks the app's Display Language (Settings > General);\n"
            "      // before the first settings were saved, Windows' language.\n"
            "      let uiLanguage = \"\";\n"
            "      function pickLang() {\n"
            "        const lang = (uiLanguage || navigator.language || \"en\").toLowerCase();\n"
            "        return lang.startsWith(\"de\") ? \"de\" : \"en\";\n"
            "      }\n"
            "      function applyLanguage(lang) {\n"
            "        uiLanguage = String(lang || \"\");\n"
            "        const cancel = document.getElementById(\"cancel\");\n"
            "        cancel.title = NOTICE_TEXT[pickLang()].cancel;\n"
            "        cancel.setAttribute(\"aria-label\", cancel.title);\n"
            "      }\n"
            "      invoke(\"get_settings\").then((s) => applyLanguage(s && s.uiLanguage)).catch(() => applyLanguage(\"\"));\n"
            "      listen(\"ui-language\", (event) => applyLanguage(event.payload));\n"
            "\n"
            "      // A dictation could not start: \"no_model\" (no speech model downloaded yet).\n"
            "      listen(\"speech-notice\", (event) => {\n"
            "        const text = { no_model: NOTICE_TEXT[pickLang()].no_model }[event.payload];\n"
            "        diag(`speech-notice received (${event.payload})`);\n"
            "        if (text) showNotice(text, 3200);\n"
            "      });\n",
        ),
    ],
)
print("ok")
