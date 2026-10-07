// What the window remembers between starts: the section and Settings tab it
// was left on, which Advanced folds are open, and two dismissals. This is
// view state, kept in the webview's localStorage under one key; settings
// stay in config.json. Pure but for the store it is handed
// (tests/unit/prefs.test.ts).

export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Prefs {
  section: string;
  tab: string;
  /** Advanced folds that are open, by Settings tab. */
  folds: Record<string, boolean>;
  /** The Soundboard's settings panel, by layout ("wide" / "narrow" / "popout"): open or closed by the user. */
  panels: Record<string, boolean>;
  /** The optional "AI cleanup" card on Home was closed. */
  aiCardDismissed: boolean;
}

export const PREFS_KEY = "rudariflow-ui";

export function defaultPrefs(): Prefs {
  return { section: "home", tab: "dictation", folds: {}, panels: {}, aiCardDismissed: false };
}

const flags = (value: unknown): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  if (value && typeof value === "object") {
    for (const [key, on] of Object.entries(value)) if (typeof on === "boolean") out[key] = on;
  }
  return out;
};

/** The saved preferences; anything missing, damaged or unreadable is the default. */
export function loadPrefs(store: Store | null): Prefs {
  const prefs = defaultPrefs();
  try {
    const saved: unknown = JSON.parse(store?.getItem(PREFS_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return prefs;
    const s = saved as Record<string, unknown>;
    if (typeof s.section === "string") prefs.section = s.section;
    if (typeof s.tab === "string") prefs.tab = s.tab;
    prefs.folds = flags(s.folds);
    prefs.panels = flags(s.panels);
    prefs.aiCardDismissed = s.aiCardDismissed === true;
  } catch {
    // A private window or damaged JSON: the defaults.
  }
  return prefs;
}

/** False when the store refused (the window then just forgets). */
export function savePrefs(store: Store | null, prefs: Prefs): boolean {
  try {
    store?.setItem(PREFS_KEY, JSON.stringify(prefs));
    return store !== null;
  } catch {
    return false;
  }
}

/**
 * Change what is remembered. The main window and the Soundboard pop-out share
 * the store, so the saved value is read again first and only `change` is
 * applied to it: neither window writes back what it read at its own start.
 * `current` is this window's copy; it gets the change too. Returns the
 * preferences to go on with: the saved ones, or `current` when the store
 * refused.
 */
export function changePrefs(store: Store | null, current: Prefs, change: (prefs: Prefs) => void): Prefs {
  change(current);
  const saved = loadPrefs(store);
  change(saved);
  return savePrefs(store, saved) ? saved : current;
}
