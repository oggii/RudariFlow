// Home, the dictation page. The daily view: the hotkeys (set in place), the
// quick switches (the same settings as in Settings, mirrored), what is
// loaded, "add a word", and the recent dictations (src/history.ts). Before
// the setup is done: the first-run steps instead.
import { t } from "./i18n";
import { mirrorHint, mirrorSelect, mirrorSwitch } from "./mirror";
import { reveal } from "./shell";
import { currentSpeech, currentStatus, onStatus } from "./status-view";
import { homeTitle, statusText, type Status } from "./status.ts";

export interface HomeHost {
  /** "push-to-talk" or "toggle". */
  recordingMode(): string;
  /** The dictation hotkey as it is shown ("Ctrl+Shift+Space"). */
  dictationKey(): string;
  /** The AI model in use and its state line, as Settings shows them: the
   *  text, its tone, what kind of state it is ("ready", "off", "missing",
   *  "loading", "failed" …) and, after a failed start, the way to try again. */
  ai(): { name: string; state: string; tone: string; kind: string; downloaded: boolean; retry: (() => void) | null };
  /** Add words to the dictionary; how many were new. */
  addWords(text: string): Promise<number>;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const title = $("home-title");
const pill = $("home-status");
const pillText = $("home-status-text");
const how = $("home-how");
const notice = $("home-notice");
const daily = $("home-daily");
const recent = $("home-recent");

let host: HomeHost;
let syncs: (() => void)[] = [];
/** The layout the cards are in: two columns or one; null before the first look. */
let laidOutWide: boolean | null = null;

// ── Header ────────────────────────────────────────────

/** "Hold ‹key› and speak.": the sentence with the key as a key box. */
function renderHow() {
  const [before, after] = t(host.recordingMode() === "toggle" ? "home_how_toggle" : "home_how_hold").split("{key}");
  const key = document.createElement("kbd");
  key.textContent = host.dictationKey();
  how.replaceChildren(before, key, after ?? "");
}

function renderHeader(now: Status, firstRun: boolean) {
  const { key, n } = statusText(now);
  title.removeAttribute("data-i18n");
  title.textContent = t(firstRun ? "setup_title" : homeTitle(now));
  pill.dataset.tone = now.tone;
  pillText.textContent = t(key).replace("{n}", n);
  how.classList.toggle("hidden", firstRun);
  // The speech model is there and did not load: say what helps.
  notice.classList.toggle("hidden", !now.missing.includes("load"));
}

// ── What is loaded ────────────────────────────────────

/** The speech model's name as its dropdown shows it, without the "downloaded" mark. */
function speechModelName(id: string): string {
  const option = document.querySelector<HTMLOptionElement>(`#model-select option[value="${CSS.escape(id)}"]`);
  return (option?.dataset.baseText ?? option?.textContent ?? id).replace(/\s*✓$/, "");
}

function renderLoaded() {
  const speech = currentSpeech();
  const speechLine = $("home-loaded-speech");
  if (!speech) {
    speechLine.textContent = "";
  } else if (speech.engine === "cloud") {
    speechLine.textContent = speech.cloudKey ? t("engine_cloud") : `${t("engine_cloud")} · ${t("home_key_missing")}`;
    speechLine.dataset.tone = speech.cloudKey ? "" : "warn";
  } else {
    const state: Record<string, string> = {
      loaded: speech.device,
      loading: t("home_speech_loading"),
      failed: t("home_speech_failed"),
      unloaded: speech.downloaded ? t("home_speech_unloaded") : t("home_speech_missing"),
    };
    // The name alone: the dropdown's size and note ("(~870 MB) …") belong to the choice, not to this line.
    speechLine.textContent = `${speechModelName(speech.model).replace(/\s*\(.*$/, "")} · ${state[speech.load]}`;
    // A value is plain text. Only what is missing or failed is tinted, in all three lines.
    speechLine.dataset.tone = speech.load === "failed" || !speech.downloaded ? "warn" : "";
  }
  const ai = host.ai();
  const aiLine = $("home-loaded-ai");
  // A model that is not downloaded says so, as the speech model's line does.
  aiLine.textContent = ai.name ? `${ai.name} · ${ai.kind === "missing" ? t("home_speech_missing") : ai.state}` : "";
  aiLine.dataset.tone = ai.kind === "missing" ? "warn" : ai.tone === "ok" ? "" : ai.tone;
  const mic = document.querySelector<HTMLSelectElement>("#mic-select")?.selectedOptions[0];
  const micLine = $("home-loaded-mic");
  const noMic = currentStatus().missing.includes("microphone");
  micLine.textContent = noMic ? t("home_mic_missing") : (mic?.textContent ?? "");
  micLine.dataset.tone = noMic || mic?.dataset.missing ? "warn" : "";
  // The AI's state under the quick switch, only when there is something to
  // say: it loads, or it is not available. "Ready" and "Off" are the switch
  // itself and the line above. Empty when hidden: it describes the switch.
  const line = $("home-ai-status");
  const said = ai.kind === "ready" || ai.kind === "off" ? "" : ai.state;
  line.textContent = said;
  line.dataset.tone = ai.tone;
  line.classList.toggle("hidden", said === "");
  $("home-ai-retry").classList.toggle("hidden", ai.retry === null);
}

// ── Layout ────────────────────────────────────────────

/** Two columns from 900 px of content; in one column the recent dictations
 *  come right after the quick switches. The card is moved, so the Tab order
 *  is the order on the page in both. From 1600 px the controls are two
 *  columns themselves (styles/home.css), so a large window is filled.
 *
 *  The width is the one with the scrollbar's room in it. `clientWidth`
 *  loses that room when the page gets a scrollbar: a layout that decides on
 *  it and is higher in the wider form brings its own scrollbar, loses the
 *  width, steps back, loses the scrollbar, and so on in every frame. */
function layout() {
  const width = $("content").offsetWidth;
  const wide = width >= 900;
  daily.classList.toggle("wider", width >= 1600);
  if (wide === laidOutWide) return;
  laidOutWide = wide;
  daily.classList.toggle("wide", wide);
  if (wide) daily.append(recent);
  else $("home-switches").after(recent);
}

// ── Wiring ────────────────────────────────────────────

/** Draw Home again from the settings and the status (after a load, a save, a language change). */
export function renderHome() {
  if (!host) return;
  for (const sync of syncs) sync();
  const now = currentStatus();
  renderHeader(now, false);
  renderHow();
  renderLoaded();
}

export function initHome(h: HomeHost) {
  host = h;
  const select = (id: string) => $<HTMLSelectElement>(id);
  syncs = [
    mirrorSwitch($<HTMLInputElement>("ai-toggle"), $<HTMLInputElement>("home-ai-toggle")),
    mirrorSelect(select("language-select"), select("home-language-select")),
    mirrorSelect(select("ai-output-select"), select("home-output-select")),
    // Why "Write in" translates nothing at the moment, as Settings says it under the same control.
    mirrorHint([$("ai-output-skip"), $("ai-output-warn")], $("home-output-hint")),
  ];
  $("home-ai-retry").addEventListener("click", () => host.ai().retry?.());

  for (const row of document.querySelectorAll<HTMLElement>("#home-loaded [data-reveal]")) {
    row.addEventListener("click", () => {
      const id = row.dataset.reveal ?? "";
      // With the cloud engine there is no speech model to choose (its row is hidden): the key is the setting.
      reveal(id === "model-select" && currentSpeech()?.engine === "cloud" ? "groq-key" : id);
    });
  }
  $("home-notice-open").addEventListener("click", () => reveal("model-select"));

  const wordForm = $<HTMLFormElement>("home-word-form");
  const wordInput = $<HTMLInputElement>("home-word-input");
  wordForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const word = wordInput.value.trim();
    if (!word) return;
    const added = await host.addWords(word);
    $("home-word-status").textContent = added > 0 ? t("home_word_added").replace("{word}", () => word) : t("home_word_known");
    wordInput.value = "";
    wordInput.focus();
  });

  new ResizeObserver(layout).observe($("content"));
  layout();
  onStatus(renderHome);
  renderHome();
}
