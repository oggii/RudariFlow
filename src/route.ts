// Where the window is: one of five sidebar sections, and inside Settings one
// of five tabs. Pure (tests/unit/route.test.ts); src/shell.ts shows it.

export const SECTIONS = ["home", "files", "meetings", "soundboard", "settings"] as const;
export type Section = (typeof SECTIONS)[number];

export const TABS = ["dictation", "ai", "dictionary", "models", "general"] as const;
export type Tab = (typeof TABS)[number];

export interface Route {
  section: Section;
  /** The Settings tab; kept while another section shows, so Settings opens where it was left. */
  tab: Tab;
}

export const HOME: Route = { section: "home", tab: "dictation" };

const isSection = (s: unknown): s is Section => SECTIONS.includes(s as Section);
const isTab = (s: unknown): s is Tab => TABS.includes(s as Tab);

/** A saved or requested place; anything unknown falls back to Home / the first tab. */
export function route(section: unknown, tab: unknown): Route {
  return { section: isSection(section) ? section : "home", tab: isTab(tab) ? tab : "dictation" };
}

/** Where the window opens: where it was left, but on Home for a first run
 *  (src/setup.ts, `firstRun`: the steps are there). Someone who has dictated
 *  before and lacks a microphone today finds the window as they left it. */
export function startRoute(saved: Route, firstRun: boolean): Route {
  return firstRun ? { section: "home", tab: saved.tab } : saved;
}

/** The ten sections of 0.16 and where their content lives now. */
const OLD: Record<string, [Section, Tab | null]> = {
  general: ["settings", "general"],
  engine: ["settings", "models"],
  recording: ["settings", "dictation"],
  dictionary: ["settings", "dictionary"],
  replacements: ["settings", "dictionary"],
  ai: ["settings", "ai"],
  history: ["home", null],
};

/** A name from 0.16 ("engine") or a new one ("settings", "settings/models") as a route; `from` keeps its tab where the name has none or one that does not exist. */
export function resolve(name: string, from: Route): Route {
  const [first, second] = name.split("/");
  const old = OLD[first];
  if (old) return { section: old[0], tab: old[1] ?? from.tab };
  return route(first, isTab(second) ? second : from.tab);
}
