// Settings > AI cleanup: model download, on/off, style, instructions, per-app
// rules and a test box. Settings live on main.ts's settings object; this
// module edits the AI fields and asks main.ts to save.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t, getLang } from "./i18n";
import { populateLanguageSelect } from "./languages";
import { downloadFailure, NOT_STARTED, showProgress, type DownloadProgress } from "./progress";
import { onRoute } from "./shell";
import { setDownload } from "./activity";
import { sizeText } from "./size.ts";
import { deleteButton, forgetDelete, nameDelete } from "./confirm-delete";

export interface AppRule {
  app: string;
  instructions: string;
  off: boolean;
  /** Whisper language in this app; "" uses the Language setting (Settings > Models & GPU). */
  language?: string;
}

export interface AiFields {
  aiCleanup: boolean;
  aiModel: string;
  aiStyle: string;
  aiInstructions: string;
  aiRules: AppRule[];
  aiOutputLanguage: string;
  editMode: boolean;
  /** Whisper's language setting (Settings > Models & GPU), for the auto-detect hint. */
  language: string;
}

interface ServerStatus {
  state: "stopped" | "loading" | "ready" | "failed";
  device?: string;
  error?: string;
}

interface AiModelInfo {
  id: string;
  label: string;
  bytes: number;
  downloaded: boolean;
}

interface AiStatus {
  server: ServerStatus;
  installed: boolean;
  models: AiModelInfo[];
  downloading: string | null;
  /** Unloaded by the Free GPU hotkey, for a game or when idle; the next dictation loads it. */
  gpuFreed: boolean;
  /** Freed for a game (Settings > Models & GPU): dictations run without AI cleanup until it ends. */
  gameFreed: boolean;
}

interface Polished {
  text: string;
  raw: string | null;
  fallback: string | null;
  aiMs: number;
}

export interface AiSettingsHost {
  settings(): AiFields;
  /** The settings were read from the backend: `settings()` has them. */
  loaded(): boolean;
  /** Save the settings. A save the backend refuses is said in the page and
   *  the controls go back to what is saved (src/main.ts); false then. */
  save(): Promise<boolean>;
  /** The same save for a caller that says the failure itself (a rule's Delete): it throws. */
  saveStrict(): Promise<void>;
  /** The AI's state was read again (for the status and Home). */
  changed?(): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const toggle = $<HTMLInputElement>("ai-toggle");
const statusLine = $("ai-status-line");
const modelSelect = $<HTMLSelectElement>("ai-model-select");
const modelNote = $("ai-model-note");
const downloadBtn = $<HTMLButtonElement>("ai-download-btn");
/** The same download, next to the switch it unlocks (the model's own row is under Advanced). */
const downloadMain = $<HTMLButtonElement>("ai-download-main");
/** The download's bar and numbers, on the model's row under Advanced. */
const progress = $("ai-download-progress");
const progressParts = { bar: $("ai-progress-bar"), fill: $("ai-progress-fill"), numbers: $("ai-progress-text") };
/** Its percent after the state line beside the switch, which is in view when the fold is closed. */
const statusPercent = $("ai-status-percent");
const stylePolished = $<HTMLButtonElement>("ai-style-polished");
const styleLight = $<HTMLButtonElement>("ai-style-light");
const instructions = $<HTMLTextAreaElement>("ai-instructions");
const outputSelect = $<HTMLSelectElement>("ai-output-select");
const outputWarn = $("ai-output-warn");
const outputSkip = $("ai-output-skip");
const editToggle = $<HTMLInputElement>("ai-edit-toggle");
const ruleList = $("ai-rule-list");
const ruleEmpty = $("ai-rule-empty");
const ruleAdd = $<HTMLButtonElement>("ai-rule-add");
const openApps = $<HTMLDataListElement>("ai-open-apps");
const testInput = $<HTMLTextAreaElement>("ai-test-input");
const testApp = $<HTMLInputElement>("ai-test-app");
const testRun = $<HTMLButtonElement>("ai-test-run");
const testResult = $("ai-test-result");
const testOutput = $("ai-test-output");
const testMeta = $("ai-test-meta");

let host: AiSettingsHost;
let status: AiStatus | null = null;
/** The first question for the AI's state was answered, or it failed: the
 *  status then no longer waits for it (src/status.ts, `aiKnown`). */
let statusKnown = false;
/** Numbers the questions for the AI's state: only the latest one's answer is drawn. */
let statusAsked = 0;

/** What the state line says, as a kind: Home shows the line only for some of them. */
export type AiKind = "" | "not-installed" | "downloading" | "missing" | "off" | "loading" | "ready" | "failed" | "freed" | "starting";
/** The state line as it reads now (its text alone: "Retry" is a button after it). */
let said: { text: string; tone: string; kind: AiKind } = { text: "", tone: "", kind: "" };

/** Written only when it changes: the line is read out (role="status"), and
 *  the backend reports the AI's state more often than it changes. */
function say(text: string, tone: string, kind: AiKind) {
  const same = said.text === text && said.kind === kind;
  said = { text, tone, kind };
  if (!same) statusLine.textContent = text;
  statusLine.dataset.tone = tone;
}

/** The AI model whose download did not finish. Its row and the state line
 *  say so until another model is chosen or a download works; a new try
 *  starts clean. */
let downloadFailed: string | null = null;
/** Why it did not finish, as the backend said it: a full disk is not a bad connection. */
let downloadReason = "";
/** The whole percent of the download that runs; null: none runs. */
let downloadPercent: number | null = null;

/** "The download of Gemma 4 12B · 7.1 GB did not finish. … Reason: …": the same sentence as for the speech model. */
function failureText(model: AiModelInfo): string {
  const name = `${model.label} · ${sizeText(model.bytes)}`.replace(/ /g, "\u00a0");
  return downloadFailure(name, downloadReason);
}

/** The percent after "Downloading the model…". Apart from the state line:
 *  that one is read out, and a percent would be at every step. */
function renderPercent() {
  const text = said.kind === "downloading" && downloadPercent !== null ? `${downloadPercent} %` : "";
  if (statusPercent.textContent !== text) statusPercent.textContent = text;
}

/** "Retry" after the AI did not start. */
function restart() {
  invoke("ai_restart").catch(console.error);
}

const MODEL_NOTE: Record<string, string> = {
  "gemma-4-e4b": "ai_model_recommended",
  "gemma-4-12b": "ai_model_best",
  "gemma-4-e2b": "ai_model_small",
};

/** For the status: AI cleanup is on and its model is loading, or was unloaded to free the GPU. */
export function aiActivity(): { loading: boolean; freed: boolean; known: boolean } {
  if (!status || !host?.loaded() || !host.settings().aiCleanup || !selectedModel()?.downloaded) return { loading: false, freed: false, known: statusKnown };
  return { loading: status.server.state === "loading", freed: status.gpuFreed && status.server.state === "stopped", known: statusKnown };
}

/** For Home: the AI model in use, the state line as it reads in Settings (its text, tone and kind), whether
 *  the model is downloaded, and "Retry" while the line names it: after the
 *  AI did not start, and after the model's download did not finish (the
 *  line says "try again"; in Settings the Download buttons beside it read
 *  "Retry", Home has only this one). */
export function aiSummary(): { name: string; state: string; tone: string; kind: AiKind; downloaded: boolean; failed: boolean; retry: (() => void) | null } {
  const model = selectedModel();
  // The model's download did not finish (the state line says so).
  const failed = !!model && !model.downloaded && downloadFailed === model.id;
  return {
    name: model?.label ?? "",
    state: said.text,
    tone: said.tone,
    kind: said.kind,
    downloaded: !!model?.downloaded,
    failed,
    retry: said.kind === "failed" ? restart : failed && said.kind === "missing" ? () => void download() : null,
  };
}

/** An AI model's name and size, for the setup's suggestion. */
export function aiModelInfo(id: string): { name: string; bytes: number } | null {
  const model = status?.models.find((m) => m.id === id);
  return model ? { name: model.label, bytes: model.bytes } : null;
}

/** Home's setup card: choose this model, download it and turn AI cleanup on. True when it is on. */
export async function setUpAi(id: string): Promise<boolean> {
  if (!host.loaded()) return false;
  if (host.settings().aiModel !== id && status?.models.some((m) => m.id === id)) {
    host.settings().aiModel = id;
    // Not saved: the choice is back on the saved model, and that one's download is not this card's to start.
    if (!(await host.save())) return false;
    await refreshStatus();
  }
  if (!selectedModel()?.downloaded) await download();
  if (!selectedModel()?.downloaded || !status?.installed) return false;
  host.settings().aiCleanup = true;
  toggle.checked = true;
  renderOutputSkip();
  const saved = await host.save();
  await refreshStatus();
  return saved;
}

function selectedModel(): AiModelInfo | undefined {
  if (!host?.loaded()) return undefined;
  return status?.models.find((m) => m.id === host.settings().aiModel);
}

function renderModels() {
  if (!status) return;
  const current = host.settings().aiModel;
  modelSelect.innerHTML = "";
  for (const m of status.models) {
    const option = document.createElement("option");
    option.value = m.id;
    option.textContent = `${m.label} · ${sizeText(m.bytes)}${m.downloaded ? " ✓" : ""}`;
    modelSelect.appendChild(option);
  }
  modelSelect.value = current;
  // The one line about the model: after a download that did not finish it
  // says that, in the colour of an error ("Retry" is the button beside it).
  const model = selectedModel();
  const failed = !!model && !model.downloaded && downloadFailed === model.id;
  const note = MODEL_NOTE[current];
  modelNote.textContent = failed ? failureText(model) : note ? t(note) : "";
  if (failed) modelNote.dataset.tone = "error";
  else delete modelNote.dataset.tone;
  modelNote.classList.toggle("hidden", !failed && !note);
}

function renderStatus() {
  if (!status) return;
  const model = selectedModel();
  const downloading = downloadRuns();
  const downloaded = !!model?.downloaded;
  const failed = !!model && !downloaded && !downloading && downloadFailed === model.id;

  // Both Download buttons: "Retry" after a download that did not finish, and
  // a name that says what ("Download" alone does not).
  for (const button of [downloadBtn, downloadMain]) {
    button.setAttribute("data-i18n", failed ? "retry" : "download");
    button.textContent = t(failed ? "retry" : "download");
    button.setAttribute("aria-label", t(failed ? "setup_ai_retry" : "setup_ai_get"));
  }
  downloadBtn.classList.toggle("hidden", downloaded);
  downloadBtn.disabled = downloading;
  downloadMain.classList.toggle("hidden", downloaded || !status.installed);
  downloadMain.disabled = downloading;
  modelSelect.disabled = downloading;
  progress.classList.toggle("hidden", !downloading);
  // A download this window did not start (it was loaded again meanwhile) has
  // reported nothing here yet: its bar starts at 0 %, not at the last one's numbers.
  if (downloading && downloadPercent === null) {
    downloadPercent = 0;
    showProgress(progressParts, NOT_STARTED);
  }
  toggle.disabled = !downloaded || !status.installed;
  if (!downloaded && toggle.checked) toggle.checked = false;

  let text = "";
  let tone = "";
  let kind: AiKind;
  const server = status.server;
  if (!status.installed) {
    text = t("ai_status_not_installed");
    tone = "error";
    kind = "not-installed";
  } else if (downloading) {
    text = t("ai_status_downloading");
    kind = "downloading";
  } else if (!downloaded) {
    // After a download that did not finish the line says so, here beside the
    // switch too: the model's own row is in the Advanced fold, which may be closed.
    text = failed && model ? failureText(model) : t("ai_status_not_downloaded");
    if (failed) tone = "error";
    kind = "missing";
  } else if (!host.settings().aiCleanup) {
    text = t("ai_status_off");
    kind = "off";
  } else if (server.state === "loading") {
    text = t("ai_status_loading");
    kind = "loading";
  } else if (server.state === "ready") {
    const onCpu = server.device === "CPU";
    text = onCpu ? t("ai_status_ready_cpu") : t("ai_status_ready").replace("{device}", () => server.device ?? "");
    tone = onCpu ? "warn" : "ok";
    kind = "ready";
  } else if (server.state === "failed") {
    text = `${t("ai_status_failed")}: ${server.error ?? ""}`;
    tone = "error";
    kind = "failed";
  } else if (status.gameFreed) {
    text = t("ai_status_game_freed");
    tone = "warn";
    kind = "freed";
  } else if (status.gpuFreed) {
    text = t("ai_status_freed");
    kind = "freed";
  } else {
    text = t("ai_status_starting");
    kind = "starting";
  }
  say(text, tone, kind);
  renderPercent();
  // "Retry" stands after the text; Home has its own button for the same thing (aiSummary).
  if (kind === "failed" && !statusLine.querySelector("button")) {
    const retry = document.createElement("button");
    retry.className = "link-btn";
    retry.textContent = t("ai_retry");
    retry.addEventListener("click", restart);
    statusLine.append(" ", retry);
  }
}

/** A model download runs: one this window started, or one the backend
 *  reports (the window was loaded again while it ran). The one answer for
 *  the model's row, the state line, Home's card and the sidebar's status.
 *  Before, the first three followed the backend's word and the status only
 *  this window's own start, so after a reload they disagreed. */
function downloadRuns(): boolean {
  return downloadInFlight || (status?.downloading ?? null) !== null;
}

/** The models' list and the state line, from what the backend last said. Not
 *  before the settings are known: which model is chosen is one of them. */
function draw() {
  if (!status || !host.loaded()) return;
  renderModels();
  renderStatus();
}

/** Ask the backend for the AI's state and draw it. Of two questions that are
 *  out, only the later one's answer counts: the earlier one can arrive last
 *  and would put an old state (still loading, not yet downloaded) on screen. */
async function refreshStatus() {
  const mine = ++statusAsked;
  let answer: AiStatus;
  try {
    answer = await invoke<AiStatus>("ai_status");
  } catch (e) {
    console.error("ai_status failed:", e);
    if (mine !== statusAsked) return;
    // Nothing is learned, and the status must not wait for it for ever. The
    // switch is usable as it was before the state was ever asked for.
    if (!statusKnown) {
      statusKnown = true;
      toggle.disabled = false;
      host.changed?.();
    }
    return;
  }
  if (mine !== statusAsked) return;
  status = answer;
  statusKnown = true;
  draw();
  // The sidebar's status follows the same word as the row (downloadRuns).
  if (!downloadRuns()) {
    downloadPercent = null;
    setDownload("ai", null);
  } else if (!downloadInFlight) setDownload("ai", downloadPercent ?? 0);
  host.changed?.();
}

/** The AI's state, asked again (the start, an unused AI model was deleted). */
export function refreshAiStatus(): Promise<void> {
  return refreshStatus();
}

async function refreshOpenApps() {
  try {
    const apps = await invoke<string[]>("list_open_apps");
    const ruleApps = host.loaded() ? host.settings().aiRules.map((r) => r.app.trim()).filter(Boolean) : [];
    openApps.innerHTML = "";
    for (const app of [...new Set([...ruleApps, ...apps])]) {
      const option = document.createElement("option");
      option.value = app;
      openApps.appendChild(option);
    }
  } catch (e) {
    console.error("list_open_apps failed:", e);
  }
}

/** A download started here runs: only then its progress counts for the status. */
let downloadInFlight = false;
/** The download that runs. A second word for it (the button pressed twice,
 *  Home's card and this tab) joins it: asked again, the backend answers "A
 *  download is already running", which read as a failure here and took the
 *  download that runs out of the status. */
let downloadRunning: Promise<void> | null = null;

function download(): Promise<void> {
  return (downloadRunning ??= fetchModel().finally(() => (downloadRunning = null)));
}

async function fetchModel() {
  const id = host.settings().aiModel;
  // The keyboard focus is on a control that rests while the download runs
  // (a resting control cannot hold the focus), or goes with its end.
  const at = document.activeElement;
  // A new try starts clean: the last one's failure and its numbers are gone.
  downloadFailed = null;
  downloadReason = "";
  downloadPercent = 0;
  renderModels();
  showProgress(progressParts, NOT_STARTED);
  progress.classList.remove("hidden");
  for (const button of [downloadBtn, downloadMain]) {
    button.setAttribute("data-i18n", "download");
    button.textContent = t("download");
    button.setAttribute("aria-label", t("setup_ai_get"));
    button.disabled = true;
  }
  modelSelect.disabled = true;
  say(t("ai_status_downloading"), "", "downloading");
  renderPercent();
  downloadInFlight = true;
  setDownload("ai", 0);
  let failed = false;
  let reason = "";
  try {
    await invoke("ai_download_model", { id });
  } catch (e) {
    console.error("ai_download_model failed:", e);
    failed = true;
    reason = String(e ?? "");
  }
  downloadInFlight = false;
  downloadPercent = null;
  // The backend's download is over with its answer: what it said before no
  // longer holds (a progress event that arrives late must not bring it back).
  if (status) status.downloading = null;
  setDownload("ai", null);
  // Said by the model's row and by the state line, which refreshStatus() draws (and draws again later),
  // with the backend's reason after it.
  if (failed) {
    downloadFailed = id;
    downloadReason = reason;
  }
  await refreshStatus();
  if (document.activeElement === document.body || document.activeElement === null) {
    if (at === downloadMain) (downloadMain.classList.contains("hidden") ? toggle : downloadMain).focus();
    else if (at === downloadBtn || at === modelSelect) modelSelect.focus();
  }
}

function renderOutputLanguage() {
  const s = host.settings();
  outputSelect.value = "";
  populateLanguageSelect(outputSelect, getLang(), t("ai_output_same"), "");
  outputSelect.value = s.aiOutputLanguage ?? "";
  outputWarn.classList.toggle("hidden", !s.aiOutputLanguage || s.language === "auto");
  renderOutputSkip();
}

/// Where "Write in" does nothing: AI cleanup off, or apps whose rule says No AI.
function renderOutputSkip() {
  const s = host.settings();
  const noAi = (s.aiRules ?? []).filter((r) => r.off && r.app.trim()).map((r) => r.app.trim());
  let text = "";
  if (s.aiOutputLanguage && !s.aiCleanup) text = t("ai_output_skip_off");
  else if (s.aiOutputLanguage && noAi.length) text = t("ai_output_skip_apps").replace("{apps}", () => noAi.join(", "));
  outputSkip.textContent = text;
  outputSkip.classList.toggle("hidden", !text);
}

function setStyle(style: string) {
  for (const [button, on] of [
    [stylePolished, style !== "light"],
    [styleLight, style === "light"],
  ] as const) {
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", String(on));
  }
}

// ── Rules ─────────────────────────────────────────────

function readRules(): AppRule[] {
  return Array.from(ruleList.querySelectorAll<HTMLElement>(".rule-row")).map((row) => ({
    app: (row.querySelector(".rule-app") as HTMLInputElement).value,
    instructions: (row.querySelector(".rule-instructions") as HTMLTextAreaElement).value,
    off: (row.querySelector(".rule-off input") as HTMLInputElement).checked,
    language: (row.querySelector(".rule-language") as HTMLSelectElement).value,
  }));
}

/** The rules as the page has them, saved. A rule's Delete says a failure on
 *  its own button (`strict`: the save throws); a field's change is said in
 *  the page like every other setting. */
async function saveRules(strict = false) {
  if (!host.loaded()) return;
  host.settings().aiRules = readRules();
  renderOutputSkip();
  if (strict) await host.saveStrict();
  else await host.save();
}

/** Numbers the rule rows, so each has its own Delete. */
let ruleRows = 0;

function addRuleRow(rule: AppRule): HTMLElement {
  const id = `rule-${++ruleRows}`;
  const row = document.createElement("div");
  row.className = "list-row rule-row";
  row.setAttribute("role", "listitem");

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
  language.addEventListener("change", () => void saveRules());

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
    void saveRules();
  });

  app.addEventListener("change", () => void saveRules());
  text.addEventListener("change", () => void saveRules());

  // The app, its language and "No AI" on one line, the instructions below.
  const line = document.createElement("div");
  line.className = "rule-line";
  line.append(app, language, off);
  const fields = document.createElement("div");
  fields.className = "rule-fields";
  fields.append(line, text);
  // The rows on the page are what is saved, so the row goes first. A save
  // that fails puts it back and throws: the button says so (src/confirm-delete.ts).
  const del = deleteButton(
    id,
    async () => {
      const next = row.nextSibling;
      row.remove();
      ruleEmpty.classList.toggle("hidden", ruleList.children.length > 0);
      try {
        await saveRules(true);
        forgetDelete(id);
      } catch (err) {
        ruleList.insertBefore(row, next);
        ruleEmpty.classList.add("hidden");
        // The settings in memory hold the rule again (a save reads the page).
        void saveRules(true).catch(() => {});
        throw err;
      }
    },
    // After the last rule "Add rule" takes the focus.
    { name: rule.app.trim(), after: () => ruleAdd },
  );
  // Delete is named after the rule's app, as it reads now.
  app.addEventListener("input", () => nameDelete(del, app.value.trim()));
  const actions = document.createElement("div");
  actions.className = "list-actions";
  actions.append(del);

  row.append(fields, actions);
  ruleList.appendChild(row);
  return row;
}

function renderRules() {
  ruleList.innerHTML = "";
  for (const rule of host.settings().aiRules ?? []) addRuleRow(rule);
  ruleEmpty.classList.toggle("hidden", ruleList.children.length > 0);
}

// ── Test box ──────────────────────────────────────────

/** What "Try it" last answered: the sample as the AI returned it, or the
 *  backend's refusal. Kept so that the line under it is written again in
 *  another Display Language ("Took 412 ms" stood there in the old one). */
let tested: { result: Polished } | { error: string } | null = null;
/** "Try it" runs. */
let testing = false;

function renderTest() {
  testRun.disabled = testing;
  testRun.textContent = t(testing ? "ai_test_running" : "ai_test_run");
  testResult.classList.toggle("hidden", tested === null);
  if (!tested) return;
  if ("error" in tested) {
    testOutput.textContent = "";
    testMeta.textContent = tested.error;
    testMeta.dataset.tone = "error";
    return;
  }
  const { result } = tested;
  testOutput.textContent = result.text;
  testMeta.textContent = result.fallback ? `${t("ai_test_fallback")}: ${result.fallback}` : t("ai_test_time").replace("{ms}", () => String(result.aiMs));
  testMeta.dataset.tone = result.fallback ? "warn" : "";
}

async function runTest() {
  const text = testInput.value.trim();
  if (!text || testing) return;
  testing = true;
  renderTest();
  try {
    tested = { result: await invoke<Polished>("ai_test", { text, app: testApp.value }) };
  } catch (e) {
    tested = { error: String(e) };
  } finally {
    testing = false;
    renderTest();
  }
}

// ── Wiring ────────────────────────────────────────────

export function initAiSettings(h: AiSettingsHost) {
  host = h;

  toggle.addEventListener("change", async () => {
    if (!host.loaded()) return;
    host.settings().aiCleanup = toggle.checked;
    renderOutputSkip();
    await host.save();
    await refreshStatus();
  });

  modelSelect.addEventListener("change", async () => {
    if (!host.loaded()) return;
    // Another choice: what was said of a download that did not finish is over.
    downloadFailed = null;
    downloadReason = "";
    const chosen = modelSelect.value;
    host.settings().aiModel = chosen;
    const saved = await host.save();
    await refreshStatus();
    // Not saved: the list is back on the saved model, and nothing is downloaded for a choice that did not hold.
    if (saved && host.settings().aiModel === chosen && !selectedModel()?.downloaded) await download();
  });

  downloadBtn.addEventListener("click", () => void (host.loaded() && download()));
  downloadMain.addEventListener("click", () => void (host.loaded() && download()));

  for (const [button, style] of [
    [stylePolished, "polished"],
    [styleLight, "light"],
  ] as const) {
    button.addEventListener("click", async () => {
      if (!host.loaded()) return;
      host.settings().aiStyle = style;
      setStyle(style);
      await host.save();
    });
  }

  outputSelect.addEventListener("change", async () => {
    if (!host.loaded()) return;
    host.settings().aiOutputLanguage = outputSelect.value;
    renderOutputLanguage();
    await host.save();
  });

  editToggle.addEventListener("change", async () => {
    if (!host.loaded()) return;
    host.settings().editMode = editToggle.checked;
    await host.save();
  });

  instructions.addEventListener("change", async () => {
    if (!host.loaded()) return;
    host.settings().aiInstructions = instructions.value;
    await host.save();
  });

  ruleAdd.addEventListener("click", () => {
    // The rows on the page are what is saved: none is added before the saved ones are drawn.
    if (!host.loaded()) return;
    const row = addRuleRow({ app: "", instructions: "", off: false, language: "" });
    ruleEmpty.classList.add("hidden");
    (row.querySelector(".rule-app") as HTMLInputElement).focus();
  });

  testApp.addEventListener("focus", refreshOpenApps);
  testRun.addEventListener("click", runTest);
  testInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runTest();
  });

  // The AI tab is shown: its state and the open apps may have changed.
  onRoute((now) => {
    if (now.section !== "settings" || now.tab !== "ai") return;
    refreshStatus();
    refreshOpenApps();
  });

  listen("ai-status", () => refreshStatus());
  listen("game-free", () => refreshStatus());
  listen<DownloadProgress>("ai-download-progress", (event) => {
    // A progress event that arrives after the download ended must not bring
    // it back: not into the row, and not into the status.
    if (!downloadRuns()) return;
    progress.classList.remove("hidden");
    // The bar on the model's row, and always the numbers: percent and size.
    // Nothing of it is read out by itself; the bar has the numbers for a
    // screen reader that asks. The percent also stands beside the switch.
    downloadPercent = showProgress(progressParts, event.payload);
    renderPercent();
    setDownload("ai", event.payload.percent);
  });
}

/// Fill the tab from the settings (after loading them, after a save the
/// backend refused, after a language change), with the AI's state as the
/// backend last reported it. Nothing is asked: everything it shows is known.
export function showAiSettings() {
  const s = host.settings();
  toggle.checked = s.aiCleanup;
  // Whether AI cleanup can be turned on is the backend's to say (is the
  // model there, is the AI installed): until it has, the switch rests.
  if (!statusKnown) toggle.disabled = true;
  editToggle.checked = s.editMode ?? true;
  setStyle(s.aiStyle);
  instructions.value = s.aiInstructions ?? "";
  renderOutputLanguage();
  renderRules();
  renderTest();
  draw();
}
