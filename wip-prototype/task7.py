# -*- coding: utf-8 -*-
# Task 7 on the scratch app (after task 6): the Dictionary tab's lists with
# search, the list design and the one delete pattern everywhere.
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


def drop_keys(keys):
    s = read("src/i18n.ts")
    for key in keys:
        s, n = re.subn(r"^  %s: .*,\n" % re.escape(key), "", s, flags=re.M)
        assert n == 2, (key, n)
    write("src/i18n.ts", s)


# ── index.html: the Dictionary tab's lists ────────────────────────────────
edit(
    "index.html",
    [
        (
            '                <h3 class="list-title"><span data-i18n="dict_words_title">Words</span> <span id="dict-count" class="list-count"></span></h3>\n              </div>\n',
            '                <h3 class="list-title"><span data-i18n="dict_words_title">Words</span> <span id="dict-count" class="list-count"></span></h3>\n'
            '                <input type="search" id="dict-search" spellcheck="false" autocomplete="off" data-i18n-placeholder="dict_search" data-i18n-aria-label="dict_search" placeholder="Search words" aria-label="Search words" />\n'
            "              </div>\n",
        ),
        (
            '              <div id="dict-list" class="dict-list"></div>\n',
            '              <div id="dict-list" class="list dict-list"></div>\n'
            '              <p id="dict-no-match" class="empty-state hidden" data-i18n="dict_no_match">No word matches.</p>\n',
        ),
        (
            '                <h3 class="list-title" data-i18n="replacements_title">Replacements</h3>\n              </div>\n',
            '                <h3 class="list-title" data-i18n="replacements_title">Replacements</h3>\n'
            '                <input type="search" id="replacement-search" spellcheck="false" autocomplete="off" data-i18n-placeholder="replacement_search" data-i18n-aria-label="replacement_search" placeholder="Search replacements" aria-label="Search replacements" />\n'
            "              </div>\n",
        ),
        (
            '              <div id="replacement-list" class="replacement-list"></div>\n',
            '              <div id="replacement-cols" class="list-cols replacement-cols hidden" aria-hidden="true">\n'
            '                <span data-i18n="replacement_from_label">When I say</span>\n'
            '                <span data-i18n="replacement_to_label">Insert</span>\n'
            "              </div>\n"
            '              <div id="replacement-list" class="list replacement-list"></div>\n'
            '              <p id="replacement-no-match" class="empty-state hidden" data-i18n="replacement_no_match">No replacement matches.</p>\n',
        ),
        ('              <div id="ai-rule-list" class="rule-list"></div>\n', '              <div id="ai-rule-list" class="list rule-list"></div>\n'),
        (
            '<button id="mt-delete" class="btn-secondary" data-i18n="mt_delete">Delete</button>',
            '<button type="button" id="mt-delete" class="btn-secondary">Delete</button>',
        ),
        (
            '<button type="button" id="history-clear" class="btn-secondary" data-i18n="history_clear">Clear history</button>',
            '<button type="button" id="history-clear" class="btn-secondary">Delete history</button>',
        ),
    ],
)

# ── i18n ──────────────────────────────────────────────────────────────────
EN = [
    ("delete", "Delete"), ("delete_confirm", "Delete?"),
    ("history_clear", "Delete history"), ("history_clear_confirm", "Delete all?"),
    ("dict_search", "Search words"), ("dict_no_match", "No word matches."),
    ("replacement_search", "Search replacements"), ("replacement_no_match", "No replacement matches."),
    ("replacement_from_label", "When I say"), ("replacement_to_label", "Insert"),
    ("rule_app_label", "App"), ("rule_language_label", "Language in this app"), ("rule_instructions_label", "Instructions"),
    ("sb_category_delete", "Delete category (its sounds stay)"),
]
DE = [
    ("delete", "Löschen"), ("delete_confirm", "Löschen?"),
    ("history_clear", "Verlauf löschen"), ("history_clear_confirm", "Alles löschen?"),
    ("dict_search", "Wörter suchen"), ("dict_no_match", "Kein Wort passt."),
    ("replacement_search", "Ersetzungen suchen"), ("replacement_no_match", "Keine Ersetzung passt."),
    ("replacement_from_label", "Wenn ich sage"), ("replacement_to_label", "Einfügen"),
    ("rule_app_label", "App"), ("rule_language_label", "Sprache in dieser App"), ("rule_instructions_label", "Anweisungen"),
    ("sb_category_delete", "Kategorie löschen (ihre Sounds bleiben)"),
]
set_keys("en", EN)
set_keys("de", DE)
drop_keys(["ai_rule_language_hint", "ai_rule_off_hint", "replacement_remove", "history_delete", "unused_model_delete", "unused_model_confirm", "unused_model_confirm_plain", "mt_delete", "mt_delete_confirm", "sb_delete", "sb_delete_confirm"])

# ── main.ts: replacements move out; unused models as list rows ────────────
cut("src/main.ts", "// ── Replacements ─", '  (row.querySelector(".replacement-from") as HTMLInputElement).focus();\n});\n\n')
cut("src/main.ts", "interface Replacement {\n", "}\n\n")
cut("src/main.ts", 'const replacementList = document.getElementById("replacement-list")!;\n', 'const replacementAdd = document.getElementById("replacement-add") as HTMLButtonElement;\n')
cut(
    "src/main.ts",
    "/// One unused model with a Delete button that asks once more (click again\n",
    "  row.append(info, del);\n  return row;\n}\n",
    '''/// One unused model as a list row: its file, what it is and its size, and Delete.
function unusedModelRow(m: ModelFile): HTMLElement {
  const row = document.createElement("div");
  row.className = "list-row unused-model-row";
  const info = document.createElement("div");
  info.className = "list-main";
  const name = document.createElement("span");
  name.className = "list-primary unused-model-name";
  name.textContent = m.file;
  const meta = document.createElement("span");
  meta.className = "list-secondary";
  const parts = [t(m.kind === "ai" ? "unused_model_ai" : "unused_model_whisper")];
  if (m.partial) parts.push(t("unused_model_partial"));
  parts.push(m.otherLinks ? `${formatSize(m.bytes)} (${t("unused_model_links")})` : formatSize(m.bytes));
  meta.textContent = parts.join(" \\u00b7 ");
  const error = document.createElement("span");
  error.className = "list-secondary unused-model-error hidden";
  error.setAttribute("role", "alert");
  info.append(name, meta, error);

  const del = deleteButton(
    `model-${m.kind}-${m.file}`,
    async () => {
      del.disabled = true;
      try {
        await invoke<number>("delete_unused_model", { kind: m.kind, file: m.file });
        await renderUnusedModels();
        if (m.kind === "ai") await renderAiSettings();
        else await refreshModelDropdownLabels();
      } catch (err) {
        const code = String(err);
        const key = DELETE_ERRORS[code];
        error.textContent = key ? t(key) : t("unused_model_failed").replace("{error}", code);
        error.classList.remove("hidden");
        del.disabled = false;
      }
    },
    { name: m.file },
  );
  const actions = document.createElement("div");
  actions.className = "list-actions";
  actions.append(del);
  row.append(info, actions);
  return row;
}
''',
)
edit(
    "src/main.ts",
    [
        (
            'import { initHints, nameRows } from "./rows";\n',
            'import { initHints, nameRows } from "./rows";\n'
            'import { deleteButton, repaintDeletes } from "./confirm-delete";\n'
            'import { initReplacements, readReplacements, renderReplacements, type Replacement } from "./replacements";\n',
        ),
        (
            "  void soundboard.refresh();\n  void renderMeetings();\n  renderStatus();\n});\n",
            "  void soundboard.refresh();\n  void renderMeetings();\n  renderReplacements();\n  repaintDeletes();\n  renderStatus();\n});\n",
        ),
        (
            "initHistory({ mode: () => historyModeSelect.value });\n",
            "initHistory({ mode: () => historyModeSelect.value });\ninitReplacements({ replacements: () => currentSettings.replacements, save: saveSettings });\n",
        ),
    ],
)

# ── history.ts ────────────────────────────────────────────────────────────
edit(
    "src/history.ts",
    [
        ('import { shown } from "./search.ts";\n', 'import { shown } from "./search.ts";\nimport { confirmDelete, deleteButton } from "./confirm-delete";\n'),
        (
            '''  actions.appendChild(
    action(t("history_delete"), async () => {
      if (playing && item.contains(playing.btn)) stopPlayback();
      await invoke("history_delete", { id: e.id });
      await refreshHistory();
    }),
  );
''',
            '''  actions.appendChild(
    deleteButton(
      `history-${e.id}`,
      async () => {
        if (playing && item.contains(playing.btn)) stopPlayback();
        await invoke("history_delete", { id: e.id });
        await refreshHistory();
      },
      { name: e.text.slice(0, 40) },
    ),
  );
''',
        ),
        (
            '''  count.textContent = entries.length === 1 ? t("history_count_one") : t("history_count").replace("{n}", String(entries.length));
  clear.classList.toggle("hidden", entries.length === 0);
  resetClearButton();
}
''',
            '''  count.textContent = entries.length === 1 ? t("history_count_one") : t("history_count").replace("{n}", String(entries.length));
  clear.classList.toggle("hidden", entries.length === 0);
}
''',
        ),
        (
            '''let clearArmed: number | undefined;
function resetClearButton() {
  window.clearTimeout(clearArmed);
  clearArmed = undefined;
  clear.classList.remove("armed");
  clear.textContent = t("history_clear");
}

''',
            "",
        ),
        (
            '''  clear.addEventListener("click", async () => {
    if (clearArmed === undefined) {
      clear.classList.add("armed");
      clear.textContent = t("history_clear_confirm");
      clearArmed = window.setTimeout(resetClearButton, 3000);
      return;
    }
    await invoke("history_clear");
    await refreshHistory();
  });
''',
            '''  confirmDelete(
    clear,
    "history-all",
    async () => {
      await invoke("history_clear");
      await refreshHistory();
    },
    { label: "history_clear", armedLabel: "history_clear_confirm" },
  );
''',
        ),
    ],
)

# ── dictionary.ts: list rows, search, delete ──────────────────────────────
edit(
    "src/dictionary.ts",
    [
        ('import { t } from "./i18n";\n', 'import { t } from "./i18n";\nimport { deleteButton } from "./confirm-delete";\nimport { matches } from "./search.ts";\n'),
        (
            'const empty = document.getElementById("dict-empty")!;\n',
            'const empty = document.getElementById("dict-empty")!;\nconst noMatch = document.getElementById("dict-no-match")!;\nconst search = document.getElementById("dict-search") as HTMLInputElement;\n',
        ),
        (
            '''    const row = document.createElement("div");
    row.className = "dict-row";
    const text = document.createElement("span");
    text.className = "dict-suggest-text";
    const word = document.createElement("span");
    word.className = "dict-term";
    word.textContent = s.word;
    const heard = document.createElement("span");
    heard.className = "label-hint";
''',
            '''    const row = document.createElement("div");
    row.className = "list-row dict-row";
    const text = document.createElement("span");
    text.className = "list-main dict-suggest-text";
    const word = document.createElement("span");
    word.className = "list-primary dict-term";
    word.textContent = s.word;
    const heard = document.createElement("span");
    heard.className = "list-secondary";
''',
        ),
        (
            '''    const actions = document.createElement("span");
    actions.className = "dict-suggest-actions";
    const addBtn = document.createElement("button");
    addBtn.className = "btn-secondary";
''',
            '''    const actions = document.createElement("span");
    actions.className = "list-actions dict-suggest-actions";
    const addBtn = document.createElement("button");
    addBtn.className = "btn-text";
''',
        ),
        ('    dismiss.className = "btn-ghost";\n', '    dismiss.className = "btn-text";\n'),
        (
            '''  const sorted = [...terms].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  for (const term of sorted) {
    const row = document.createElement("div");
    row.className = "dict-row";
    const label = document.createElement("span");
    label.className = "dict-term";
    label.textContent = term;
    const remove = document.createElement("button");
    remove.className = "btn-ghost";
    remove.textContent = t("replacement_remove");
    remove.addEventListener("click", () => store(stored().filter((x) => x !== term)));
    row.append(label, remove);
    list.appendChild(row);
  }
  empty.classList.toggle("hidden", terms.length > 0);
''',
            '''  const sorted = [...terms].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  // The list is drawn from the setting, so the search simply leaves rows out.
  const found = sorted.filter((term) => matches([term], search.value));
  for (const term of found) {
    const row = document.createElement("div");
    row.className = "list-row dict-row";
    const label = document.createElement("span");
    label.className = "list-main dict-term";
    label.textContent = term;
    const actions = document.createElement("span");
    actions.className = "list-actions";
    actions.append(deleteButton(`word-${term}`, () => store(stored().filter((x) => x !== term)), { name: term }));
    row.append(label, actions);
    list.appendChild(row);
  }
  empty.classList.toggle("hidden", terms.length > 0);
  noMatch.classList.toggle("hidden", terms.length === 0 || found.length > 0);
  search.classList.toggle("hidden", terms.length === 0);
''',
        ),
        (
            "  loadSuggestions();\n",
            "  loadSuggestions();\n  search.addEventListener(\"input\", renderDictionary);\n",
        ),
    ],
)

# ── ai-settings.ts: a rule as a list row ──────────────────────────────────
cut(
    "src/ai-settings.ts",
    "function addRuleRow(rule: AppRule): HTMLElement {\n",
    "  row.append(app, text, language, off, remove);\n  ruleList.appendChild(row);\n  return row;\n}\n",
    '''/** Numbers the rule rows, so each has its own Delete. */
let ruleRows = 0;

function addRuleRow(rule: AppRule): HTMLElement {
  const id = `rule-${++ruleRows}`;
  const row = document.createElement("div");
  row.className = "list-row rule-row";

  const app = document.createElement("input");
  app.type = "text";
  app.className = "rule-app";
  app.value = rule.app;
  app.placeholder = t("ai_rule_app_placeholder");
  app.setAttribute("aria-label", t("rule_app_label"));
  app.spellcheck = false;
  app.setAttribute("list", "ai-open-apps");
  app.addEventListener("focus", refreshOpenApps);

  const text = document.createElement("textarea");
  text.className = "rule-instructions";
  text.rows = 1;
  text.value = rule.instructions;
  text.placeholder = t("ai_rule_instructions_placeholder");
  text.setAttribute("aria-label", t("rule_instructions_label"));
  text.disabled = rule.off;

  // The language Whisper hears in this app; works with AI cleanup off too.
  const language = document.createElement("select");
  language.className = "rule-language";
  language.setAttribute("aria-label", t("rule_language_label"));
  populateLanguageSelect(language, getLang(), t("ai_rule_language_default"), "");
  language.value = rule.language ?? "";
  language.addEventListener("change", saveRules);

  const off = document.createElement("label");
  off.className = "rule-off";
  const offInput = document.createElement("input");
  offInput.type = "checkbox";
  offInput.checked = rule.off;
  const offText = document.createElement("span");
  offText.textContent = t("ai_rule_off");
  off.append(offInput, offText);
  offInput.addEventListener("change", () => {
    text.disabled = offInput.checked;
    saveRules();
  });

  app.addEventListener("change", saveRules);
  text.addEventListener("change", saveRules);

  // The app, its language and "No AI" on one line, the instructions below.
  const line = document.createElement("div");
  line.className = "rule-line";
  line.append(app, language, off);
  const fields = document.createElement("div");
  fields.className = "rule-fields";
  fields.append(line, text);
  const actions = document.createElement("div");
  actions.className = "list-actions";
  actions.append(
    deleteButton(id, () => {
      forgetDelete(id);
      row.remove();
      ruleEmpty.classList.toggle("hidden", ruleList.children.length > 0);
      return saveRules();
    }),
  );

  row.append(fields, actions);
  ruleList.appendChild(row);
  return row;
}
''',
)
edit("src/ai-settings.ts", [('import { sizeText } from "./setup.ts";\n', 'import { sizeText } from "./setup.ts";\nimport { deleteButton, forgetDelete } from "./confirm-delete";\n')])

# ── meetings.ts: Delete with the shared rule ──────────────────────────────
cut(
    "src/meetings.ts",
    "function resetDelete() {\n",
    "    showFlash(errorText(e), \"error\");\n  }\n}\n",
    '''/** Delete the open meeting (the button asks first: src/confirm-delete.ts). */
async function deleteMeeting() {
  if (!view) return;
  const id = view.meeting.id;
  try {
    await invoke("meeting_delete", { id });
    // Its "meetings-changed" may have closed the view already.
    if (!view || view.meeting.id === id) await closeView();
  } catch (e) {
    showFlash(errorText(e), "error");
  }
}
''',
)
s = read("src/meetings.ts")
n_reset = s.count("resetDelete();")
s = s.replace("    resetDelete();\n", "")
s = s.replace("  if (deleteBtn.disabled) resetDelete();\n", "")
assert "resetDelete" not in s, s.count("resetDelete")
assert s.count("let deleteArmed: number | undefined;\n") == 1
s = s.replace("let deleteArmed: number | undefined;\n", "")
assert s.count('  deleteBtn.addEventListener("click", deleteMeeting);\n') == 1
s = s.replace('  deleteBtn.addEventListener("click", deleteMeeting);\n', '  confirmDelete(deleteBtn, "meeting", deleteMeeting);\n')
assert s.count('import { getLang, t } from "./i18n";\n') == 1
s = s.replace('import { getLang, t } from "./i18n";\n', 'import { getLang, t } from "./i18n";\nimport { confirmDelete } from "./confirm-delete";\n')
write("src/meetings.ts", s)

# ── soundboard/board.ts: sounds and categories ────────────────────────────
cut(
    "src/soundboard/board.ts",
    "  function deleteButton(sound: Sound): HTMLElement {\n",
    "    b.setAttribute(\"aria-label\", `${label}: ${sound.name}`);\n    return b;\n  }\n",
    '''  function soundDelete(sound: Sound): HTMLElement {
    const b = deleteButton(
      `sound-${sound.id}`,
      () => api.remove(sound.id).catch((e) => setNotice(`${sound.name}: ${reasonText(String(e))}`, "error")),
      { name: sound.name },
    );
    b.classList.add("sb-delete");
    b.dataset.key = `${sound.id}-delete`;
    return b;
  }
''',
)
edit(
    "src/soundboard/board.ts",
    [
        ('import { hotkeyLabel, startCapture } from "../hotkey-capture";\n', 'import { hotkeyLabel, startCapture } from "../hotkey-capture";\nimport { deleteButton } from "../confirm-delete";\n'),
        ("  let armedDelete: string | null = null;\n  let armedTimer: number | undefined;\n", ""),
        ("el(\"span\", \"sb-length\", clock(sound.durationMs)), deleteButton(sound));", "el(\"span\", \"sb-length\", clock(sound.durationMs)), soundDelete(sound));"),
        (
            '''        const remove = iconButton(X_ICON, t("sb_category_delete"), `chip-${c.id}-delete`, () => {
          api.categoryRemove(c.id).catch((e) => setNotice(reasonText(String(e)), "error"));
        });
''',
            '''        const remove = deleteButton(
          `category-${c.id}`,
          () => api.categoryRemove(c.id).catch((e) => setNotice(reasonText(String(e)), "error")),
          { name: c.name },
        );
        remove.title = t("sb_category_delete");
        remove.dataset.key = `chip-${c.id}-delete`;
''',
        ),
    ],
)
print("ok")
