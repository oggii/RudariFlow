# UI redesign: easy and übersichtlich (design)

Date: 2026-10-06. Branch `feature/ui-redesign` from main 84447e5 (0.16.0). Ships as 0.17.0.

Basis: the audit of 0.16.0 in `2026-10-06-ui-audit.md` (10 flat tabs, 41 setting rows, 196 visible controls, 64 help texts; no start page; "Ready" without a model; the tenth tab cut off at the default window; settings scattered; grey hint text below AA). Mockups the user chose from: `2026-10-06-ui-redesign-mockups/` (navigation → C, home → 2, settings → 1, look → B).

## Decisions (the user's)

- **Goal:** as easy and übersichtlich as possible, for a newcomer and a power user alike: a simple default, everything else behind "Advanced".
- **Navigation C:** five sidebar items — Home, Files, Meetings, Soundboard, Settings. Home is the dictation page.
- **Home layout 2:** two columns on wide windows (controls left, recent dictations right), one column when narrow.
- **Settings 1:** five tabs along the top — Dictation, AI cleanup, Dictionary, Models & GPU, General — each with an Advanced fold.
- **Look B:** calm and airy dark: bigger type, more room, softer surfaces.
- **Scope:** interface only. No feature changes, no settings lost or renamed in `config.json`. No light theme in this round.

## Structure

### Sidebar

- Logo small (one line); items Home, Files, Meetings, Soundboard; Settings at the bottom; version below it. Everything is visible at the minimum window (900×600) and the sidebar scrolls if it ever does not fit.
- The **status** sits under the logo and at the top of Home, one value at a time, with this priority: Setup needed (what is missing) › Downloading n % › Recording › Transcribing › Meeting recording › Transcribing a file › Loading models… › Freed for a game / GPU freed › Ready. A recording meeting or a running file also shows a small secondary marker when another state has priority. "Ready" only when a speech model is downloaded and loaded (or the cloud engine is set up) and a microphone is available.
- Navigation items are real buttons/links reachable by Tab, with the current one marked (`aria-current`).

### Home

- **Header:** "Ready to dictate" + status; one line "Hold ‹key› and speak." (wording follows hold/toggle).
- **Left column:**
  - **Hotkeys card:** Dictate, Paste last, Rewrite last, Free GPU (unset ones say "Not set · Set"). Clicking a key starts the existing capture in place.
  - **Quick switches card:** AI cleanup (on/off, with its state line when it is loading or unavailable), Language, Write in.
  - **Loaded card:** Whisper model and device, AI model and state, microphone; each line links to its setting.
  - **Add word** to the dictionary (one field + Add).
- **Right column — Recent dictations:** search (text and app), entries as today's History rows in the new list design (text, app, time; Copy; with a recording: play, Re-run), "Show all" expands the list on the page to the full history (the same list, paged in chunks of 50). History is no longer a sidebar item; its "keep text / audio / off" setting moves to Settings › General.
- **Narrow (content < 900 px):** one column: header, hotkeys, quick switches, recent dictations, loaded card.

### First run (Home before setup is complete)

- Shown while no speech model is available for the chosen engine or no microphone is found. Status: "Setup needed".
- Steps: (1) **Microphone** — the detected device with a live level, Change; (2) **Speech model** — the recommendation for this PC's graphics card (the PC check's rule), Download with percent and size; (3) **Your dictation key** — shown and changeable, with "Hold it, speak, release — the text is typed where your cursor is."; (+) **Optional: AI cleanup** — what it does, size, Download.
- When steps 1–3 are done, Home switches to the normal view (the optional step stays as a dismissable card until done or dismissed).
- A dictation without a model shows a pill notice ("No speech model yet — open RudariFlow to download one") instead of nothing.

### Settings

Tabs along the top; the last open tab is remembered. Every tab: common rows first, then **Advanced** (a fold that remembers per tab whether it is open). Hints are one line; a hint that needs more ends in **More**, which expands the long text in place.

| Tab | Main | Advanced |
|---|---|---|
| Dictation | Dictate key + hold/toggle; Paste last; Rewrite last; microphone; start/stop sounds | Free GPU hotkey; Meeting hotkey; Mute other apps while recording; "Send it" voice command |
| AI cleanup | on/off + status; style; Write in; Edit mode; rules per app | AI model (E4B / E2B) with download state; "Try it" box |
| Dictionary | words (search, add one or paste a list); replacements (search, add); suggestions learned from corrections; Swiss spelling | import / export |
| Models & GPU | speech model (downloaded ✓ / Download n %); language | engine (local / cloud + key); GPU backend + detected GPUs; PC check; Free GPU for games; Unload when idle; Unused models |
| General | display language; start with Windows; history: keep text / text + audio / off | — |

Where a setting is also reachable from Home (hotkeys, AI cleanup on/off, language, Write in), both places show the same value and change it at once.

### Tool pages

- **Files:** title "Files"; the drop zone shrinks once a file is loaded so the transcript starts within the first screen; otherwise as today in the new look.
- **Meetings:** unchanged structure (already the house standard); its hotkey row lives in Settings › Dictation › Advanced.
- **Soundboard:** sounds first. A compact bar on top: Virtual microphone switch + status, Stop all, Pop out, and a **Soundboard settings** button opening a panel (Others hear, You hear, Play over each other, Sound hotkeys switch + toggle key, Stop all key, Devices, the Discord hint). On wide windows the panel is the left column as today (two columns stay); below ~1,120 px and in the pop-out the panel is closed by default and the sound library leads. The Virtual microphone switch is always visible.

## Shared design standard (look B)

- **Tokens** (CSS variables, one source): surfaces (`--bg`, `--surface`, `--surface-2`), text (`--text`, `--text-2` at ≥ 4.5:1 on every surface), accent, success/warn/danger, radius 14 px cards / 8 px controls, spacing scale 4-8-12-16-24, type scale 12/14/16/22 px with 14 px body. Font shipped with the app (no request to Google Fonts).
- **Components, one each:** setting row (label, one-line hint + More, control), card, tab bar, fold (Advanced), list row (primary text, secondary line, trailing actions), buttons (primary, secondary, text), switch, select, key box (hotkey), status pill, progress (always percent + size), empty state, inline notice.
- **Delete:** one pattern — the first click arms ("Delete?"), the second deletes; Esc or clicking elsewhere disarms; wording "Delete" everywhere; nothing deletes on a single click.
- **Accessibility:** every control has an accessible name; Tab order follows the page; visible focus on every control including switches and nav; targets ≥ 24 px; live regions for status and notices (as Meetings does).
- **Motion:** 120–180 ms ease-out for page changes and folds only; none with `prefers-reduced-motion`.
- **Languages:** EN + DE for every string; the pill and the tray menu follow the Display Language setting; the known German overflows (Soundboard toggle-hotkey hint, History meta line, rule-language selects) are fixed.

## Out of scope

Light theme; new features; changes to config keys, commands or the backend beyond what the status and first run need (a "speech model available / loaded" state and the no-model notice).

## Build order (one branch, each step reviewed)

1. **Shell and standard:** tokens, components, sidebar with five items, the status model, the bundled font, tray/pill language. Old pages keep working inside the new shell (moved, not yet restyled in depth).
2. **Home, first run, Settings:** the Home page, the setup steps, the five Settings tabs with Advanced folds and one-line hints.
3. **Tool pages and polish:** Files, Meetings, Soundboard (panel), lists and delete pattern everywhere, German fixes, motion.

## Testing

- **Automatic, per step:** the audit's harness (headless render with a mocked backend): screenshots of every page at 2560×1392, 1600×900 and 900×600 in EN and DE, first-run and populated; checks for horizontal overflow, clipped text, contrast of text tokens, every control named and reachable by Tab, the sidebar fully visible at 900×600.
- **Unit tests** for the status priority and the first-run conditions (pure functions), and for any backend addition.
- **Against the real app** on the isolated test instance (it must not take focus; the user is told first): settings round-trip (every moved setting still saves and loads), hotkey capture from Home and Settings, downloads with percent, the pop-out.
- **The user's try-out** on the installed build before release.
