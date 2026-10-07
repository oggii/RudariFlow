// The settings round trip against the mocked backend: every control shows
// the value that was saved, and changing it sends that value back
// (`save_settings`, `change_hotkey`). The controls are found by their ids,
// wherever the redesign puts them, so a control that moved keeps passing and
// one that lost its id or its handler fails.

/** What each control shows after the "populated" settings loaded: [selector, property, expected]. */
const SHOWN = [
  ["#mic-select", "value", "default"],
  ["#ui-language-select", "value", "en"],
  ["#volume-slider", "value", "0.4"],
  ["#autostart-toggle", "checked", true],
  ["#engine-local", "active", true],
  ["#gpu-backend-select", "value", "auto"],
  ["#language-select", "value", "auto"],
  ["#model-select", "value", "large-v3-turbo-q8_0"],
  ["#game-free-toggle", "checked", true],
  ["#idle-unload-select", "value", "30"],
  ["#mode-ptt", "active", true],
  ["#hotkey-text", "text", "Ctrl+Shift+Space"],
  ["#paste-last-text", "text", "Alt+Shift+V"],
  ["#rewrite-last-text", "text", "Alt+Shift+R"],
  ["#free-gpu-text", "text", "Not set"],
  ["#meeting-hotkey-text", "text", "Alt+Shift+M"],
  ["#send-command-select", "value", "enter"],
  ["#mute-audio-toggle", "checked", true],
  ["#swiss-toggle", "checked", true],
  ["#screen-toggle", "checked", true],
  ["#learn-toggle", "checked", true],
  ["#dict-list .dict-row", "count", 12],
  ["#replacement-list .replacement-row", "count", 3],
  ["#ai-toggle", "checked", true],
  ["#ai-model-select", "value", "gemma-4-e4b"],
  ["#ai-style-polished", "active", true],
  ["#ai-output-select", "value", ""],
  ["#ai-edit-toggle", "checked", true],
  ["#ai-instructions", "value", "Always use du, never Sie. No emojis."],
  ["#ai-rule-list .rule-row", "count", 3],
  ["#history-mode-select", "value", "audio"],
  ["#file-speakers", "value", "auto"],
];

const setValue = (selector, value) => (page) =>
  page.evaluate(
    ([selector, value]) => {
      const el = document.querySelector(selector);
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    [selector, value],
  );
const click = (selector) => (page) => page.evaluate((selector) => document.querySelector(selector).click(), selector);
const saved = (key, expected) => ({ kind: "setting", key, expected });
const hotkey = (target, combo) => ({ kind: "hotkey", target, combo });

/** A hotkey button, then the keys: the capture of hotkey-capture.ts. */
const capture = (button, keys) => async (page) => {
  await click(button)(page);
  await page.waitForTimeout(60);
  await page.keyboard.press(keys);
};

/** [name, what to do, what the backend must have received]. */
const CHANGES = [
  ["microphone", setValue("#mic-select", "Headset Microphone (Logitech PRO X)"), saved("microphone", "Headset Microphone (Logitech PRO X)")],
  ["notification volume", setValue("#volume-slider", "0.7"), saved("volume", 0.7)],
  ["start with the computer", click("#autostart-toggle"), saved("autostart", false)],
  ["engine: cloud", click("#engine-cloud"), saved("engine", "cloud")],
  ["Groq key", setValue("#groq-key", "gsk_check"), saved("groqApiKey", "gsk_check")],
  ["engine: local", click("#engine-local"), saved("engine", "local")],
  ["GPU backend", setValue("#gpu-backend-select", "vulkan"), saved("gpuBackend", "vulkan")],
  ["dictation language", setValue("#language-select", "de"), saved("language", "de")],
  ["speech model", setValue("#model-select", "medium"), saved("whisperModel", "medium")],
  ["Free GPU for games", click("#game-free-toggle"), saved("freeGpuForGames", false)],
  ["unload when idle", setValue("#idle-unload-select", "60"), saved("idleUnloadMinutes", 60)],
  ["mode: toggle", click("#mode-toggle"), saved("recordingMode", "toggle")],
  ["mode: push to talk", click("#mode-ptt"), saved("recordingMode", "push-to-talk")],
  ["dictation hotkey", capture("#hotkey-btn", "Control+Alt+KeyD"), hotkey("dictation", "CmdOrCtrl+Alt+D")],
  ["paste-last hotkey", capture("#paste-last-btn", "Control+Alt+KeyP"), hotkey("pasteLast", "CmdOrCtrl+Alt+P")],
  ["rewrite-last hotkey", capture("#rewrite-last-btn", "Control+Alt+KeyR"), hotkey("rewriteLast", "CmdOrCtrl+Alt+R")],
  ["Free GPU hotkey", capture("#free-gpu-btn", "Control+Alt+KeyG"), hotkey("freeGpu", "CmdOrCtrl+Alt+G")],
  ["meeting hotkey", capture("#meeting-hotkey-btn", "Control+Alt+KeyM"), hotkey("meeting", "CmdOrCtrl+Alt+M")],
  ["paste-last hotkey off", click("#paste-last-clear"), hotkey("pasteLast", "")],
  ["rewrite-last hotkey off", click("#rewrite-last-clear"), hotkey("rewriteLast", "")],
  ["Free GPU hotkey off", click("#free-gpu-clear"), hotkey("freeGpu", "")],
  ["meeting hotkey off", click("#meeting-hotkey-clear"), hotkey("meeting", "")],
  ["send command", setValue("#send-command-select", "ctrl+enter"), saved("sendCommand", "ctrl+enter")],
  ["mute other apps", click("#mute-audio-toggle"), saved("muteAudio", false)],
  ["Swiss spelling", click("#swiss-toggle"), saved("swissSpelling", false)],
  ["words on screen", click("#screen-toggle"), saved("screenContext", false)],
  ["learn from corrections", click("#learn-toggle"), saved("learnDictionary", false)],
  [
    "a new dictionary word",
    async (page) => {
      await page.evaluate(() => {
        document.querySelector("#dict-input").value = "Zeitgeist";
        document.querySelector("#dict-form").requestSubmit();
      });
    },
    { kind: "check", test: (s) => s.customPrompt.endsWith(", Zeitgeist"), expected: "customPrompt ends with “, Zeitgeist”" },
  ],
  [
    "a new replacement",
    async (page) => {
      await click("#replacement-add")(page);
      await setValue("#replacement-list .replacement-row:last-child .replacement-from", "my phone")(page);
      await setValue("#replacement-list .replacement-row:last-child .replacement-to", "+41 44 000 00 00")(page);
    },
    { kind: "check", test: (s) => s.replacements.length === 4 && s.replacements[3].from === "my phone" && s.replacements[3].to === "+41 44 000 00 00", expected: "four replacements, the last one “my phone”" },
  ],
  ["AI cleanup", click("#ai-toggle"), saved("aiCleanup", false)],
  ["AI model", setValue("#ai-model-select", "gemma-4-e2b"), saved("aiModel", "gemma-4-e2b")],
  ["AI style", click("#ai-style-light"), saved("aiStyle", "light")],
  ["write in", setValue("#ai-output-select", "en"), saved("aiOutputLanguage", "en")],
  ["Edit mode", click("#ai-edit-toggle"), saved("editMode", false)],
  ["instructions for all apps", setValue("#ai-instructions", "Short sentences."), saved("aiInstructions", "Short sentences.")],
  [
    "a new app rule",
    async (page) => {
      await click("#ai-rule-add")(page);
      await setValue("#ai-rule-list .rule-row:last-child .rule-app", "slack")(page);
    },
    { kind: "check", test: (s) => s.aiRules.length === 4 && s.aiRules[3].app === "slack", expected: "four rules, the last one for “slack”" },
  ],
  ["keep history", setValue("#history-mode-select", "text"), saved("history", "text")],
  ["file speakers", setValue("#file-speakers", "3"), saved("fileSpeakers", "3")],
  ["display language", setValue("#ui-language-select", "de"), saved("uiLanguage", "de")],
];

/** Runs in the page: read one row of SHOWN. */
function readShown([selector, property]) {
  if (property === "count") return document.querySelectorAll(selector).length;
  const el = document.querySelector(selector);
  if (!el) return "(no such element)";
  if (property === "active") return el.classList.contains("active");
  if (property === "text") return el.textContent.trim();
  return el[property];
}

/**
 * `page` is a freshly loaded main window (populated, English); the caller
 * closes it. Returns findings.
 */
export async function roundtrip(page) {
  const out = [];
  const add = (what, detail) => out.push({ check: "roundtrip", page: "settings", what, detail });
  // The redesign may lose or rename no key of config.json: whatever the page
  // saves must still have every key the settings had when it loaded.
  const keys = await page.evaluate(() => window.__MOCK_KEYS__ ?? []);
  if (!keys.length) add("the settings at the start", "the mocked backend holds no settings, so no key can be watched");
  const lost = new Set();
  let watched = 0;
  /** Every save the page sent since the last look still has every key; `when` names the moment in a finding. */
  const keepsKeys = async (when) => {
    const calls = await page.evaluate((from) => window.__MOCK__.calls.slice(from), watched);
    watched += calls.length;
    for (const call of calls) {
      if (call.cmd !== "save_settings") continue;
      for (const key of keys) {
        if (lost.has(key) || (call.args.settings && key in call.args.settings)) continue;
        lost.add(key);
        add(`settings key ${key}`, `gone from the settings the page saved ${when}`);
      }
    }
  };
  await keepsKeys("while it loaded");
  for (const row of SHOWN) {
    const got = await page.evaluate(readShown, row);
    if (got !== row[2]) add(`${row[0]} shows the saved value`, `expected ${JSON.stringify(row[2])}, got ${JSON.stringify(got)}`);
  }
  for (const [name, act, want] of CHANGES) {
    const before = await page.evaluate(() => window.__MOCK__.calls.length);
    try {
      await act(page);
    } catch (e) {
      add(name, `could not be changed: ${String(e).split("\n")[0]}`);
      continue;
    }
    await page.waitForTimeout(120);
    const { calls, settings } = await page.evaluate((from) => ({ calls: window.__MOCK__.calls.slice(from), settings: window.__MOCK__.settings() }), before);
    await keepsKeys(`after “${name}”`);
    if (want.kind === "hotkey") {
      const call = calls.find((c) => c.cmd === "change_hotkey");
      const ok = call && call.args.target === want.target && call.args.newHotkey === want.combo;
      if (!ok) add(name, `expected change_hotkey { target: "${want.target}", newHotkey: "${want.combo}" }, got ${JSON.stringify(call?.args ?? null)}`);
      continue;
    }
    if (!calls.some((c) => c.cmd === "save_settings")) {
      add(name, "save_settings was not called");
      continue;
    }
    if (want.kind === "setting" && settings[want.key] !== want.expected) {
      add(name, `expected ${want.key} = ${JSON.stringify(want.expected)}, saved ${JSON.stringify(settings[want.key])}`);
    }
    if (want.kind === "check" && !want.test(settings)) add(name, `expected ${want.expected}`);
  }
  return out;
}
