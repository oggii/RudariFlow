// Hotkey capture, shared by the Recording settings and the Soundboard (tab
// and pop-out window): a key combination or a mouse side button. The
// global hotkeys are released while it listens (`set_hotkey_paused`), so
// pressing a current one reaches the page.
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";

export interface CaptureTarget {
  /** The button that was clicked; a click elsewhere cancels. */
  button: HTMLElement;
  /** Shows "Press a key…", then an error or the saved hotkey. */
  text: HTMLElement;
  /** Keys that work without a modifier (the numpad, F1–F24): soundboard hotkeys only. */
  allowBare?: boolean;
  /** Save the combination; throws the backend's error. */
  apply(combo: string): Promise<void>;
  /** Show the saved hotkey again. */
  render(): void;
  /** Called once the capture is over, saved or not. */
  done?(): void;
}

let capturing: CaptureTarget | null = null;

/** Keys a soundboard hotkey may use alone. */
// NumpadEnter and NumpadEqual are left out: the hotkey crate maps them to Enter and E.
const BARE_KEY = /^(Numpad(?!Enter$|Equal$)\w+|F([1-9]|1\d|2[0-4]))$/;

export function hotkeyLabel(combo: string): string {
  if (!combo) return t("hotkey_none");
  const isMac = navigator.userAgent.includes("Mac");
  return combo
    .replace("CmdOrCtrl", isMac ? "Cmd" : "Ctrl")
    .replace("Mouse4", t("hotkey_mouse4"))
    .replace("Mouse5", t("hotkey_mouse5"));
}

function modifierTokens(e: KeyboardEvent | MouseEvent): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("CmdOrCtrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  return mods;
}

/** Mouse side buttons: MouseEvent.button 3 = back (XBUTTON1), 4 = forward
 *  (XBUTTON2). They work alone or with modifiers. */
export function mouseEventToCombo(e: MouseEvent): string | null {
  const button = e.button === 3 ? "Mouse4" : e.button === 4 ? "Mouse5" : null;
  return button ? [...modifierTokens(e), button].join("+") : null;
}

/** A key event as a hotkey string; null while only modifiers are down, and
 *  for a key alone unless `allowBare` allows it. */
export function keyEventToCombo(e: KeyboardEvent, allowBare = false): string | null {
  const k = e.key;
  if (["Control", "Shift", "Alt", "Meta", "OS"].includes(k)) return null;
  let key = k;
  // The numpad by its physical key: "Numpad1", "NumpadAdd".
  if (e.code.startsWith("Numpad")) key = e.code;
  else if (key === " ") key = "Space";
  else if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
  // Digits and punctuation: e.key changes with Shift ("!" instead of "1")
  // and with the layout (umlauts), so use the physical code (Digit1, Minus).
  else if (key.length === 1) key = e.code;
  // Function keys, arrows, etc. already match (F1, ArrowLeft, ...)
  const mods = modifierTokens(e);
  if (mods.length === 0) return allowBare && BARE_KEY.test(key) ? key : null;
  return [...mods, key].join("+");
}

/** The backend's refusal in words: a Windows shortcut, a key alone, a key another
 *  hotkey has ("Already used by …"), or a key it does not know. */
export function hotkeyError(err: unknown, combo: string): string {
  const reason = String(err);
  if (reason.includes("Windows shortcut")) return t("hotkey_reserved").replace("{combo}", hotkeyLabel(combo));
  if (reason.includes("is a key alone")) return t("hotkey_bare").replace("{combo}", hotkeyLabel(combo));
  const owner = /already used by (\w+)(?::(.*))?$/.exec(reason);
  if (owner) return t("hotkey_taken_by").replace("{name}", ownerName(owner[1], owner[2]));
  return t("hotkey_invalid");
}

function ownerName(target: string, name?: string): string {
  if (target === "sound") return t("quoted").replace("{name}", name ?? "");
  const keys: Record<string, string> = {
    dictation: "hotkey_owner_dictation",
    pasteLast: "paste_last_label",
    rewriteLast: "rewrite_last_label",
    freeGpu: "free_gpu_label",
    stopSounds: "sb_stop_hotkey_label",
  };
  return keys[target] ? t(keys[target]) : target;
}

/** Listen for a hotkey for `target`. False when another capture runs. */
export function startCapture(target: CaptureTarget): boolean {
  if (capturing) return false;
  capturing = target;
  // Release the global hotkeys so pressing a current one reaches this window.
  invoke("set_hotkey_paused", { paused: true }).catch(console.error);
  target.button.classList.add("capturing");
  target.text.textContent = t("hotkey_press_keys");
  window.addEventListener("keydown", onKey, true);
  // Losing focus (Alt+Tab, a pop-out) cancels, so the hotkeys are never left paused.
  window.addEventListener("blur", onBlur);
  // A click outside cancels.
  setTimeout(() => window.addEventListener("mousedown", onMouse, true), 0);
  return true;
}

function stopCapture() {
  const target = capturing;
  capturing = null;
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("mousedown", onMouse, true);
  window.removeEventListener("blur", onBlur);
  invoke("set_hotkey_paused", { paused: false }).catch(console.error);
  if (!target) return;
  target.button.classList.remove("capturing");
  target.render();
  target.done?.();
}

function onBlur() {
  stopCapture();
}

async function onKey(e: KeyboardEvent) {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") {
    stopCapture();
    return;
  }
  const combo = keyEventToCombo(e, capturing?.allowBare);
  if (combo) await apply(combo);
}

async function apply(combo: string) {
  const target = capturing;
  if (!target) return;
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("mousedown", onMouse, true);
  try {
    await target.apply(combo);
    stopCapture();
  } catch (err) {
    target.text.textContent = hotkeyError(err, combo);
    console.error("setting the hotkey failed:", err);
    setTimeout(stopCapture, 2500);
  }
}

function onMouse(e: MouseEvent) {
  if (!capturing) return;
  const combo = mouseEventToCombo(e);
  if (combo) {
    e.preventDefault();
    e.stopPropagation();
    void apply(combo);
    return;
  }
  if (!capturing.button.contains(e.target as Node)) stopCapture();
}

// Side buttons would otherwise go back and forward in the webview.
window.addEventListener("mouseup", (e) => {
  if (e.button === 3 || e.button === 4) e.preventDefault();
});
