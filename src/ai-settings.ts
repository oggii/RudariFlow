// AI cleanup tab: model download, on/off, style, instructions, per-app rules
// and a test box. Settings live on main.ts's settings object; this module
// edits the AI fields and asks main.ts to save.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n";

export interface AppRule {
  app: string;
  instructions: string;
  off: boolean;
}

export interface AiFields {
  aiCleanup: boolean;
  aiModel: string;
  aiStyle: string;
  aiInstructions: string;
  aiRules: AppRule[];
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
}

interface Polished {
  text: string;
  raw: string | null;
  fallback: string | null;
  aiMs: number;
}

interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
}

export interface AiSettingsHost {
  settings(): AiFields;
  save(): Promise<void>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const toggle = $<HTMLInputElement>("ai-toggle");
const statusLine = $("ai-status-line");
const modelSelect = $<HTMLSelectElement>("ai-model-select");
const modelNote = $("ai-model-note");
const downloadBtn = $<HTMLButtonElement>("ai-download-btn");
const progress = $("ai-download-progress");
const progressFill = $("ai-progress-fill");
const progressText = $("ai-progress-text");
const stylePolished = $<HTMLButtonElement>("ai-style-polished");
const styleLight = $<HTMLButtonElement>("ai-style-light");
const instructions = $<HTMLTextAreaElement>("ai-instructions");
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

const MODEL_NOTE: Record<string, string> = {
  "gemma-4-e4b": "ai_model_recommended",
  "gemma-4-12b": "ai_model_best",
  "gemma-4-e2b": "ai_model_small",
};

function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(1);
}

function selectedModel(): AiModelInfo | undefined {
  return status?.models.find((m) => m.id === host.settings().aiModel);
}

function renderModels() {
  if (!status) return;
  const current = host.settings().aiModel;
  modelSelect.innerHTML = "";
  for (const m of status.models) {
    const option = document.createElement("option");
    option.value = m.id;
    option.textContent = `${m.label} · ${gb(m.bytes)} GB${m.downloaded ? " ✓" : ""}`;
    modelSelect.appendChild(option);
  }
  modelSelect.value = current;
  const note = MODEL_NOTE[current];
  modelNote.textContent = note ? t(note) : "";
  modelNote.classList.toggle("hidden", !note);
}

function renderStatus() {
  if (!status) return;
  const model = selectedModel();
  const downloading = status.downloading !== null;
  const downloaded = !!model?.downloaded;

  downloadBtn.classList.toggle("hidden", downloaded);
  downloadBtn.disabled = downloading;
  modelSelect.disabled = downloading;
  progress.classList.toggle("hidden", !downloading);
  toggle.disabled = !downloaded || !status.installed;
  if (!downloaded && toggle.checked) toggle.checked = false;

  let text = "";
  let tone = "";
  const server = status.server;
  if (!status.installed) {
    text = t("ai_status_not_installed");
    tone = "error";
  } else if (downloading) {
    text = t("ai_status_downloading");
  } else if (!downloaded) {
    text = t("ai_status_not_downloaded");
  } else if (!host.settings().aiCleanup) {
    text = t("ai_status_off");
  } else if (server.state === "loading") {
    text = t("ai_status_loading");
  } else if (server.state === "ready") {
    const onCpu = server.device === "CPU";
    text = onCpu ? t("ai_status_ready_cpu") : t("ai_status_ready").replace("{device}", server.device ?? "");
    tone = onCpu ? "warn" : "ok";
  } else if (server.state === "failed") {
    text = `${t("ai_status_failed")}: ${server.error ?? ""}`;
    tone = "error";
  } else {
    text = t("ai_status_starting");
  }
  statusLine.textContent = text;
  statusLine.dataset.tone = tone;
  const retry = document.createElement("button");
  if (server.state === "failed" && host.settings().aiCleanup) {
    retry.className = "link-btn";
    retry.textContent = t("ai_retry");
    retry.addEventListener("click", () => invoke("ai_restart").catch(console.error));
    statusLine.append(" ", retry);
  }
}

async function refreshStatus() {
  try {
    status = await invoke<AiStatus>("ai_status");
  } catch (e) {
    console.error("ai_status failed:", e);
    return;
  }
  renderModels();
  renderStatus();
}

async function refreshOpenApps() {
  try {
    const apps = await invoke<string[]>("list_open_apps");
    const ruleApps = host.settings().aiRules.map((r) => r.app.trim()).filter(Boolean);
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

async function download() {
  const id = host.settings().aiModel;
  progressFill.style.width = "0%";
  progressText.textContent = "";
  progress.classList.remove("hidden");
  downloadBtn.disabled = true;
  modelSelect.disabled = true;
  statusLine.textContent = t("ai_status_downloading");
  statusLine.dataset.tone = "";
  try {
    await invoke("ai_download_model", { id });
  } catch (e) {
    console.error("ai_download_model failed:", e);
    statusLine.textContent = `${t("ai_download_failed")}: ${e}`;
    statusLine.dataset.tone = "error";
  }
  await refreshStatus();
}

function setStyle(style: string) {
  stylePolished.classList.toggle("active", style !== "light");
  styleLight.classList.toggle("active", style === "light");
}

// ── Rules ─────────────────────────────────────────────

function readRules(): AppRule[] {
  return Array.from(ruleList.querySelectorAll<HTMLElement>(".rule-row")).map((row) => ({
    app: (row.querySelector(".rule-app") as HTMLInputElement).value,
    instructions: (row.querySelector(".rule-instructions") as HTMLTextAreaElement).value,
    off: (row.querySelector(".rule-off input") as HTMLInputElement).checked,
  }));
}

async function saveRules() {
  host.settings().aiRules = readRules();
  await host.save();
}

function addRuleRow(rule: AppRule): HTMLElement {
  const row = document.createElement("div");
  row.className = "rule-row";

  const app = document.createElement("input");
  app.type = "text";
  app.className = "rule-app";
  app.value = rule.app;
  app.placeholder = t("ai_rule_app_placeholder");
  app.spellcheck = false;
  app.setAttribute("list", "ai-open-apps");
  app.addEventListener("focus", refreshOpenApps);

  const text = document.createElement("textarea");
  text.className = "rule-instructions";
  text.rows = 1;
  text.value = rule.instructions;
  text.placeholder = t("ai_rule_instructions_placeholder");
  text.disabled = rule.off;

  const off = document.createElement("label");
  off.className = "rule-off";
  off.title = t("ai_rule_off_hint");
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

  const remove = document.createElement("button");
  remove.className = "icon-btn";
  remove.title = t("replacement_remove");
  remove.setAttribute("aria-label", t("replacement_remove"));
  remove.innerHTML =
    '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  remove.addEventListener("click", () => {
    row.remove();
    ruleEmpty.classList.toggle("hidden", ruleList.children.length > 0);
    saveRules();
  });

  app.addEventListener("change", saveRules);
  text.addEventListener("change", saveRules);

  row.append(app, text, off, remove);
  ruleList.appendChild(row);
  return row;
}

function renderRules() {
  ruleList.innerHTML = "";
  for (const rule of host.settings().aiRules ?? []) addRuleRow(rule);
  ruleEmpty.classList.toggle("hidden", ruleList.children.length > 0);
}

// ── Test box ──────────────────────────────────────────

async function runTest() {
  const text = testInput.value.trim();
  if (!text) return;
  testRun.disabled = true;
  testRun.textContent = t("ai_test_running");
  try {
    const result = await invoke<Polished>("ai_test", { text, app: testApp.value });
    testOutput.textContent = result.text;
    testMeta.textContent = result.fallback
      ? `${t("ai_test_fallback")}: ${result.fallback}`
      : t("ai_test_time").replace("{ms}", String(result.aiMs));
    testMeta.dataset.tone = result.fallback ? "warn" : "";
    testResult.classList.remove("hidden");
  } catch (e) {
    testOutput.textContent = "";
    testMeta.textContent = String(e);
    testMeta.dataset.tone = "error";
    testResult.classList.remove("hidden");
  } finally {
    testRun.disabled = false;
    testRun.textContent = t("ai_test_run");
  }
}

// ── Wiring ────────────────────────────────────────────

export function initAiSettings(h: AiSettingsHost) {
  host = h;

  toggle.addEventListener("change", async () => {
    host.settings().aiCleanup = toggle.checked;
    await host.save();
    await refreshStatus();
  });

  modelSelect.addEventListener("change", async () => {
    host.settings().aiModel = modelSelect.value;
    await host.save();
    await refreshStatus();
    if (!selectedModel()?.downloaded) await download();
  });

  downloadBtn.addEventListener("click", download);

  for (const [button, style] of [
    [stylePolished, "polished"],
    [styleLight, "light"],
  ] as const) {
    button.addEventListener("click", async () => {
      host.settings().aiStyle = style;
      setStyle(style);
      await host.save();
    });
  }

  instructions.addEventListener("change", async () => {
    host.settings().aiInstructions = instructions.value;
    await host.save();
  });

  ruleAdd.addEventListener("click", () => {
    const row = addRuleRow({ app: "", instructions: "", off: false });
    ruleEmpty.classList.add("hidden");
    (row.querySelector(".rule-app") as HTMLInputElement).focus();
  });

  testApp.addEventListener("focus", refreshOpenApps);
  testRun.addEventListener("click", runTest);
  testInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runTest();
  });

  document.querySelector('.nav-item[data-section="ai"]')?.addEventListener("click", () => {
    refreshStatus();
    refreshOpenApps();
  });

  listen("ai-status", () => refreshStatus());
  listen<DownloadProgress>("ai-download-progress", (event) => {
    const { downloaded, total, percent } = event.payload;
    progress.classList.remove("hidden");
    progressFill.style.width = `${percent}%`;
    progressText.textContent = total ? `${gb(downloaded)} / ${gb(total)} GB` : "";
  });
}

/// Fill the tab from the settings (after loading them or a language change).
export async function renderAiSettings() {
  const s = host.settings();
  toggle.checked = s.aiCleanup;
  setStyle(s.aiStyle);
  instructions.value = s.aiInstructions ?? "";
  renderRules();
  await refreshStatus();
}
