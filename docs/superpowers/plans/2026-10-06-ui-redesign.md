# UI Redesign Implementation Plan (0.17.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **One deliberate deviation from the house format:** the house plans inline every line of code. This plan does not re-type code that already exists in the prototype (branch `wip/ui-redesign-prototype`, commit `a076a16`, folder `wip-prototype/`). Where a step's code exists there, the step names the exact source, says what to take and lists every correction the implementer must make. Code is inline only where the prototype lacks it or gets it wrong, or where it is short. The spec is binding, the prototype is not.

**Goal:** RudariFlow's window becomes easy and übersichtlich for a newcomer and a power user: five sidebar items (Home, Files, Meetings, Soundboard, Settings), Home as the dictation page with a first-run setup, Settings in five tabs with Advanced folds and one-line hints, one shared look ("B", calm and airy dark), one status that never says "Ready" when it is not. Interface only: no feature and no `config.json` key changes.
**Architecture:** The frontend stays vanilla TypeScript on one `index.html`. New: design tokens and shared components in `src/styles/`, a shell (`shell.ts`, pure `route.ts`, `prefs.ts`) that owns sections, Settings tabs and folds, a status model (pure `status.ts`, `status-view.ts`, `activity.ts`), Home (`home.ts`, `history.ts`, `mirror.ts`, pure `setup.ts` and `search.ts`), setting-row helpers (`rows.ts`, pure `models.ts`), one delete pattern (pure `arm.ts`, `confirm-delete.ts`), `replacements.ts`. Every old control keeps its id and its handler, so a setting that moves still saves. The backend gains only what the status and the first run need: the speech model's state (`speech_status`, `speech-status`), a pill notice for a dictation without a model (`speech-notice`), the Display Language for the tray and the pill (`ui-language`), and a microphone level for the setup (`mic_meter_start`, `mic_meter_stop`, `mic-level`). A headless check, `tools/ui-check/`, renders every page with a mocked backend and gates each task.
**Tech Stack:** TypeScript (vanilla, Vite 6), CSS custom properties, `@fontsource/ibm-plex-sans` (bundled font), Rust (Tauri 2, cpal, whisper-rs) for the small backend additions, Node's built-in test runner for the pure modules, Playwright 1.63 (Chromium) for `ui-check`.
**Spec:** `docs/superpowers/specs/2026-10-06-ui-redesign-design.md` (binding). Basis: `docs/superpowers/specs/2026-10-06-ui-audit.md`. Mockups: `docs/superpowers/specs/2026-10-06-ui-redesign-mockups/` (navigation C, home 2, settings 1, look B).

## Global Constraints

- **Build environment note.** Every Rust command in this plan is written with the placeholder `<RUST-ENV>`. On this PC (checked 2026-10-07: `cargo check` for `--lib` and `--bins` and three filtered tests pass) it stands for, in Git Bash, run from `src-tauri` (its `.cargo/config.toml` supplies `GGML_NATIVE=OFF` and `SHERPA_LIB_PATH`):

```bash
export CARGO_TARGET_DIR='C:\t\rf-cpu' LIBCLANG_PATH='C:\Program Files\LLVM\bin'
```

  No vcvars64, Ninja, `VULKAN_SDK` or `CUDAARCHS` is needed for `--no-default-features`. A warm test run takes about 10 s. `src-tauri/binaries/gpu-runtime` already holds the CUDA 13 DLLs that the crate's build script asks for. With a new target folder the first build fails with `os error 32`: copy `sherpa-onnx-c-api.dll`, `onnxruntime.dll` and `onnxruntime_providers_shared.dll` from `src-tauri/binaries/sherpa-onnx/lib` into `<target>\debug\` first. **The GPU release build (Final checks 5) cannot be made on this PC as it is:** CUDA Toolkit 12.8 is installed, 0.16.0 needs 13.4, and `binaries/llama` lacks `ggml-cuda.dll`; the controller settles that with the user before the try-out. The house plans' `source /e/claude/RudariFlow/.superpowers/tools/env13.sh` and every `E:\…` path belong to another PC and do not exist here. Tasks 1, 2 and 4 to 9 need only Node.
- **Paths on this PC (Git Bash):**

```bash
R=/c/claudino/RudariFlow          # the repo, branch feature/ui-redesign
W=/c/t/rf-proto                   # a worktree of commit a076a16; its src/, index.html and src-tauri/ are 0.16.0 ("stage 0")
P=$W/wip-prototype                # the prototype
# If the worktree is missing: git -C $R worktree add --detach /c/t/rf-proto a076a16
```

- **Interface only.** No feature changes. No `config.json` key is lost or renamed. Every control of 0.16.0 keeps its id and its handler wherever it moves; the tool's `roundtrip` check (`tools/ui-check/roundtrip.mjs`: 32 shown values, 39 changes against the mocked backend, and every save still carries every settings key) and its `contract` check (`contract.json`: 76 commands still called, 177 ids still there, except `removedIds`) must stay green in every task.
- **Strings:** every UI string in English and German in `src/i18n.ts`; the pill's texts in `NOTICE_TEXT` in `src/overlay.html`; the tray's in `main.rs`. **No em dash and no en dash between words in a new or changed string** (rebuild the sentence); the tool's `dash` check enforces it. The spec quotes two texts with a dash; they are rewritten (Tasks 3 and 5).
- **Rust tests only filtered.** From `src-tauri`: `<RUST-ENV> cargo test --no-default-features --lib <filter>` (tests in the library) or `--bins <filter>` (tests in `main.rs`). NEVER the unfiltered suite: the `paste.rs` tests overwrite the system clipboard.
- **Commits:** `feat:`, `fix:`, `docs:`, `test:` or `build:` plus a subject, then an EMPTY line, then exactly `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Use `git commit -F -` with a heredoc. No version bump in any task; the release is a separate step after the user's try-out.
- **Never start the app.** No test instance, no `tauri dev`, nothing that touches the installed app or `%LOCALAPPDATA%\RudariFlow` / `%APPDATA%\com.rudariflow.app`. A test instance takes the keyboard focus and writes into the installed app's `startup.log`. Real-app checks happen once, at the end ("Final checks"), by the controller, with the user told first.
- **Pure modules and unit tests:** `status.ts`, `route.ts`, `prefs.ts`, `setup.ts`, `search.ts`, `models.ts`, `arm.ts` have no DOM and no Tauri import. Their tests are `tests/unit/<name>.test.ts`, run by Node itself: `npm run test:unit` = `node --test "tests/unit/*.test.ts"` (Node 22.18 or newer strips the types; this PC has 24.15). Therefore these seven files use erasable TypeScript only (no `enum`, no parameter properties, no `namespace`) and import each other with the `.ts` extension. `tsc` checks `src/` only; the tests are type-stripped, not type-checked.
- **Per-task verification** (from `$R`, all four must pass before the commit):

```bash
npx tsc --noEmit                         # no output
npx vite build                           # "built in …", no warning about an unresolved import
npm run test:unit                        # "fail 0"; the task says how many tests
node tools/ui-check/run.mjs --no-shots --task <N>   # N = the task's number; exit 0; the task says how many findings are known
```

  A full `--no-shots` run takes 2 to 7 minutes. For the reviewer add screenshots of the task's pages: `node tools/ui-check/run.mjs --no-build --pages <ids> --size 1600x900` and `--size 900x600` (files in `tools/ui-check/shots/`, not committed). A filtered run does not report stale `allow.json` entries; only the full run is the gate. `--task <N>` makes the run ignore every `allow.json` entry with `until` <= N: what such an entry covered counts as new, and the run says how many entries it ignored instead of listing them as stale. So where a task below says "exit 1 only because … entries match nothing any more", the run with `--task <N>` exits 0 and names them as past their task; delete them as the task says.
- **`allow.json` only shrinks.** Task 1 records the known findings of 0.16.0 as 25 entries, each with `until: <task>`. A task removes exactly the entries whose `until` is its number (its run with `--task <N>` ignores them, so what they covered must be gone; a run without `--task` lists them as "match nothing any more") and adds none. Task 8 leaves `[]`.
- **How a task takes its code from the prototype.** The prototype holds whole-file snapshots ("stages"): `$W/src` (0.16.0), `$P/app_src_task3`, `$P/app_src_task5`, `$P/app_src_task6`, `$P/app_src_task7`, `$P/app/src` (final); `index.html` as `$W/index.html`, `$P/app_index_task3.html`, `…task5.html`, `…task6.html`, `…task7.html`, `$P/app/index.html`; the tool as `$P/tool`, `tool3`, `tool5`, `tool6`, `tool7`, `tool8`. The change of a task is the difference between two stages. Merge that difference into the repo's files; never copy a stage's file over a repo file an earlier task touched, or its corrections and review fixes are lost. Paste this helper into the shell (not committed):

```bash
# apply_stage <from> <to> <dest>: new files are copied, changed files get a three-way merge.
apply_stage() {
  local from="$1" to="$2" dest="$3"
  (cd "$to" && find . -type f | sed 's#^\./##') | while read -r f; do
    if [ ! -e "$from/$f" ]; then
      mkdir -p "$dest/$(dirname "$f")" && cp "$to/$f" "$dest/$f" && echo "new       $f"
    elif ! cmp -s "$from/$f" "$to/$f"; then
      if git merge-file "$dest/$f" "$from/$f" "$to/$f"; then echo "merged    $f"; else echo "CONFLICT  $f"; fi
    fi
  done
  (cd "$from" && find . -type f | sed 's#^\./##') | while read -r f; do [ -e "$to/$f" ] || echo "gone in the stage: $f"; done
}
# One file: git merge-file <repo file> <from-stage file> <to-stage file>
```

  A `CONFLICT` is resolved by hand (the markers are in the file); the task names the conflicts to expect. "gone in the stage: sidebar-logo.png" is to be ignored everywhere: the prototype was saved without the PNG, the repo's `src/sidebar-logo.png` stays. To read one prototype file without the worktree: `git show a076a16:wip-prototype/<path>`.
- **After a task, compare with its stage:** `diff -ru --strip-trailing-cr $P/<stage> $R/src` must show only the corrections this plan lists for the tasks so far, and review fixes.

## The prototype's measured state (2026-10-07, this PC)

| What | Result |
|---|---|
| `$P/app` (final stage): `npx tsc --noEmit`, `npx vite build` | both clean |
| `$P/app/tests/unit`, `node --test "tests/unit/*.test.ts"` | 32 tests, 32 pass |
| `$P/tool8` on `$P/app`, full run (2 data sets, 2 languages, 3 sizes, pop-out, pill; 456 screenshots) | exit 1, 6 findings: transcript below the first screen at 900×600 with a summary open; suggestion buttons English in a German window; `select[device-cable]` cut by 1 px; a Soundboard hint on two lines |
| `$P/tool` on 0.16.0 | runs clean; 309 findings (focus 103, target 81, contrast 42, name 32, hint-lines 17, tab 10, contrast-token 10, clipped 7, sidebar 3, overlap 2, external 2) |
| Stages rebuilt and checked with their tool | stage 3: 50 findings, stage 5: 49, stage 6: 19 (2 of them i18n keys used by a file nothing imports yet, see Task 6), stage 7: 7; all four type-check and build |
| Scratch builds of what has no stage | Task 1's tool before the hardening of its review on 0.16.0: 309 known, 0 new (hardened: 312, see below the table). Task 2 (recipe below): 72 findings, 0 new. Task 4 (the cut below): 49, 0 new. The final stage with every correction of this plan: 0 findings, 33 unit tests pass |
| The merges, rehearsed in order on a scratch copy (Tasks 2 to 8 with their corrections) | the conflicts each task names and no other; the result type-checks, passes the 33 unit tests and equals the corrected final stage |
| Rust (`$P/rs`) | NOT compiled or run while this plan was written (no cargo allowed). The diff against 0.16.0 is `audio.rs`, `whisper_engine.rs`, `main.rs` (476 insertions, 25 deletions); the correction in Task 3 Step 2 is new, uncompiled code |

**After the review of Task 1 (the hardening of `ui-check`).** The counts in this table and in Tasks 2 to 8 were measured before the tool was hardened (text cut by a box around it, 24 px for every control that is not `display: inline`, a colour the tool cannot read, a file of the page's own that does not load, a settings key lost in a save), so the `clipped`, `target` and `contrast` counts there can be higher now, and every such finding on a page the task builds has to be fixed, not allowed. Measured with the hardened tool on 2026-10-07: 0.16.0 has 312 findings (3 more `clipped`: the sidebar's last three texts, cut by the window at 900×600, allowed until Task 3), so Task 2 should end with 75 known findings (clipped 9) and 18 entries, and Task 3 removes seven entries, not four. The final stage (`$P/tool8`'s pages on `$P/app`) has 21 findings more than before: `target` for `button.hint-more` (32×17 px, 20 findings: every page that shows a "More"), and one `page-error` for `/src/sidebar-logo.png`, the file only the prototype lacks. The remedy for "More", tried on a scratch copy: in `components.css` (Task 2) `.hint-more` gets `padding: 4px 2px; margin: -4px 0;` instead of `padding: 0 2px;`, which makes it 32×25 px and leaves the hint one line high; `display: inline` does not help, a `<button>` computes to `inline-block`.

**After the review of Task 2 (the components).** Task 2's review changed `components.css`, `tokens.css` and `style.css`: one progress bar (the leftover 3 px track is gone), disabled states for fields and every button kind, list rows and setting controls that wrap, a key box that breaks instead of running over its label, armed and pressed states (`--accent-active`), round focus rings on tabs, sliders and links, `--line-strong` at `#727284`, and cards with 8 px of vertical padding instead of 4. So pixel positions in later tasks' probes can differ slightly from the ones measured here; a "first screen" probe that fails by a few pixels is fixed in that page's layout, not by reverting the component. The merges were rehearsed again with these fixes in place (stages 3, 5, 6, 7, final for `style.css`; 5 to 6 for `components.css`): Task 3 needs the three-way merge of its Step 6, Task 7 gets one more conflict in `style.css`, Task 8 keeps its one; each task names them. Resolve a conflict in an editor: Git Bash's `sed -i` writes LF line ends, and the next merge against the stages (CRLF) then conflicts on every line.

**After the review of Task 3 (the shell).** What later tasks build on changed in five places. (1) The status: the missing speech model's own download is the status `downloading` with its percent (before "Setup needed"), `StatusInput` has `speechDownload`, `activity()` also says which download runs and the speech model's percent, a download no longer makes Home's heading "Getting ready…", and what is read out is `#status-live` (`statusSaid`, no percent) while `#status-text` is `aria-hidden`. `ui-check` does not measure the contrast of `aria-hidden` text; the pill's five tones were measured by hand: 6.5:1 to 9.0:1. (2) `announceRoute()` tells every `onRoute` listener the place the window starts on, once, at the end of `main.ts`'s start; a listener a later task adds (Home's `renderHome`) hears of it too. (3) The sidebar has one left edge at x 20 (logo mark, pill, icons, version; 12 px inside the items) and the pages' padding is 24 px (`--s5`) instead of 32 and 40: every page starts at x 224 and is 16 px wider, so a pixel position measured before can differ by that much. (4) `resolve("settings/<no tab>")` keeps the tab; `sizeText` never says "1000 MB". (5) Unit tests: 31 after Task 3 instead of 23, so every later count is 8 higher (the tasks below carry the new numbers). The merges of the next stage were rehearsed again with these fixes in place (`main.ts`, `ai-settings.ts`, `i18n.ts`, `style.css`, `index.html`, `pages.mjs`, `mock.js` from stage 3 to 5; `components.css` from 5 to 6): no conflict.

## File map

| File | Change | Task |
|---|---|---|
| `tools/ui-check/*` (`run.mjs`, `inpage.js`, `mock.js`, `pages.mjs`, `static.mjs`, `roundtrip.mjs`, `gen-contract.mjs`, `contract.json`, `allow.json`, `package.json`, `package-lock.json`) | the headless check | 1, then `pages.mjs`, `mock.js`, `contract.json`, `allow.json` in 2 to 8 |
| `package.json`, `.gitignore` | scripts `ui-check`, `test:unit`; ignore the tool's output | 1 |
| `src/styles/tokens.css`, `src/styles/components.css` | tokens, components, bundled font | 2 |
| `package.json`, `package-lock.json` | `@fontsource/ibm-plex-sans` | 2 |
| `index.html`, `soundboard.html` | no Google Fonts; then the new shell, Home, Settings | 2, 3, 4, 5, 6, 7, 8 |
| `src/style.css` | shrinks to the page rules | 2 to 8 |
| `src-tauri/src/audio.rs`, `whisper_engine.rs`, `main.rs` | `MicMeter`, `LoadState`, `SpeechStatus`, commands, events, tray language | 3 |
| `src/overlay.html` | Display Language, `speech-notice` | 3 |
| `src/shell.ts`, `route.ts`, `prefs.ts`, `status.ts`, `status-view.ts`, `activity.ts`, `setup.ts`, `styles/shell.css` | shell and status | 3 |
| `src/home.ts`, `history.ts`, `mirror.ts`, `search.ts`, `styles/home.css` | Home | 4, first run in 5 |
| `src/rows.ts`, `models.ts`, `styles/settings.css` | Settings | 6 |
| `src/arm.ts`, `confirm-delete.ts`, `replacements.ts` | the one way to delete, the replacements list | 7 |
| `src/main.ts`, `ai-settings.ts`, `dictionary.ts`, `files.ts`, `meetings.ts`, `soundboard/board.ts`, `i18n.ts` | wiring, strings | 3 to 8 |
| `tests/unit/*.test.ts` | status, route, prefs, setup (3), search (4), models (6), arm (7) | 3, 4, 6, 7 |
| `README.md`, `README.de.md`, `CHANGELOG.md`, `HANDOFF.md` (deleted) | docs | 9 |

---

### Task 1: The `ui-check` tool in the repo

**Files:**
- Create: `tools/ui-check/run.mjs`, `inpage.js`, `mock.js`, `pages.mjs`, `static.mjs`, `roundtrip.mjs`, `gen-contract.mjs`, `contract.json`, `allow.json`, `package.json`, `package-lock.json`
- Modify: `package.json`, `.gitignore`
- Test: the tool against the untouched 0.16.0 frontend

**Interfaces:**
- Consumes: the frontend as `vite build` makes it (built by the tool into `tools/ui-check/.build`); `window.__TAURI_INTERNALS__`, replaced by `mock.js`.
- Produces:
  - CLI `node tools/ui-check/run.mjs [--pages a,b*] [--scenario populated|firstrun] [--lang en|de] [--size WxH] [--no-build] [--no-shots] [--root <dir>] [--task N]`. Exit 0: no new finding, and on a full run no stale `allow.json` entry. Exit 2: the run could not start (no build, a `--pages` filter that names no page, a `--task` that is no number). `--task N`: entries of `allow.json` with `until` <= N are ignored. Writes `report.json` (`{ new, known }`), `shots/<page>-<scenario>-<lang>-<size>[-fold].png`.
  - Check ids: `overflow`, `clipped` (by its own box or by a box around it with `overflow: hidden` or `clip`), `overlap`, `contrast` (4.5:1, 3:1 large; a colour the tool cannot read is a finding), `contrast-token` (also: no token found), `name`, `tab`, `focus`, `target` (24 px; only a control with `display: inline` inside a sentence is exempt), `hint-lines`, `sidebar` (fits 900×600; also: no sidebar found), `contract`, `i18n`, `dash`, `roundtrip` (also: a settings key lost in a save), `behaviour` (a probe's expectation), `external` (a request to another origin), `page-error` (also: a file of the page's own that does not load, reported for the page `window`), `mock`.
  - `pages.mjs`: `PAGES` (`{ id, url, scope, scenarios, sizes, fresh, open, checks, skip, probe }`), `USER_TEXT`. `mock.js`: `window.__MOCK_CFG__ = { lang, scenario }`, `window.__MOCK__ = { calls, unknown, settings(), emit(event, payload), meetingRecording() }`. `static.mjs`: `staticChecks(root, contract)`, `commandsCalled(root)`, `literal(source, marker)`, `DASH`.
  - `allow.json`: `[{ check, page, what, until }]`, `*` globs. `contract.json`: `{ commands[76], ids[177], removedIds{}, dashKeys[11] }`.
  - npm scripts `ui-check`, `test:unit`.

- [ ] **Step 1: Bring the files in**

```bash
cd $R && mkdir -p tools/ui-check
cp $P/tool/{run.mjs,inpage.js,mock.js,pages.mjs,static.mjs,roundtrip.mjs,contract.json,package.json} tools/ui-check/
```

Take these eight files as they are (`$P/tool` is the stage that knows the ten old pages). Do not take `$P/tool/report.json`, `allow.json` or `gen-contract.mjs` (it has another PC's path).

- [ ] **Step 2: The `dash` check (the prototype has none)**

In `tools/ui-check/static.mjs`:

Replace the line `function literal(source, marker) {` and its comment with:

```js
/** An em dash, or an en dash between words (a range like 5–10 is none). */
export const DASH = /—|\s–\s/;

/** The object literal that starts at `marker` (up to the first line that is just "};"). */
export function literal(source, marker) {
```

After the line that reports `"an empty text"`, add:

```js

  // No dash in a text the redesign wrote; contract.dashKeys are the texts of 0.16.0 that have one.
  const oldDash = new Set(contract.dashKeys ?? []);
  for (const key of Object.keys(en)) {
    if (!oldDash.has(key) && (DASH.test(en[key]) || DASH.test(de[key] ?? ""))) add("dash", key, "write the sentence without the dash");
  }
```

In the pill's `else { … }` block, after the two `for` loops, add:

```js
    for (const key of Object.keys(pill.en)) {
      if (DASH.test(pill.en[key]) || DASH.test(pill.de[key] ?? "")) add("dash", `pill: ${key}`, "write the sentence without the dash");
    }
```

- [ ] **Step 3: `gen-contract.mjs` and the contract**

Create `tools/ui-check/gen-contract.mjs`:

```js
// Writes contract.json from the frontend as it is NOW: the backend commands
// it calls, the ids of index.html and the texts that carry a dash. Run once,
// on the untouched 0.16.0 frontend (Task 1 of the UI redesign); never
// again: the file is the record of what the redesign has to keep. So it
// refuses when contract.json exists: a second run would record the changed
// frontend as the thing to keep and empty removedIds. `--force` overwrites.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DASH, commandsCalled, literal } from "./static.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "contract.json");
if (fs.existsSync(target) && !process.argv.includes("--force")) {
  console.error(`gen-contract: ${target} exists and is the record of 0.16.0; not overwritten.`);
  console.error("Writing it again from a changed frontend would lose that record (commands, ids, removedIds, dashKeys). Only with --force.");
  process.exit(2);
}
const root = path.resolve(here, "../..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const i18n = fs.readFileSync(path.join(root, "src/i18n.ts"), "utf8");
const en = literal(i18n, "const en: Translations = {");
const de = literal(i18n, "const de: Translations = {");
const dashKeys = Object.keys(en).filter((key) => DASH.test(en[key]) || DASH.test(de[key] ?? ""));
const commands = commandsCalled(root);
fs.writeFileSync(target, JSON.stringify({ commands, ids, removedIds: {}, dashKeys }, null, 1) + "\n");
console.log(`${commands.length} commands, ${ids.length} ids, ${dashKeys.length} texts with a dash`);
```

Run `node tools/ui-check/gen-contract.mjs --force` (`--force` because Step 1 copied the prototype's `contract.json`; in every later task the script must refuse, which is what it does without the option). Expected: `76 commands, 177 ids, 11 texts with a dash`, and `git diff --no-index $P/tool/contract.json tools/ui-check/contract.json` shows one change only, the added `dashKeys` (`unused_model_links`, six `model_*` labels, four `mt_warn_*`).

- [ ] **Step 4: The hint rule knows the Soundboard's narrow panel**

In `tools/ui-check/inpage.js`, check 9, replace

```js
    // 9. Hints: one line (two in a window under 1600 px).
    const allowed = window.innerWidth >= 1600 ? 1 : 2;
    for (const el of all) {
      if (!el.matches(".setting-label .label-hint") || el.matches(NOT_A_HINT) || !(el.innerText || "").trim()) continue;
```

with

```js
    // 9. Hints: one line; two in a window under 1600 px and in the Soundboard's
    // settings panel, a column of at most 420 px in any window.
    for (const el of all) {
      if (!el.matches(".setting-label .label-hint") || el.matches(NOT_A_HINT) || !(el.innerText || "").trim()) continue;
      const allowed = window.innerWidth >= 1600 && !el.closest(".sb-col-settings") ? 1 : 2;
```

- [ ] **Step 4b: The hardening from the review (the prototype's tool has none of it)**

These changes are not in `$P/tool` or in any later stage of the tool; they are in the repo since the commit "fix: ui-check review fixes: …". The later tasks take only `pages.mjs`, `mock.js` and `contract.json` from a stage, never the files below.

- `static.mjs`: the `contract` check asks `commandsCalled(root)`, so only a real `invoke("name", …)` counts as a call, not the quoted word (a text key such as `history_delete` has a command's name).
- `inpage.js`: `clipped` also reports a text cut by a box around it, an ancestor whose `overflow-x` or `overflow-y` is `hidden` or `clip` (helpers `textRects`, `inkInset`, `cutByBoxAround`; a box that scrolls cuts nothing; the window counts when it does not scroll; an element is reported once). `target` exempts only a control with `display: inline` inside a sentence (a link; never a `<button>`, which computes to `inline-block`). A colour `parseColor` cannot read is a `contrast` finding "colour not understood: …" (for a token a `contrast-token` finding). `contrast-token` reports when `:root` has no `--text*` or no `--bg`, `--surface*`, `--sidebar*` token. `sidebar` reports when it finds no `#sidebar .nav-item`.
- `run.mjs`: `--task N`; exit 2 for a `--pages` pattern that matches no page and for a run that opened nothing; a response of 400 or more, or a failed request, for a file of the page's own origin is a `page-error` on the page `window`; the round trip's window reports its `page-error`, `external` and `mock` findings like every page; `window.__MOCK_KEYS__` holds the settings keys before the page ran.
- `roundtrip.mjs`: `roundtrip(page)` (the caller opens and closes the window); every `save_settings` the page sends must carry every key of `__MOCK_KEYS__`, otherwise `roundtrip`, "settings key <name>".
- `gen-contract.mjs`: refuses with exit 2 when `contract.json` exists, unless `--force` (Step 3 shows the file).

- [ ] **Step 5: Scripts and ignores**

Root `package.json`, in `"scripts"`, add `"ui-check": "node tools/ui-check/run.mjs"` and `"test:unit": "node --test \"tests/unit/*.test.ts\""`. Append to `.gitignore`:

```
# tools/ui-check: its build, screenshots and last report
tools/ui-check/.build/
tools/ui-check/shots/
tools/ui-check/report.json
```

- [ ] **Step 6: Install and run against the untouched UI**

```bash
cd $R/tools/ui-check && npm install && npx playwright install chromium
cd $R && echo "[]" > tools/ui-check/allow.json && node tools/ui-check/run.mjs --no-shots
```

Expected: exit 1, `ui-check: 312 findings, 0 known (allow.json), 312 new`, no `roundtrip`, `contract`, `i18n`, `dash`, `page-error` or `mock` line (the tool itself works on 0.16.0). By check: focus 103, target 81, contrast 42, name 32, hint-lines 17, clipped 10, tab 10, contrast-token 10, sidebar 3, overlap 2, external 2. That is the prototype's 309 plus three `clipped` on `shell` that only the hardened check sees: at 900×600 the sidebar's "Soundboard", version and credit are cut by the window, which does not scroll.

- [ ] **Step 7: Record the known findings**

Write `tools/ui-check/allow.json` (order matters: the first matching entry takes a finding):

```json
[
 { "check": "external", "page": "window", "what": "*", "until": 2 },
 { "check": "contrast-token", "page": "shell", "what": "*", "until": 2 },
 { "check": "focus", "page": "*", "what": "*", "until": 2 },
 { "check": "overlap", "page": "soundboard*", "what": "*", "until": 2 },
 { "check": "contrast", "page": "shell", "what": "*", "until": 3 },
 { "check": "contrast", "page": "*", "what": "*", "until": 2 },
 { "check": "target", "page": "shell", "what": "*", "until": 3 },
 { "check": "target", "page": "*", "what": "*", "until": 2 },
 { "check": "sidebar", "page": "shell", "what": "*", "until": 3 },
 { "check": "tab", "page": "shell", "what": "*", "until": 3 },
 { "check": "name", "page": "files*", "what": "*", "until": 8 },
 { "check": "name", "page": "*", "what": "*.rule-*", "until": 7 },
 { "check": "name", "page": "*", "what": "*.replacement-*", "until": 7 },
 { "check": "name", "page": "*", "what": "*", "until": 6 },
 { "check": "hint-lines", "page": "soundboard*", "what": "*", "until": 8 },
 { "check": "hint-lines", "page": "popout*", "what": "*", "until": 8 },
 { "check": "hint-lines", "page": "*", "what": "*", "until": 6 },
 { "check": "clipped", "page": "shell", "what": "span[nav_soundboard]", "until": 3 },
 { "check": "clipped", "page": "shell", "what": "span#version-text", "until": 3 },
 { "check": "clipped", "page": "shell", "what": "a#credit-link", "until": 3 },
 { "check": "clipped", "page": "soundboard*", "what": "*", "until": 8 },
 { "check": "clipped", "page": "*", "what": "select.rule-language", "until": 7 },
 { "check": "clipped", "page": "*", "what": "span.history-meta", "until": 4 },
 { "check": "clipped", "page": "*", "what": "select#mic-select", "until": 2 },
 { "check": "clipped", "page": "*", "what": "select#*model-select", "until": 6 }
]
```

Run `node tools/ui-check/run.mjs --no-shots --no-build --task 1`. Expected: exit 0, `312 findings, 312 known (allow.json), 0 new`, no "match nothing any more" list (no entry has `"until": 1`, so `--task 1` ignores none). Keep this rule of the order: no entry stands before a wider one of the same check with a higher `until`, or `--task` would hand its findings on to that one. Then prove the gate: delete the `sidebar` line, run `node tools/ui-check/run.mjs --no-shots --no-build --pages shell`, expected exit 1 with three NEW `sidebar` lines (Soundboard, version and credit below 600 px); put the line back.

- [ ] **Step 8: The rest still works**

`npx tsc --noEmit` clean; `npx vite build` clean; `npm run test:unit` prints `tests 0` and exits 0 (the first tests come with Task 3). `git status --short` shows `tools/ui-check/` (11 files), `package.json`, `.gitignore`.

- [ ] **Step 9: Commit**

```bash
cd $R && git add tools/ui-check package.json .gitignore
git commit -F - <<'EOF'
test: ui-check, a headless check of every page with a mocked backend, and the known findings of 0.16.0

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Design tokens, shared components, the bundled font

**Files:**
- Create: `src/styles/tokens.css`, `src/styles/components.css`
- Modify: `src/style.css`, `index.html`, `soundboard.html`, `package.json`, `package-lock.json`, `tools/ui-check/allow.json`

**Interfaces:**
- Produces (CSS custom properties on `:root`, the one source): surfaces `--bg`, `--surface`, `--surface-2`, `--surface-3`; text `--text`, `--text-2`, `--text-accent`, `--text-ok`, `--text-warn`, `--text-danger` (each at least 4.5:1 on every surface); `--accent`, `--accent-hover`, `--accent-active` (a pressed button; the review's addition), `--on-accent`, `--accent-bg`, `--ok-bg`, `--warn-bg`, `--danger-bg`; `--line`, `--line-strong`, `--focus`; `--radius-card` 14 px, `--radius` 8 px, `--radius-s`; `--s1` to `--s5` (4, 8, 12, 16, 24 px); `--fs-s`, `--fs`, `--fs-l`, `--fs-xl` (12, 14, 16, 22 px); `--font`, `--mono`; `--ease` (150 ms ease-out). The names of 0.16.0 (`--sidebar-bg`, `--text-secondary`, `--border`, `--radius-lg`, `--transition`, …) stay as aliases so the old page rules get the new look.
- Produces (component classes, one each): `.card`, `.card-title`; `.settings-list`, `.setting-row` (`.stack`), `.setting-label`, `.label-text`, `.label-hint`, `.hint-more`, `.hint-long`, `.setting-control`; fields (`select`, `input`, `textarea`, `.field-textarea`); `.switch`, `.switch-slider`; `.btn-primary`, `.btn-secondary`, `.btn-text` (`.btn-ghost` is its older name), `.armed`, `.icon-btn`, `.link-btn`; `.toggle-group`, `.toggle-btn`; `.hotkey-btn`, `.hotkey-control`, `kbd`; `.tabs`, `.tab`; `details.fold`; `.list`, `.list-row`, `.list-main`, `.list-primary`, `.list-secondary`, `.list-actions`, `.list-head`, `.list-title`; `.status-pill[data-tone]`, `.status-dot`, `.status-marker`; `.progress`, `.progress-track`, `.progress-fill`, `.progress-text`; `.empty-state`; `.notice[data-tone]`; `.section-header`, `.section-title`, `.section-desc`; `.sr-only`, `.hidden`; one focus ring (`:focus-visible`, `--focus`).
- Produces: dependency `@fontsource/ibm-plex-sans` (weights 400, 500, 600 imported by `tokens.css`); no request leaves the PC.

- [ ] **Step 1: The font package**

`cd $R && npm install @fontsource/ibm-plex-sans@^5.3.0`

- [ ] **Step 2: Tokens and components**

```bash
mkdir -p src/styles && cp $P/app_src_task3/styles/{tokens.css,components.css} src/styles/
```

Take both whole. (The final stage differs by one line in `components.css`, which comes with Task 6.)

- [ ] **Step 3: `src/style.css` keeps the window and the pages**

The old file's tokens and component rules go; its shell rules stay until Task 3. Build it from the 0.16.0 file and stage 3 (line numbers are those of `src/style.css` at 84447e5, 2376 lines):

```bash
cd $R && {
  printf '%s\n' "/* RudariFlow's styles: tokens, the shared components, then the window and the pages. */" '@import "./styles/tokens.css";' '@import "./styles/components.css";' ''
  sed -n '43,232p;276,295p;334,337p' "$W/src/style.css"
  sed -n '/^\/\* The Files tab uses the whole window/,$p' "$P/app_src_task3/style.css"
} | sed 's/\r$//' > src/style.css
```

That is: lines 43 to 232 (App Shell, Sidebar, Navigation, Sidebar Footer up to `.credit-text:hover`), 276 to 295 (Content Area), 334 to 337 (`@keyframes fadeIn`), then stage 3's page rules. Left out on purpose: lines 1 to 42 (`:root`, reset, `body`), 234 to 274 (`input[type="range"]`, `.switch…`; had they stayed, they would override the 44×24 px switch of `components.css`), 339 to 515 and 530 to 706 (rows, fields, buttons, progress, `kbd`, small buttons, `.empty-state`). Expected: 1939 lines.

- [ ] **Step 4: No Google Fonts**

In `index.html` and in `soundboard.html` delete the three `<link>` lines that name `fonts.googleapis.com` / `fonts.gstatic.com`.

- [ ] **Step 5: Verify**

`npx tsc --noEmit` clean. `npx vite build` clean, and `grep -rl "fonts.g" dist index.html soundboard.html src` prints nothing, `ls dist/assets | grep -c ibm-plex` is above 0. `npm run test:unit`: 0 tests.

`node tools/ui-check/run.mjs --no-shots --task 2`: expected exit 0 with `75 findings, 75 known (allow.json), 0 new` (clipped 9, contrast 1, hint-lines 19, name 32, sidebar 3, tab 10, target 1; measured as 72 before the tool was hardened, plus the three `clipped` texts of the old sidebar) and the line that seven entries are past their task: the seven with `"until": 2`. Delete those seven from `allow.json` (18 remain), run again with `--task 2`: exit 0, no stale entry.

Screenshots for the reviewer: `node tools/ui-check/run.mjs --no-build --pages "general,engine,ai,soundboard,files" --lang en --size 1600x900`. The ten old pages must look like the old layout in the new colours, type and controls: nothing unstyled, nothing overlapping.

- [ ] **Step 6: Commit**

```bash
git add src/styles src/style.css index.html soundboard.html package.json package-lock.json tools/ui-check/allow.json
git commit -F - <<'EOF'
feat: design tokens, shared components and the bundled font (look B); nothing is fetched from Google Fonts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: The shell: five-item sidebar, routing, the status model, the backend additions

This task carries all Rust of the redesign, including the first run's microphone meter that Task 5 uses, so only one task needs the Rust toolchain.

**Files:**
- Create: `src/shell.ts`, `src/route.ts`, `src/prefs.ts`, `src/status.ts`, `src/status-view.ts`, `src/activity.ts`, `src/setup.ts`, `src/styles/shell.css`, `tests/unit/status.test.ts`, `route.test.ts`, `prefs.test.ts`, `setup.test.ts`
- Modify: `index.html`, `src/main.ts`, `src/ai-settings.ts`, `src/files.ts`, `src/i18n.ts`, `src/style.css`, `src/overlay.html`, `src-tauri/src/audio.rs`, `src-tauri/src/whisper_engine.rs`, `src-tauri/src/main.rs`, `tools/ui-check/pages.mjs`, `mock.js`, `contract.json`, `allow.json`
- Test: `audio.rs`, `whisper_engine.rs` (`mod tests`, `--lib`), `main.rs` (`--bins`), `tests/unit/*`

**Interfaces:**
- Produces (Rust, `rudariflow_lib::whisper_engine`): `pub enum LoadState { Unloaded, Loading, Loaded, Failed }` (serde lowercase); `WhisperEngine::load_state(&self) -> LoadState`, `device(&self) -> String`, `on_load_change(&self, Box<dyn Fn() + Send + Sync>)`, `loaded_once(&self) -> bool` (this plan's addition).
- Produces (Rust, `rudariflow_lib::audio`): `pub struct MicMeter` with `new()`, `start(&self, app: &AppHandle, mic_name: &str) -> Result<(String, u64), String>`, `stop(&self)`, `running(&self) -> bool` (false again once the device was lost), `run(&self) -> u64`; `pub(crate) fn meter_level(data: &[f32]) -> f32`; `pub fn open_with_fallback<T>(mic_name, open) -> Result<T, String>` (the microphone, once more, then the default input: a dictation and the meter open their device through it).
- Produces (commands in `main.rs`): `speech_status() -> SpeechStatus`; `mic_meter_start() -> Result<String, String>` (the name of the device really open; `Err("stopped")` when a stop or a newer start came while it opened; stops itself after 120 s without an event, and when the main window closes to the tray); `mic_meter_stop()`. Pure helpers with tests: `speech_freed(released, idle_unloaded, loaded_once)`, `speech_reload(prev, next) -> (drop, load)` (a switch from the cloud to the local engine loads the model), `dictation_blocked_now(state)` (also asked by Rewrite last before it selects anything). `SpeechStatus` (serde camelCase): `{ engine: "local"|"cloud", model: String, downloaded: bool, load: LoadState, freed: bool, cloudKey: bool, device: String }`.
- Produces (events): `speech-status` (a `SpeechStatus`, on every change of the load state, after `save_settings`, after a model download); `speech-notice` (payload `"no_model"`, to the pill, when a dictation hotkey finds no downloaded model for the local engine; nothing is recorded); `ui-language` (payload the saved `uiLanguage` string, when the Display Language changes); `mic-level` (f32 0 to 1, about 30 per second while the meter runs; one last 0 when the device is lost).
- Produces (tray): "Show RudariFlow" / "RudariFlow anzeigen", "Quit" / "Beenden" follow the Display Language (`tray_show_text`, `tray_quit_text`).
- Produces (`src/status.ts`, pure): types `LoadState`, `SpeechStatus`, `StatusInput` (with `download`, the first download's percent, and `speechDownload`, the speech model's own), `Missing` (`"microphone"|"model"|"key"|"load"`), `StatusKind` (`"setup"|"downloading"|"recording"|"transcribing"|"meeting"|"file"|"loading"|"game"|"freed"|"ready"`), `Tone`, `Status { kind, tone, missing, percent, marker }`; `missing(input)`, `status(input)`, `statusText(s) -> { key, n }`, `statusSaid(s) -> { key, marker }` (what a screen reader is told: no percent), `homeTitle(s)`. One case comes before "Setup needed": the speech model is the only thing missing and its download runs; the status is then `downloading` with that percent, `missing` stays `["model"]` and `homeTitle` is `home_title_setup`. Any other download leaves `homeTitle` at `home_title_ready`.
- Produces (`src/route.ts`, pure): `SECTIONS`, `TABS`, types `Section`, `Tab`, `Route`; `HOME`, `route(section, tab)`, `startRoute(saved, setupNeeded)`, `resolve(name, from)` (also the ten section names of 0.16.0).
- Produces (`src/prefs.ts`, pure): `Store`, `Prefs { section, tab, folds, panels, aiCardDismissed }`, `PREFS_KEY = "rudariflow-ui"` (localStorage; view state only, never settings), `defaultPrefs()`, `loadPrefs(store)`, `savePrefs(store, prefs)`, `changePrefs(store, current, change)`.
- Produces (`src/setup.ts`, pure; Task 5 shows it): `SetupInput`, `Setup { needed, microphone, model, aiCard }`, `setup(input)`, `Gpu`, `Recommendation`, `recommend(gpus)`, `sizeText(bytes)`.
- Produces (`src/shell.ts`): `prefs`, `updatePrefs(change)`, `currentRoute()`, `onRoute(fn)`, `announceRoute()` (once, at the end of `main.ts`'s start: tells every `onRoute` listener the place the window starts on, with `before` equal to `now`; a listener must bear hearing of a place twice), `go(name)`, `startOn(setupNeeded)`, `reveal(id)`, `initShell()`. (`src/status-view.ts`): `StatusHost`, `statusInput()`, `currentStatus()`, `currentSpeech()`, `onStatus(fn)`, `renderStatus()`, `refreshSpeech()`, `initStatus(host)`. (`src/activity.ts`): `DownloadKind` (`"speech"|"ai"|"speaker"`), `setDownload(kind, percent|null)`, `setFileRunning(on)`, `activity() -> { download, kind, speech, fileRunning }` (the first download's percent and which it is, the speech model's percent), `onActivity(fn)`. (`src/ai-settings.ts`): `aiActivity()`, `AiSettingsHost.changed`.
- Produces (markup): `#sidebar` with `#status-indicator.status-pill[data-tone][data-kind]`, `#status-text` (`aria-hidden`: it changes with every percent; a setup text's reason is a `span.status-reason`), `#status-marker` (a ring, `role="img"`), `#status-live.sr-only` (`role="status"`: what is read out, `statusSaid`); `button.nav-item[data-section]` × 5 with `aria-current="page"`; sections `#section-home|files|meetings|soundboard|settings`; `#settings-tabs` (`role="tablist"`), `#tab-<tab>`, `#panel-<tab>`.
- Produces (i18n): `status_setup_microphone|model|key|load`, `status_downloading`, `status_downloading_said`, `status_meeting`, `status_file`, `status_loading`, `status_game`, `status_freed`, `status_marker_meeting|file`, `nav_label`, `nav_home`, `nav_settings`, `settings_title`, `tab_dictation|ai|dictionary|models|general`, `home_title_ready|setup|loading`. Removed: the nav and title keys of the seven pages that became tabs.

- [ ] **Step 1: The Rust additions**

```bash
cd $R && apply_stage $W/src-tauri/src $P/rs/src-tauri/src src-tauri/src
git diff --stat src-tauri
```

Expected: `merged` for `audio.rs`, `main.rs`, `whisper_engine.rs`; 3 files, 476 insertions, 25 deletions. Read the whole diff: it is unreviewed and was never compiled here.

- [ ] **Step 2: Correction: a model that is not in memory is "freed", not "loading" (new code)**

The prototype sets `freed` from `released() || gpu.idle_unloaded`. `idle_unloaded` is cleared by `start_ai` and by every hotkey event while Whisper can stay unloaded (for example: models unloaded when idle, then AI cleanup switched in Settings); the window would then say "Loading models…" until the next dictation. Read from the code, not observed. In `whisper_engine.rs`:

```rust
    /// A model was loaded at least once since the start (`loaded_once`).
    loaded_once: AtomicBool,
```

in `struct WhisperEngine`, `loaded_once: AtomicBool::new(false),` in `new`, and in `ensure_loaded`, directly before `self.set_load_state(LoadState::Loaded);`: `self.loaded_once.store(true, Ordering::SeqCst);`. Next to `load_state`:

```rust
    /// True once a model was loaded since the start. From then on "no model
    /// in memory" means it was unloaded (Free GPU, a game, idle, the PC
    /// check), not that the start's load is still to come.
    pub fn loaded_once(&self) -> bool {
        self.loaded_once.load(Ordering::SeqCst)
    }
```

In `main.rs`, `speech_status_now`:

```rust
    let freed = state.whisper_engine.released()
        || state.gpu.idle_unloaded.load(Ordering::SeqCst)
        || state.whisper_engine.loaded_once();
```

In the test `the_load_state_follows_loads_and_unloads`, after the failed load: `assert!(!engine.loaded_once(), "nothing was loaded yet");`. Known and accepted: a change of the model shows "GPU freed" for a moment before "Loading models…".

- [ ] **Step 3: Run the Rust tests (filtered) and clippy**

```bash
cd $R/src-tauri
<RUST-ENV> cargo test --no-default-features --lib meter                    # see Build environment note
<RUST-ENV> cargo test --no-default-features --lib the_load_state
<RUST-ENV> cargo test --no-default-features --bins tray
<RUST-ENV> cargo test --no-default-features --bins speech_status
<RUST-ENV> cargo test --no-default-features --bins without_a_speech_model
<RUST-ENV> cargo clippy --no-default-features --lib --bins --tests
```

Expected: the six new tests pass (`the_meter_level_is_zero_for_silence_and_capped_for_loud`, `a_meter_that_is_not_running_stops_quietly`, `the_load_state_follows_loads_and_unloads`, `the_tray_menu_follows_the_display_language`, `the_speech_status_says_what_a_dictation_needs`, `a_dictation_without_a_speech_model_is_not_started`; a filter may run older tests too, such as `the_tray_item_starts_or_stops_in_the_ui_language`); clippy has no finding in the lines this task added. If `git diff --ignore-cr-at-eol --stat src-tauri/Cargo.toml` is empty but the file shows as changed, `git checkout -- src-tauri/Cargo.toml`.

- [ ] **Step 4: The pill: Display Language and the no-model notice**

`git merge-file src/overlay.html $W/src/overlay.html $P/app/src/overlay.html` (the pill reads `uiLanguage` from `get_settings`, listens to `ui-language` and `speech-notice`, a long notice may take two lines, the cancel button gets its name). Correction, the two new texts carry a dash; write them as:

```js
          no_model: "No speech model yet. Open RudariFlow to download one.", cancel: "Cancel recording",
```

```js
          no_model: "Noch kein Sprachmodell. Öffne RudariFlow und lade eines herunter.", cancel: "Aufnahme abbrechen",
```

- [ ] **Step 5: Commit the backend half**

```bash
cd $R && git add src-tauri/src/audio.rs src-tauri/src/whisper_engine.rs src-tauri/src/main.rs src/overlay.html
git commit -F - <<'EOF'
feat: the speech model's state for the window, a pill notice when no model is downloaded, the tray and the pill in the Display Language, a microphone level for the setup

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

(The window still shows the old status; the new commands and events have no listener yet. `tsc`, `vite build` and `ui-check` stay as after Task 2.)

- [ ] **Step 6: The frontend of stage 3**

```bash
cd $R && apply_stage $W/src $P/app_src_task3 src
# apply_stage copies "new" files over the repo's and leaves conflict markers in style.css: Task 2's reviewed files come back.
git checkout -- src/style.css src/styles/tokens.css src/styles/components.css
# style.css: stage 3 is Task 2's file (commit bcb7eb3) without the shell rules, which moved to styles/shell.css.
# Merge that difference into the reviewed file. Never `cp` the stage's file: Task 2's review fixes would be lost.
T=$(mktemp -d); crlf() { sed 's/\r$//; s/$/\r/' "$1"; }     # the stages have CRLF line ends; a file with LF conflicts on every line
git show bcb7eb3:src/style.css > $T/task2.css && crlf $T/task2.css > $T/base.css
crlf src/style.css > $T/ours.css && cp $T/ours.css src/style.css
git merge-file src/style.css $T/base.css $P/app_src_task3/style.css && echo "merged    style.css"; rm -rf $T
cp $P/app_index_task3.html index.html                # the new sidebar; the old pages' blocks moved whole into the five tab panels
rm src/arm.ts src/search.ts                          # they come with Tasks 7 and 4
mkdir -p tests/unit && cp $P/app/tests/unit/{status,route,prefs,setup}.test.ts tests/unit/
```

Expected output: `merged` for `ai-settings.ts`, `files.ts`, `i18n.ts`, `main.ts`; `CONFLICT style.css` (undone by the checkout; the three-way merge below it then prints `merged    style.css`, no conflict, rehearsed with either kind of line ends in the repo's file); `new` for `activity.ts`, `arm.ts`, `prefs.ts`, `route.ts`, `search.ts`, `setup.ts`, `shell.ts`, `status-view.ts`, `status.ts`, `styles/shell.css`, and for `styles/tokens.css`, `styles/components.css` (undone by the checkout too). Then compare by hand that stage 3's two files hold nothing the repo's lack: `diff --strip-trailing-cr $P/app_src_task3/styles/tokens.css src/styles/tokens.css` and the same for `components.css` show only the changes of Task 2 and its review (`.hint-more`'s padding; `--accent-active`, `--line-strong`; disabled, armed and pressed states; `.list-row`, `.setting-control` and `kbd` wrapping; the tab's mark as `::after`; `.card` padding; `.sr-only, .mt-sr-only`; `.link-btn`), and `src/style.css` is 1659 lines: stage 3's file without `.subsection-title`, `.subsection-desc`, `.link-btn`, `.progress-track`, `.progress-fill`, `.field-textarea` (with its `:focus`) and `.mt-sr-only`, and with the review's `.download-progress` rule. `src/overlay.html` is not touched by this step. `src/sidebar-logo.png` stays: `index.html` shows it as `<img class="app-logo">`, 136×30 px, `object-fit: cover`, which cuts the one-line mark out of the square PNG.

- [ ] **Step 7: Correction: two windows share the preferences**

The pop-out (Task 8) and the main window both write the one localStorage key; with the prototype's `rememberPrefs` each writes back what it read at its start and undoes the other. Append to `src/prefs.ts`:

```ts

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
```

In `src/shell.ts`: import `changePrefs, loadPrefs, type Prefs` (no `savePrefs`), and replace `prefs` and `rememberPrefs` with:

```ts
/** What the window remembers. Read it; change it with `updatePrefs`. */
export let prefs: Prefs = loadPrefs(storage());

/** Change what the window remembers and save it (the pop-out's changes are kept, see `changePrefs`). */
export function updatePrefs(change: (prefs: Prefs) => void) {
  prefs = changePrefs(storage(), prefs, change);
}
```

Its two callers become `updatePrefs((p) => { p.section = current.section; p.tab = current.tab; });` (in `show`) and `updatePrefs((p) => (p.folds[key] = fold.open));` (the fold's `toggle`). In `tests/unit/prefs.test.ts` import `changePrefs` too and append:

```ts

test("two windows on one store do not undo each other", () => {
  const store = memory();
  const main = loadPrefs(store);
  const popOut = loadPrefs(store);
  changePrefs(store, popOut, (p) => (p.panels.popout = true));
  const now = changePrefs(store, main, (p) => (p.section = "settings"));
  assert.deepEqual(loadPrefs(store), { ...defaultPrefs(), section: "settings", panels: { popout: true } });
  assert.equal(now.panels.popout, true, "the main window goes on with the pop-out's choice");
  const refusing: Store = {
    getItem: () => null,
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(changePrefs(refusing, main, (p) => (p.tab = "ai")).tab, "ai", "a store that refuses: the window still remembers until it closes");
});
```

- [ ] **Step 8: Correction: every page starts at the same left edge**

The prototype centres each page in the content area, each with its own width: at 2560 px the headings start at x 972 (Home, Settings), 232 (Files), 1080 (Meetings), 480 (Soundboard). The mockups put the content next to the sidebar. Change `margin: 0 auto;` to `margin: 0;` in three rules and keep their `max-width`: `.content-section` (`src/styles/shell.css`), `#section-soundboard .sb-layout` and `.mt-layout` (`src/style.css`). Not `.sb-page-main` (the pop-out's own window).

- [ ] **Step 9: Correction: the status says "Setup needed"**

The spec's first status is "Setup needed (what is missing)"; the prototype shows only what is missing. In `src/i18n.ts`:

```ts
  status_setup_microphone: "Setup needed: no microphone",
  status_setup_model: "Setup needed: no speech model",
  status_setup_key: "Setup needed: Groq key missing",
  status_setup_load: "Setup needed: model did not load",
```

```ts
  status_setup_microphone: "Einrichtung nötig: kein Mikrofon",
  status_setup_model: "Einrichtung nötig: kein Sprachmodell",
  status_setup_key: "Einrichtung nötig: Groq-Schlüssel fehlt",
  status_setup_load: "Einrichtung nötig: Modell lädt nicht",
```

(The two load texts were shortened in the review: in the 164 px pill every setup text takes two lines, "Setup needed:" and its reason. `status-view.ts` puts the reason, the part after ": ", into a `span.status-reason` that wraps as one.)

- [ ] **Step 10: The tool learns the new shell**

```bash
cp $P/tool3/{pages.mjs,mock.js} tools/ui-check/     # Task 1 and 2 did not change these two
```

In `tools/ui-check/pages.mjs`:
- replace the line `pill("notice", …)` with the two entries `pill("notice", …, async (page) => { … })` and `pill("no-model", …)` of `$P/tool8/pages.mjs` (they check that the pill speaks the Display Language, follows `ui-language`, and that the no-model notice shows and fits);
- in the `shell` probe, after the line that checks `"the status at the start"`, add:

```js
      // Every page starts at the same left edge.
      const lefts = [];
      for (const name of ["home", "files", "meetings", "soundboard", "settings"]) {
        await section(page, name);
        lefts.push(await page.evaluate((s) => Math.round(document.querySelector(`#section-${s} .section-title`).getBoundingClientRect().left), name));
      }
      out.push(...expect(new Set(lefts).size === 1, "every page starts at the same left edge", JSON.stringify(lefts)));
      await section(page, "home");
```

- added in the review, both in the `shell` probe: for the first run (in place of `if (firstrun) return out;`) Settings › Models & GPU, Download, 201 progress events: the status is `downloading` and ends in "43 %", and `#status-live` changed once; then a reload, because the mock's download never ends. For the populated data set, after "the section and the tab are remembered": opened on Settings › AI cleanup, `list_open_apps` is asked for once; opened on the Soundboard, `tauri://drag-enter` gives `#sb-root` the class `dragging`.

In `tools/ui-check/contract.json` set `removedIds` to the seven entries of `$P/tool3/contract.json` (`section-general`, `section-engine`, `section-recording`, `section-dictionary`, `section-replacements`, `section-ai`: "Task 3: the page became a tab of Settings"; `section-history`: "Task 3: the list is on Home, its setting in Settings > General"). Keep `dashKeys`.

- [ ] **Step 11: Verify**

`npx tsc --noEmit` clean; `npx vite build` clean; `npm run test:unit`: `tests 31`, `fail 0` (status 15, setup 8, prefs 4, route 4; 23 before the review: status 9, setup 7, prefs 4, route 3).

`node tools/ui-check/run.mjs --no-shots --task 3`: `50 findings, 50 known` (clipped 6, hint-lines 12, name 32), 0 new, and seven entries past their task, the seven with `"until": 3`; delete them (11 remain), run again: exit 0. The run includes: the sidebar fits 900×600, Tab reaches the five nav buttons and they show focus, the status probe (ready, recording, a meeting's marker, the remembered section and tab; since the review also the first model's download, announced once, and a window opened on Settings › AI cleanup or on the Soundboard), the left-edge probe, both pill probes, the 39 round-trip changes on the moved controls. After the review the count is unchanged: 50 known (clipped 6, hint-lines 12, name 32), 0 new.

Screenshots: `--pages "shell,home,settings-*" --size 1600x900` and `--size 900x600`, `--pages "pill-*"`. The logo is one line, the status pill sits under it, Settings is at the bottom above the version; the five tabs hold the old pages' rows (not yet regrouped: that is Task 6); Home is a heading and the old history list.

`diff -ru --strip-trailing-cr $P/app_src_task3 src` shows only: Steps 7 to 9, the two deleted files, `overlay.html` (Step 4), the logo, and Task 2's review fixes in `style.css`, `styles/tokens.css` and `styles/components.css` (Step 6 lists them). After this task's own review also: `status.ts`, `status-view.ts`, `activity.ts`, `shell.ts`, `route.ts`, `setup.ts`, `prefs.ts`, `styles/shell.css` (the paragraph "After the review of Task 3" says what), the marker's ring in `styles/components.css`, and small edits in `main.ts` (`announceRoute`, the sidebar's scrollbar), `ai-settings.ts` (`downloadInFlight`) and `i18n.ts` (the two load texts, `status_downloading_said`).

- [ ] **Step 12: Commit**

```bash
git add index.html src tests tools/ui-check
git commit -F - <<'EOF'
feat: five sidebar items with Settings in five tabs, one status that says what is missing, and the window remembers where it was

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: Home: hotkeys, quick switches, what is loaded, recent dictations

The prototype has Home and the first run as one stage (5). This task takes stage 5 and leaves the first run out; Task 5 puts it back. The cut was built and checked in a scratch copy (type-checks; `ui-check` 49 known, 0 new).

**Files:**
- Create: `src/home.ts`, `src/history.ts`, `src/mirror.ts`, `src/search.ts`, `src/styles/home.css`, `tests/unit/search.test.ts`
- Modify: `index.html`, `src/main.ts`, `src/ai-settings.ts`, `src/dictionary.ts`, `src/i18n.ts`, `src/style.css`, `tools/ui-check/pages.mjs`, `mock.js`, `allow.json`

**Interfaces:**
- Consumes: `shell.ts` (`reveal`), `status-view.ts` (`currentSpeech`, `currentStatus`, `onStatus`), `status.ts` (`homeTitle`, `statusText`), `hotkey-capture.ts` (the existing capture), the Settings controls `#ai-toggle`, `#language-select`, `#ai-output-select`, `#mic-select`.
- Produces (`src/search.ts`, pure): `fold(text)`, `matches(texts, query)`, `RECENT = 8`, `PAGE = 50`, `Shown<T>`, `shown(all, texts, query, expanded, pages)`.
- Produces (`src/mirror.ts`): `mirrorSelect(source, copy) -> sync`, `mirrorSwitch(source, copy) -> sync` (a second control for a Settings control: same value, the change goes through the Settings control's own handler).
- Produces (`src/history.ts`): `HistoryHost { mode() }`, `initHistory(host)`, `refreshHistory()`; rows are `article.list-row.history-item` with `.history-text`, `.history-meta` (app · time · length · model, wraps), actions Copy, Original / AI version, Play, Re-run, Delete.
- Produces (`src/home.ts`): `HomeHost { recordingMode(), dictationKey(), ai(), addWords(text) }` (Task 5 adds three members), `initHome(host)`, `renderHome()`. (`src/ai-settings.ts`): `aiSummary()`. (`src/dictionary.ts`): `addWords(text)` exported.
- Produces (markup): `#home-title`, `#home-status`, `#home-status-text`, `#home-how`, `#home-notice`, `#home-notice-open`, `#home-daily.home-grid` (class `wide` from 900 px of content), `#home-controls`, `#home-hotkeys` (`#home-hotkey-btn`, `#home-paste-last-btn`, `#home-rewrite-last-btn`, `#home-free-gpu-btn` with `…-text`), `#home-switches` (`#home-ai-toggle`, `#home-ai-status`, `#home-language-select`, `#home-output-select`), `#home-loaded` (`button.home-loaded-row[data-reveal]`, `#home-loaded-speech|ai|mic`), `#home-word-form`, `#home-word-input`, `#home-word-status`, `#home-recent` (`#history-search`, `#history-list`, `#history-empty`, `#history-more`, `#history-less`). In Settings › General: `#history-count`, `#history-clear`.
- Produces (i18n): `home_how_hold|toggle`, `home_key_dictate|paste|rewrite|unset`, `home_loaded_speech|ai`, `home_speech_loading|failed|unloaded|missing`, `home_load_failed`, `home_open_models`, `home_word_label|added|known`, `home_recent_title|search|all|more|less|none`.

- [ ] **Step 1: Merge stage 5**

```bash
cd $R && apply_stage $P/app_src_task3 $P/app_src_task5 src
git merge-file index.html $P/app_index_task3.html $P/app_index_task5.html
cp $P/app_src_task5/search.ts src/ && cp $P/app/tests/unit/search.test.ts tests/unit/
git merge-file tools/ui-check/pages.mjs $P/tool3/pages.mjs $P/tool5/pages.mjs
git merge-file tools/ui-check/mock.js $P/tool3/mock.js $P/tool5/mock.js
```

Expected: `merged` for `ai-settings.ts`, `dictionary.ts`, `i18n.ts`, `main.ts`, `style.css`; `new` for `history.ts`, `home.ts`, `mirror.ts`, `styles/home.css`; no conflict (checked on a copy that had Task 3's corrections; `style.css` rehearsed again with Task 2's review fixes: clean; all seven merged files rehearsed again with Task 3's review fixes: clean, and the fixes are still in the result: `announceRoute` at the end of `main.ts`, `downloadInFlight` in `ai-settings.ts`, `#status-live` in `index.html`, the two added parts of the `shell` probe).

- [ ] **Step 2: Leave the first run to Task 5**

- `src/home.ts`: delete the section from `// ── First run ─` up to (not including) `// ── Layout ─` (`currentSetup`, `step`, `renderSetup`, `meter`, `progress`); in `initHome` delete from `// The setup.` up to (not including) `new ResizeObserver(layout)`; delete the line `mirrorSelect(select("mic-select"), select("setup-mic-select")),`; in `renderHome` write `renderHeader(now, false);` and delete `renderSetup();`; in `HomeHost` delete `microphones`, `aiModel`, `setUpAi`; delete `interface DownloadProgress`, the constants `setupBox`, `aiCard`, the variables `gpus`, `suggestion`, `metering`; then the imports `tsc` names as unused (`invoke`, `listen`, `activity`, `prefs`, `rememberPrefs`, everything from `./setup.ts`).
- `src/main.ts`: delete `hotkeyView("dictation", "setup-hotkey"),` and its comment; in `startHome` delete `microphones`, `aiModel`, `setUpAi`; drop `aiModelInfo` and `setUpAi` from the import.
- `src/ai-settings.ts`: delete `aiModelInfo` and `setUpAi` (keep `aiSummary`).
- `src/styles/home.css`: delete from `/* ── First run ─` to the end.
- `src/status-view.ts`: Task 3 wrote Home's heading there, because nothing else set it (in `renderStatus`: the constant `homeHeading` and the block `if (homeHeading) { … }` with `homeTitle(now)`). `home.ts` takes the heading over (`renderHeader`, from `onStatus`): delete the constant, that block with its comment, and `homeTitle` from the import. `status-view.ts` is in no stage, so this is an edit by hand.
- `index.html`: delete `<div id="home-setup" …>` and `<div id="home-ai-card" …>` (everything between `#home-notice`'s closing tag and `<div id="home-daily"`).
- `src/i18n.ts`: delete the 17 `setup_*` keys and `progress_numbers`, in both tables (36 lines).
- `tools/ui-check/pages.mjs`, probe of the page `home`: replace the whole block `if (firstrun) { … return out; }` with `if (firstrun) return out; // the first run: Task 5`, and the line that expects `"the daily view shows once the setup is done"` with `out.push(...expect(await shown("home-daily"), "Home shows the daily view"));`.

- [ ] **Step 3: Verify**

`npx tsc --noEmit` clean; `npx vite build` clean; `npm run test:unit`: `tests 35` (+ search 4).

`node tools/ui-check/run.mjs --no-shots --task 4`: `49 findings, 49 known`, one stale entry (`span.history-meta`, `"until": 4`); delete it (10 remain); exit 0. The `home` probe checks: two columns from 900 px of content and the recent dictations after the quick switches below it; Home's AI switch, Language and a hotkey set on Home change the setting and show in Settings at once; "Add a word" lands in the dictionary; the search finds a dictation by its app. `home-all` checks Show all (50), Show more (+50), the end of the list, Show fewer (8).

Screenshots: `--pages "home,home-all,settings-general" --size 1600x900`, `--size 900x600`, and `--lang de --size 900x600`: compare with `mockups/home.html` option 2 and `look.html` option B; in German the history's second line wraps and loses nothing (audit, German defect 2). With the first-run data set Home shows the daily view with empty lists and the status "Setup needed: no speech model"; the steps come with Task 5.

- [ ] **Step 4: Commit**

```bash
git add index.html src tests tools/ui-check
git commit -F - <<'EOF'
feat: Home, the dictation page: the hotkeys set in place, quick switches, what is loaded, recent dictations with search

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: The first-run setup on Home

**Files:**
- Modify: `index.html`, `src/home.ts`, `src/main.ts`, `src/ai-settings.ts`, `src/i18n.ts`, `src/styles/home.css`, `tools/ui-check/pages.mjs`

**Interfaces:**
- Consumes: `setup.ts` (`setup`, `recommend`, `sizeText`), commands `mic_meter_start`, `mic_meter_stop`, `detect_gpus`, events `mic-level`, `download-progress`, `ai-download-progress` (Task 3), `shell.ts` (`prefs`, `updatePrefs`, `reveal`), `activity.ts`.
- Produces (`src/home.ts`): `HomeHost` gains `microphones(): number | null`, `aiModel(id): { name, bytes } | null`, `setUpAi(id): Promise<boolean>`. (`src/ai-settings.ts`): `aiModelInfo(id)`, `setUpAi(id)`.
- Produces (markup): `#home-setup` (`#setup-mic`, `#setup-mic-text`, `#setup-level` as `role="meter"`, `#setup-level-fill`, `#setup-mic-select`, `#setup-mic-change`; `#setup-model`, `#setup-model-text`, `#setup-model-progress`, `#setup-model-fill`, `#setup-model-numbers`, `#setup-model-download`; `#setup-key`, `#setup-key-text`, `#setup-hotkey-btn`), `#home-ai-card` (`#setup-ai-text`, `#setup-ai-progress`, `#setup-ai-download`, `#setup-ai-dismiss`).
- Produces (i18n): the 17 `setup_*` keys, `progress_numbers` ("{percent} % · {done} of {total}").
- Behaviour: Home shows the steps while `setup(...).needed` (no microphone, or no speech model for the engine, or the cloud engine without its key); the microphone is open only while the steps are on screen and the window is visible; the optional AI card stays until its model is downloaded or it is dismissed (`prefs.aiCardDismissed`).

- [ ] **Step 1: Put back what Task 4 left out**

Everything in Task 4 Step 2's list, taken from `$P/app_src_task5/` (`home.ts`, `main.ts`, `ai-settings.ts`, `i18n.ts`, `styles/home.css`), `$P/app_index_task5.html` (lines 85 to 149) and `$P/tool5/pages.mjs` (the `home` probe's first-run branch and its original daily-view line). Afterwards `diff -ru --strip-trailing-cr $P/app_src_task5 src` shows only the corrections of Tasks 3 to 5 and review fixes. (Not the heading lines Task 4 deleted from `status-view.ts`: they stay deleted.)

Notes from the review of Task 3, for `home.ts`:

- **"Setup needed" has two definitions.** `status.ts` counts a speech model that failed to load as setup (`missing` is `["load"]`), `setup.ts` does not (`setup(...).needed` asks only for a microphone and a downloaded model or the cloud key). So with a failed load the pill says "Setup needed: model did not load" while the steps do not show. Home must then show its load-failed notice with the link to Models & GPU (Task 4's `#home-notice`, `home_load_failed`, `home_open_models`). Verify it with a probe in the `home` page of `pages.mjs`: emit `speech-status` with `downloaded: true, load: "failed"` and expect `#home-notice` shown, `#home-setup` hidden and the pill's kind `setup`.
- **The first model's download is a status of its own.** While the only thing missing is the speech model and its download runs, the status is `downloading` with that percent, its `missing` stays `["model"]` and `homeTitle` gives `home_title_setup`. `setup(...).needed` is still true, so the steps stay on screen with their progress bar.
- **The microphone meter, three facts.** (1) The backend stops the meter after 120 s without a word to the page (`MIC_METER_MAX`; no event). A page that shows the level for longer needs its own timer that starts the meter again, or the bar stays at zero. (2) `mic_meter_start` answering `Err("stopped")` means a stop or a newer start came while the device opened; it is no error to show or to log as one. (3) The prototype's `meter()` sets `metering = false` in its `catch` also when a newer start has succeeded in the meantime (start, stop, start in quick succession: the first start's "stopped" arrives last). The page then believes the meter is off and never sends `mic_meter_stop`: the microphone stays open until the backend's limit. Fix it in `home.ts`: number the calls and let only the latest one's answer set `metering`. Also: the name `mic_meter_start` returns is the device really open (the default input when the saved microphone is unplugged, as for a dictation), a lost device ends the meter with one last `mic-level` of 0, and closing the window to the tray stops it.

- [ ] **Step 2: Corrections**

- `src/main.ts` (found by the re-review of Task 3): when the first model's download ends, the status steps back to "Setup needed: no speech model" before "Loading models…". `downloadCurrentModel` clears the speech download in its `finally` and only then are the labels refreshed and (on the `model-select` change path, which the first run's Download uses) the settings saved, so for that gap the backend still reports the saved model as missing. Clear the speech download only once the status is known: on the change path after `saveSettings()`, on the button path after `await refreshSpeech()`. Make the mock's download end (`tools/ui-check/mock.js`: a `download-progress` run that reaches 100 % and resolves the invoke) and add a probe to the `home` page's first-run branch that records every text `#status-text` takes from the click on Download to "Ready" and expects no "Setup needed" after the first "Downloading".
- `src/home.ts`: the prototype calls `rememberPrefs`. Import `prefs, reveal, updatePrefs` from `./shell` and write the dismissal as `updatePrefs((p) => (p.aiCardDismissed = true));`.
- `src/i18n.ts`, no dash (the spec quotes the sentence with one):

```ts
  setup_key_hold: "Hold it, speak, release. The text is typed where your cursor is.",
  setup_key_toggle: "Press it, speak, press it again. The text is typed where your cursor is.",
```

```ts
  setup_key_hold: "Halten, sprechen, loslassen. Der Text wird dort getippt, wo dein Cursor steht.",
  setup_key_toggle: "Drücken, sprechen, noch einmal drücken. Der Text wird dort getippt, wo dein Cursor steht.",
```

- [ ] **Step 3: Verify**

`npx tsc --noEmit`, `npx vite build` clean; `npm run test:unit`: `tests 35`. `node tools/ui-check/run.mjs --no-shots --task 5`: `49 findings, 49 known`, exit 0 (no entry has `"until": 5`). The first-run branch of the `home` probe checks: the steps show instead of the daily view; `mic_meter_start` is called and the level bar follows `mic-level`; Download asks for the model `recommend` suggests for the graphics card (`large-v3-turbo-q8_0` in the mock); the progress reads "43 % · 374 MB of 870 MB" (the sidebar's status says "Downloading 43 %" meanwhile, since Task 3's review); leaving Home calls `mic_meter_stop`. The `shell` probe: the first run starts on Home with the status kind `setup`.

Screenshots: `--pages home --scenario firstrun`, both sizes and both languages; compare with the first-run mockup in `mockups/home.html`.

- [ ] **Step 4: Commit**

```bash
git add index.html src tools/ui-check
git commit -F - <<'EOF'
feat: first-run setup on Home: microphone with a live level, the speech model recommended for this PC, the dictation key, optional AI cleanup

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 6: Settings: five tabs, Advanced folds, one-line hints with More

**Files:**
- Create: `src/rows.ts`, `src/models.ts`, `src/styles/settings.css`, `tests/unit/models.test.ts`
- Modify: `index.html`, `src/main.ts`, `src/ai-settings.ts`, `src/home.ts`, `src/i18n.ts`, `src/style.css`, `src/styles/components.css`, `tools/ui-check/pages.mjs`, `allow.json`

**Interfaces:**
- Produces (`src/rows.ts`): `nameRows(root = document)` (every control of a `.setting-row` is named after its `.label-text`; switches get `role="switch"`; a key box reads "label, key"), `initHints()` ("More" / "Less" on `.hint-more[aria-controls]`, the long text is `.hint-long[hidden]`).
- Produces (`src/models.ts`, pure): `SpeechModel`, `SPEECH_MODELS` (8), `speechModel(id)`, `modelSize(mb)`, `modelLabel(id)` ("Large v3 Turbo q8 · 870 MB").
- Produces (markup, per the spec's table): `#panel-dictation` (Dictate with Hold / Toggle and the key, Paste last, Rewrite last, Microphone, Start and stop sounds; `details.fold[data-fold="dictation"]`: Free GPU key, Meeting key, Mute other apps, "Send it"); `#panel-ai` (switch and status, Style, Write in, Edit mode, Instructions for all apps, Rules per app; fold: AI model, Try it); `#panel-dictionary` (suggestions, words with search and add, replacements with search and add, Swiss spelling; fold: Words on screen, Learn from corrections, Import and export); `#panel-models` (Speech model with ✓ / Download and percent plus size, Language; fold: Engine and Groq key, GPU backend with detected GPUs, PC check, Free GPU for games, Unload when idle, Unused models); `#panel-general` (Display Language, Start with Windows, Keep history, "Stored on this PC" with Delete history; no fold). Every control id of 0.16.0 is kept.
- Produces (i18n): `advanced`, `hint_more`, `hint_less`, the `*_more` long texts, `dictate_label|hint`, `mode_label`, `model_note_*`, `cloud_note`, `dict_words_title`, `dict_io_label|hint`, `history_stored_label`; about 30 hints shortened to one line; the eight `model_*` option labels and four Recording keys removed.

- [ ] **Step 1: Merge stage 6**

```bash
cd $R && apply_stage $P/app_src_task5 $P/app_src_task6 src
git merge-file index.html $P/app_index_task5.html $P/app_index_task6.html
rm src/confirm-delete.ts src/replacements.ts         # stage 6 has them, nothing imports them yet: Task 7
cp $P/app/tests/unit/models.test.ts tests/unit/
git merge-file tools/ui-check/pages.mjs $P/tool5/pages.mjs $P/tool6/pages.mjs
```

Expected: `merged` for `ai-settings.ts`, `home.ts`, `i18n.ts`, `main.ts`, `style.css`, `styles/components.css`; `new` for `confirm-delete.ts`, `models.ts`, `replacements.ts`, `rows.ts`, `styles/settings.css`; no conflict (rehearsed with the corrections of Tasks 3 to 5 in place, and again with Task 2's review fixes: `style.css` merges cleanly; for `styles/components.css` the stage's one line, `flex-wrap: wrap;` in `.setting-control`, is already there from Task 2's review, so the merge changes nothing and `git diff src/styles/components.css` stays empty). The two removed files are dead code in stage 6 (and `replacements.ts` uses two i18n keys that only stage 7 has, which the tool would report).

- [ ] **Step 2: Correction: place names**

Seven texts still name tabs that no longer exist (the prototype never changed them). Write them as:

| Key | English | German |
|---|---|---|
| `files_err_no_model` | `Download a speech model first (Settings › Models & GPU).` | `Lade zuerst ein Sprachmodell herunter (Einstellungen › Modelle & GPU).` |
| `files_err_no_ai_model` | `Download an AI model first (Settings › AI cleanup › Advanced).` | `Lade zuerst ein KI-Modell herunter (Einstellungen › KI-Korrektur › Erweitert).` |
| `mt_hint_notes_no_ai_model` | `No notes: the AI model is not downloaded (Settings › AI cleanup › Advanced).` | `Keine Notizen: Das KI-Modell ist nicht heruntergeladen (Einstellungen › KI-Korrektur › Erweitert).` |
| `mt_err_no_model` | `Download a speech model first (Settings › Models & GPU).` | `Lade zuerst ein Sprachmodell herunter (Einstellungen › Modelle & GPU).` |
| `mt_err_pc_check` | `The PC check is running (Settings › Models & GPU). Try again when it is done.` | `Der PC-Check läuft gerade (Einstellungen › Modelle & GPU). Versuch es noch einmal, wenn er fertig ist.` |
| `mt_err_model_busy` | `The speaker model is already being downloaded (Files). It is ready in a moment.` | `Das Sprechermodell wird schon heruntergeladen (Dateien). Es ist gleich bereit.` |
| `mt_quit_hint` | `The meeting is kept as interrupted; Finish under Meetings transcribes the rest and writes the notes.` | `Das Meeting bleibt als unterbrochen erhalten; „Abschließen“ unter Meetings transkribiert den Rest und schreibt die Notizen.` |

(`mt_quit_hint` also stands as fallback text in `index.html`: change it there too.) Check: `grep -n -i "engine tab\|tab engine\|cleanup tab\|tab ki-korrektur\|files tab\|tab dateien\|meetings tab\|tab meetings\|under recording" src/i18n.ts index.html` prints nothing.

- [ ] **Step 3: Verify**

`npx tsc --noEmit`, `npx vite build` clean; `npm run test:unit`: `tests 37` (+ models 2).

`node tools/ui-check/run.mjs --no-shots --task 6`: `17 findings, 17 known` (name 9: the rule rows, the replacement rows, the Files transcript; clipped 5: the rule-language selects, the Soundboard's device selects; hint-lines 3: the Soundboard), three stale entries (`name *`, `hint-lines *`, `select#*model-select`, all `"until": 6`); delete them (7 remain); exit 0. The run covers: every tab and every tab with Advanced open at three sizes in both languages; every hint on one line at 1600 px (two below); every control named; the `settings-models-advanced` probe (More opens the long hint in place, an open fold is remembered over a new start); the `shell` probe (the tab is remembered); and `roundtrip`: all 32 values shown, all 39 changes saved, among them every hotkey from its new place.

Screenshots: `--pages "settings-*" --size 1600x900`, `--size 900x600`, and `--lang de --size 900x600`; compare with `mockups/settings.html` option 1 and the spec's table row by row.

- [ ] **Step 4: Commit**

```bash
git add index.html src tests tools/ui-check
git commit -F - <<'EOF'
feat: Settings in five tabs (Dictation, AI cleanup, Dictionary, Models & GPU, General) with Advanced folds and one-line hints with More

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 7: The Dictionary tab, unified lists, one way to delete

**Files:**
- Create: `src/arm.ts`, `src/confirm-delete.ts`, `src/replacements.ts`, `tests/unit/arm.test.ts`
- Modify: `index.html`, `src/dictionary.ts`, `src/history.ts`, `src/ai-settings.ts`, `src/main.ts`, `src/meetings.ts`, `src/soundboard/board.ts`, `src/i18n.ts`, `src/style.css`, `src/styles/settings.css`, `tools/ui-check/pages.mjs`, `allow.json`

**Interfaces:**
- Produces (`src/arm.ts`, pure): `ArmEvent` (`{ type: "click", id } | { type: "cancel" }`), `ArmStep { armed, fire }`, `arm(armed, event)`: the first click arms, the second on the same id fires, a click on another id arms that one, cancel disarms.
- Produces (`src/confirm-delete.ts`): `DeleteOptions { name?, label?, armedLabel? }`, `confirmDelete(button, id, onDelete, options)`, `deleteButton(id, onDelete, options)` (a `.btn-text` with `data-delete-id`, class `armed` while armed), `forgetDelete(id)`, `repaintDeletes()` (after a language change). A button is known by its id, not its element: a list redrawn while a button is armed gets it back armed.
- Produces (`src/replacements.ts`): `Replacement { from, to }`, `ReplacementsHost`, `readReplacements()`, `renderReplacements()`, `initReplacements(host)`; rows `.replacement-row` with `.replacement-from`, `.replacement-to`.
- Consumes: `search.ts` (`matches`).
- Behaviour: every delete in the app is `deleteButton` / `confirmDelete`: a history entry (`history-<id>`), Delete history (`history-all`, texts `history_clear`, `history_clear_confirm`), a dictionary word (`word-<term>`), a replacement, an app rule, an unused model, a meeting (`meeting`), a sound (`sound-<id>`), a category (`category-<id>`). The button reads "Delete", armed "Delete?"; Esc, a click elsewhere or the focus leaving disarms; nothing deletes on one click; no timer. Lists use `.list-row` / `.list-main` / `.list-actions`.
- Produces (markup): `#dict-search`, `#dict-no-match`, `#replacement-search`, `#replacement-no-match`, `#replacement-cols`; rule rows with named fields (`.rule-app`, `.rule-language`, `.rule-instructions`, `.rule-off`).
- Produces (i18n): `delete`, `delete_confirm`, `dict_search`, `dict_no_match`, `replacement_search`, `replacement_no_match`, `replacement_from_label`, `replacement_to_label`, `rule_app_label`, `rule_language_label`, `rule_instructions_label`. Removed: `replacement_remove`, `history_delete`, `sb_delete`, `sb_delete_confirm`, `mt_delete`, `mt_delete_confirm`, `unused_model_delete`, `unused_model_confirm`, `unused_model_confirm_plain`, `ai_rule_off_hint`, `ai_rule_language_hint`.

- [ ] **Step 1: Merge stage 7**

```bash
cd $R && apply_stage $P/app_src_task6 $P/app_src_task7 src
git merge-file index.html $P/app_index_task6.html $P/app_index_task7.html
cp $P/app_src_task7/{arm.ts,confirm-delete.ts,replacements.ts} src/ && cp $P/app/tests/unit/arm.test.ts tests/unit/
git merge-file tools/ui-check/pages.mjs $P/tool6/pages.mjs $P/tool7/pages.mjs
```

Expected: `merged` for `ai-settings.ts`, `dictionary.ts`, `history.ts`, `i18n.ts`, `main.ts`, `meetings.ts`, `soundboard/board.ts`, `styles/settings.css`; `CONFLICT style.css` in one place (rehearsed with Task 2's review fixes; no other conflict). The three copied files exist in stage 6 already, so `apply_stage` does not bring them.

The conflict in `src/style.css` is the block under `/* ── AI cleanup ── */`, after the three `.ai-status[data-tone]` lines: the stage deletes it whole (`.link-btn` to `.pc-check-result`), Task 2's review had already deleted `.link-btn`, `.progress-track`, `.progress-fill` and `.field-textarea` from it and changed `.download-progress`. Our side holds `.ai-model-row`, `#download-progress, .download-progress`, `.rule-list`, `.rule-row`, `.rule-instructions` and `.pc-check-result`; the stage's side is empty. Take the stage's side: delete everything from `<<<<<<<` to `>>>>>>>` (in an editor, see the note on `sed -i` under "The prototype's measured state"); the next line is `.pc-check-result pre {`. Afterwards `diff --strip-trailing-cr $P/app_src_task7/style.css src/style.css` shows only Task 3's two `margin: 0;` and the missing `.mt-sr-only` rule (`components.css` hides it together with `.sr-only`). With the block the review's room above a download's bar goes, so put it where the rule now lives: in `src/styles/settings.css`, `.download-progress` gets `padding: var(--s2) 0 var(--s3);` instead of `padding: 0 0 var(--s3);` (the stage's bar touches the dividing line of the row above it).

- [ ] **Step 2: Correction: the suggestions follow the Display Language**

The tool's finding on the final prototype: in a German window the suggestion buttons read "Add". The suggestions are drawn once and not again after a language change. In `src/dictionary.ts` replace the head of `renderSuggestions` with:

```ts
/** The suggestions as the backend last sent them; drawn again with the list (a language change). */
let suggestions: Suggestion[] = [];

function renderSuggestions(now: Suggestion[] = suggestions) {
  suggestions = now;
  suggestList.innerHTML = "";
```

(the loop below it then iterates `suggestions`), and make `renderSuggestions();` the first line of `renderDictionary()`.

- [ ] **Step 3: Verify**

`npx tsc --noEmit`, `npx vite build` clean; `npm run test:unit`: `tests 41` (+ arm 4).

`node tools/ui-check/run.mjs --no-shots --task 7`: `7 findings, 7 known` (clipped 3 and hint-lines 3 on the Soundboard, name 1 on the Files transcript), three stale entries (`*.rule-*`, `*.replacement-*`, `select.rule-language`, all `"until": 7`); delete them (4 remain); exit 0. The `settings-dictionary` probe checks: the first click on Delete only arms, Esc disarms, a click elsewhere disarms, the second click deletes; the suggestions are in the Display Language; the word search finds "Zürich" for "zurich"; the replacement search hides rows and a save while searching keeps the hidden ones; a replacement needs two clicks. `grep -rn "armedDelete\|armedTimer\|_delete_confirm\|replacement_remove" src` prints nothing.

Screenshots: `--pages "settings-dictionary*,settings-ai,home,meetings-open,soundboard" --size 1600x900` and `--lang de --size 900x600`: one row design, "Delete" / "Löschen" everywhere; the rule-language select shows "Sprache wie eingestellt" whole (audit, German defect 3).

- [ ] **Step 4: Commit**

```bash
git add index.html src tests tools/ui-check
git commit -F - <<'EOF'
feat: Dictionary tab with search for words and replacements, one list design, and one way to delete everywhere (Delete, then Delete?)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 8: Tool pages (Files, Meetings, Soundboard settings panel), German overflows, motion

**Files:**
- Modify: `index.html`, `src/files.ts`, `src/rows.ts`, `src/soundboard/board.ts`, `src/i18n.ts`, `src/style.css`, `tools/ui-check/pages.mjs`, `allow.json`

**Interfaces:**
- Consumes: `shell.ts` (`prefs`, `updatePrefs`), `confirm-delete.ts`, `rows.ts`.
- Produces (Files): title "Files" / "Dateien"; `#section-files.has-file` while a file is loaded (the drop zone becomes one line, the description hides); `#file-text` has a name (`files_transcript`); Language and Speakers sit in a `.card`.
- Produces (Soundboard, `mountBoard`): a bar `.sb-bar` (`[data-key="enabled"]` switch with its status line, always visible; Stop all; Pop out; `[data-key="settings"]` with `aria-expanded`, `aria-controls="sb-panel"`), the panel `#sb-panel.sb-col.sb-col-settings` (Others hear, You hear, Play over each other, Sound hotkeys with More, its toggle key with More, Stop all key with More, Devices, the Discord hint), then the library. Open by default only in the layout `"wide"` (content at least 900 px, the left column as today); closed by default in `"narrow"` and `"popout"`; the user's choice per layout is kept in `prefs.panels`. The missing-cable hint shows outside the panel. `.hint-more[data-own]` buttons are the board's own (it redraws; `rows.ts` leaves them alone).
- Produces (i18n): `sb_settings`, `sb_hotkey_more`, `sb_sound_hotkeys_more`; changed `files_title`, `sb_stop_hotkey_hint`, `sb_sound_hotkeys_hint`, `sb_toggle_hotkey_label`, `sb_toggle_hotkey_hint`, `sb_auto`, `sb_auto_none`.
- Motion: only `page-in` (a section becoming active) and `fold-in` (a fold opening), both `var(--ease)` = 150 ms ease-out; none with `prefers-reduced-motion`. State indicators (the pulse of a recording dot, a progress bar's width) are not motion in this sense and stay.

- [ ] **Step 1: Merge the final stage**

```bash
cd $R && apply_stage $P/app_src_task7 $P/app/src src
git checkout -- src/overlay.html                     # Task 3 took the pill; the merge would only repeat or fight it
git merge-file index.html $P/app_index_task7.html $P/app/index.html
git merge-file tools/ui-check/pages.mjs $P/tool7/pages.mjs $P/tool8/pages.mjs
```

Expected: `merged` for `files.ts`, `i18n.ts`, `rows.ts`, `soundboard/board.ts`; `CONFLICT overlay.html` (undone by the checkout); `CONFLICT style.css` in one place, `#section-soundboard .sb-layout`: write `max-width: 880px;` (the stage's) and `margin: 0;` (Task 3's correction). Rehearsed again with Task 2's review fixes: this one conflict and no other; afterwards `diff --strip-trailing-cr $P/app/src/style.css src/style.css` shows only the two `margin: 0;` of Task 3 and the missing `.mt-sr-only` rule. `index.html` and `pages.mjs` merge cleanly (the pill entries Task 3 took from `tool8` are recognised as the same).

- [ ] **Step 2: Corrections**

1. `src/soundboard/board.ts`: import `prefs, updatePrefs` from `"../shell"`; the settings button's handler becomes `const open = !panelOpen(); updatePrefs((p) => (p.panels[layout()] = open)); render();`.
2. The cable's name must fit its select (tool: "Automatic (CABLE Input (VB-Audio Virtual Cable))" needs 313 px of 312; in German 328). `src/i18n.ts`: `sb_auto: "Auto ({name})"`, `sb_auto_none: "Auto (none found)"`; German `sb_auto: "Auto ({name})"`, `sb_auto_none: "Auto (keines gefunden)"`.
3. `index.html`: the Files options are setting rows on the bare background; give them the card every other row has: `<div class="card settings-list files-options">`.
4. `tools/ui-check/pages.mjs`: the prototype measures the transcript after "Summarise with AI", when the summary sits on top of it (y 649 of 600 at 900×600). Replace the entry `files-result` with two:

```js
  {
    id: "files-loaded",
    scenarios: ["populated"],
    fresh: true,
    open: async (page) => {
      await section(page, "files");
      await page.click("#file-choose");
      await wait(page, 500);
    },
    // With a file loaded the transcript starts on the first screen.
    probe: async (page) => {
      const at = await page.evaluate(() => [Math.round(document.getElementById("file-text").getBoundingClientRect().top), window.innerHeight]);
      return expect(at[0] < at[1], "the transcript starts on the first screen", `y ${at[0]} of ${at[1]}`);
    },
  },
  {
    id: "files-result",
    scenarios: ["populated"],
    fresh: true,
    open: async (page) => {
      await section(page, "files");
      await page.click("#file-choose");
      await wait(page, 500);
      await page.click("#file-summarize");
      await wait(page, 400);
    },
    // The summary is on top of the transcript: it starts on the first screen.
    probe: async (page) => {
      const at = await page.evaluate(() => [Math.round(document.getElementById("file-summary-box").getBoundingClientRect().top), window.innerHeight]);
      return expect(at[0] < at[1], "the summary starts on the first screen", `y ${at[0]} of ${at[1]}`);
    },
  },
```

5. Motion: in `src/style.css` delete the line `transition: border-color 0.15s ease, background 0.15s ease;` of `.file-drop`. Then `grep -n "transition:\|animation:" src/style.css src/styles/*.css` may list only: `page-in` and `fold-in` with `var(--ease)`; `pulse` animations of status dots; `transition: width …` of progress fills; declarations with `var(--transition)` (0 s) or `none`; and the reduced-motion block in `tokens.css`.

Corrections 6 to 8 come from Task 2's review. They sit in page rules the prototype keeps to its final stage, so they are done once, here, after the last merge. The counts are those of `src/style.css` after Step 1 (rehearsed); Task 2's file holds more of each, the stages delete the rest. The corrections themselves were not built on a scratch copy: if one of them brings a `clipped` or first-screen finding, fix it in that page's layout.

6. One focus ring. `src/style.css` still carries its own focus rules from 0.16.0: 14 selectors in 12 rules (16 in Task 2's file). Twelve of them draw the ring in `--accent` with an offset of 1 or 2 px: `.sb-devices > summary`, `.sb-chip`, `.sb-play` and `.sb-name`, `#section-meetings .btn-primary` and `.mt-modal .btn-primary`, `.mt-bar-title`, `.mt-view-title`, `.mt-checklist input`, `.mt-transcript`, `.mt-play`, `.mt-item` (all `:focus-visible`). One, `.mt-search:focus`, puts an accent border and a glow on top of the shared ring, so the field shows two indicators. Delete these eleven rules; keep only `.export-list button:focus-visible` (a menu item's ground, no ring). Delete with them what only fights the shared ring: the three `outline: none;` (`.speaker-chip-input`, `.mt-title-edit`, `.mt-search`) and the glow of `.mt-title-edit` (`box-shadow: 0 0 0 2px var(--accent-subtle);`; its accent border stays, it marks the title as being edited). Afterwards every control shows the one `--focus` ring of `components.css`: the tool's `focus` check stays clean, and a screenshot of the Meetings search field with the keyboard focus shows one ring.
7. Colours that bypass the tokens. `src/style.css` holds 12 colour literals (11 `rgba()`, one hex; 17 in Task 2's file), worst in Meetings. Write them with the tokens:

| Rule | Now | Becomes |
|---|---|---|
| `.mt-bar` | `background: rgba(229, 72, 77, 0.1);` `border: 1px solid rgba(229, 72, 77, 0.45);` | `background: var(--danger-bg);` `border: 1px solid var(--text-danger);` |
| `.mt-bar-dot` | `box-shadow: 0 0 6px rgba(229, 72, 77, 0.5);` | the line goes (a glow has no token; the dot pulses) |
| `.mt-hint-row[data-tone="warn"]` | `background: rgba(245, 166, 35, 0.07);` `border-color: rgba(245, 166, 35, 0.4);` | `background: var(--warn-bg);` `border-color: var(--text-warn);` |
| `.mt-badge[data-state="recording"]` | `background: rgba(229, 72, 77, 0.18);` `color: var(--red);` | `background: var(--danger-bg);` `color: var(--text-danger);` |
| `.mt-badge[data-state="interrupted"]` | `background: rgba(245, 166, 35, 0.16);` `color: var(--yellow);` | `background: var(--warn-bg);` `color: var(--text-warn);` |
| `.mt-para[data-track="you"] .mt-para-who` | `color: color-mix(in srgb, var(--accent) 55%, #fff);` | `color: var(--text-accent);` (and its comment goes: the token is the readable accent) |

   What stays are the four that have no token: the shadows of `.export-list`, `.mt-live` and `.mt-modal`, and the dialog's backdrop (`.mt-modal::backdrop`).
8. The type scale. `src/style.css` hard-codes two sizes that are not on the scale (12 / 14 / 16 / 22): 11 px three times (`.pc-check-result pre`, `.sb-note`, `.mt-badge`; six times in Task 2's file) and 13 px seven times (`.file-drop-title`, `.file-name`, `.file-text`, `.file-summary-text`, `.sb-devices > summary`, `.sb-name`, `.mt-search`; eleven times in Task 2's file). Write `font-size: var(--fs-s);` for 11 px and `font-size: var(--fs);` for 13 px.

- [ ] **Step 3: Verify**

`npx tsc --noEmit`, `npx vite build` clean; `npm run test:unit`: `tests 41`.

`node tools/ui-check/run.mjs --no-shots --task 8`: `0 findings`, four stale entries (the last four); set `tools/ui-check/allow.json` to `[]`; run again: `0 findings, 0 known, 0 new`, exit 0. (Measured on a scratch copy with every correction of this plan.) The run covers: the Soundboard probes (the panel is open only where it has its own column, the switch always shows, the first sound is on the first screen also at 900×600, the panel's state is remembered, the pop-out opens on the sounds with its settings closed); `files-loaded` and `files-result`; every pill probe.

The greps that prove corrections 6 to 8:

```bash
grep -n ":focus\|outline: none\|0 0 0 2px" src/style.css          # one line: .export-list button:focus-visible {
grep -n "rgba(\|#[0-9a-fA-F]\{3,8\}\b" src/style.css              # four lines: the shadows of .export-list, .mt-live, .mt-modal and the backdrop
grep -n "font-size: 1[13]px" src/style.css                        # nothing
```

Meetings gets no script in this task (its hotkey row moved in Task 6, its Delete in Task 7), only the style corrections 6 to 8. Look at `--pages "meetings*"` in both languages at both sizes: the new look, the structure of 0.16.0; the recording bar and the "recording" and "interrupted" badges stand on the tinted grounds of the tokens.

The three German overflows of the audit, each with its screenshot at `--lang de --size 900x600`: the Soundboard's toggle-key row (`soundboard-settings`: label "Taste für Sound-Tastenkürzel ein/aus", nothing under the key box), the history's second line (`home`: wraps, the app name is there), the rule-language selects (`settings-ai`: "Sprache wie eingestellt" whole).

`diff -ru --strip-trailing-cr $P/app/src src` shows only this plan's corrections and review fixes.

- [ ] **Step 4: Commit**

```bash
git add index.html src tools/ui-check
git commit -F - <<'EOF'
feat: Files shrinks its drop zone once a file is loaded, the Soundboard leads with the sounds and keeps its settings in a panel, page changes and folds move for 150 ms

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 9: Docs

**Files:**
- Modify: `README.md`, `README.de.md`, `CHANGELOG.md`
- Delete: `HANDOFF.md`

(The version line at the top of the READMEs changes with the release, not here.)

- [ ] **Step 1: `README.md`**

- In Features, as the first two bullets:

```markdown
- **Home:** the window opens on the dictation page: the status (it says what is missing instead of "Ready"), your hotkeys (click one to change it), the switches you change often (AI cleanup, language, Write in), what is loaded, and your recent dictations with search. Everything you set once is under Settings, in five tabs (Dictation, AI cleanup, Dictionary, Models & GPU, General), each with an Advanced fold
- **First-run setup:** a new installation shows three steps on Home: the microphone with a live level, the speech model recommended for your graphics card with a download that shows percent and size, and your dictation key; AI cleanup is offered as an optional fourth. A dictation without a model says so in the pill
```

- Replace the old places: `(Engine tab)` and `(Engine tab, off by default)` with `(Settings › Models & GPU › Advanced)` and `(Settings › Models & GPU › Advanced, off by default)` (PC check, Free GPU for games, Unload when idle, Unused models); `set it under Recording` with `set it in Settings › Dictation › Advanced`; in the Dictionary bullet `its own tab for` with `a Settings tab for`; `(Files tab)`, `(Meetings tab)`, `(Soundboard tab)` with `(Files)`, `(Meetings)`, `(Soundboard)`; any other "the Files tab's …" with "… of Files". Afterwards `grep -n -i " tab" README.md` lists only the banner line 14 (0.16.0's news), the two new bullets and the Dictionary bullet.
- In Development, before "Test data separate from your installed app", add:

````markdown
### UI check

`tools/ui-check` renders every page of the frontend in headless Chromium with a mocked backend, in English and German, at 2560×1392, 1600×900 and 900×600, with a populated and a first-run data set. It fails on sideways scrolling, clipped text, text below 4.5:1, a control without a name or out of Tab's reach, a sidebar that does not fit 900×600, a string missing in one language, and a setting that no longer saves from its control.

```powershell
cd tools\ui-check; npm install; npx playwright install chromium; cd ..\..
npm run ui-check                 # everything, with screenshots in tools\ui-check\shots
npm run ui-check -- --no-shots   # the checks only
npm run test:unit                # the pure modules (needs Node 22.18 or newer)
```
````

- [ ] **Step 2: `README.de.md`**

The same three changes in German: the two bullets (below), the places (`(Tab Engine)` → `(Einstellungen › Modelle & GPU › Erweitert)`, the Free GPU hotkey's place → `Einstellungen › Diktieren › Erweitert`, `eigener Tab für` → `ein Tab der Einstellungen für`, `(Tab Dateien)`, `(Tab Meetings)`, `(Tab Soundboard)` → `(Dateien)`, `(Meetings)`, `(Soundboard)`), and a section `### UI-Check` before "Testdaten getrennt von der installierten App" with the same commands and a German version of the paragraph.

```markdown
- **Start:** Das Fenster öffnet auf der Diktierseite: der Status (er sagt, was fehlt, statt „Bereit“), deine Tastenkürzel (ein Klick ändert eines), die Schalter, die du oft brauchst (KI-Korrektur, Sprache, Schreiben in), was geladen ist, und deine letzten Diktate mit Suche. Alles, was du einmal einstellst, liegt unter Einstellungen, in fünf Tabs (Diktieren, KI-Korrektur, Wörterbuch, Modelle & GPU, Allgemein), jeder mit einem Bereich „Erweitert“
- **Einrichtung beim ersten Start:** Eine neue Installation zeigt auf der Startseite drei Schritte: das Mikrofon mit Pegelanzeige, das für deine Grafikkarte empfohlene Sprachmodell mit einem Download, der Prozent und Größe zeigt, und deine Diktiertaste; die KI-Korrektur wird als optionaler vierter Schritt angeboten. Ein Diktat ohne Modell meldet das in der Pille
```

(Use the tab names exactly as `src/i18n.ts` has them in German after Task 6; correct the bullet if they differ.)

- [ ] **Step 3: `CHANGELOG.md`**

Under `## [Unreleased]` add:

```markdown
### Changed
- **A new window, easier to find your way in.** Five sidebar items instead of
  ten: Home, Files, Meetings, Soundboard, Settings. Home is the dictation
  page: status, hotkeys (set in place), AI cleanup, language and Write in,
  what is loaded, and recent dictations with search (History moved here).
  Settings has five tabs (Dictation, AI cleanup, Dictionary, Models & GPU,
  General); the settings most people never touch are under Advanced, and
  hints are one line with "More". No setting was removed or renamed.
- **The status says what is going on:** Setup needed (and what is missing),
  Downloading with percent, Recording, Transcribing, Meeting recording,
  Transcribing a file, Loading models, Freed for a game / GPU freed, Ready.
  "Ready" only with a loaded speech model (or the cloud engine set up) and
  a microphone.
- Calmer look: bigger type, more room, softer surfaces; readable hint text
  (4.5:1), a visible keyboard focus on every control, every control named
  for screen readers, the sidebar reachable by Tab.
- One way to delete everywhere: "Delete", then "Delete?"; nothing is
  deleted on a single click any more (history entries, words, replacements,
  rules and categories used to be).
- Files: the drop zone shrinks once a file is loaded. Soundboard: the sounds
  come first; the settings are in a panel (beside the sounds in a wide
  window, behind "Soundboard settings" in a narrow one and in the pop-out).
- The pill and the tray menu follow the Display Language.

### Added
- **First-run setup** on Home: microphone with a live level, the speech
  model recommended for your graphics card, your dictation key, optional
  AI cleanup. A dictation without a speech model shows a notice in the pill.
- Search for dictionary words and replacements.
- `tools/ui-check` and `npm run test:unit` for development.

### Fixed
- The tenth sidebar item and the version were below the window at its
  default size (900×600).
- The font is shipped with the app; nothing is requested from Google Fonts.
- German: text ran under the Soundboard's toggle-key box, the history's
  second line lost the app name, rule-language selects were cut.
```

- [ ] **Step 4: `HANDOFF.md`**

`git rm HANDOFF.md` (its first line says so; its rules live in this plan's Global Constraints).

- [ ] **Step 5: Verify and commit**

`npx tsc --noEmit`, `npx vite build`, `npm run test:unit` (41), `node tools/ui-check/run.mjs --no-shots --task 9` (0 findings, `allow.json` is `[]`). `git status --short` shows only the three docs and the deletion.

```bash
git add README.md README.de.md CHANGELOG.md
git commit -F - <<'EOF'
docs: the redesigned window in the READMEs and the changelog; the handoff note goes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

## Final checks

Run by the controller after the whole-branch review and its fix wave.

- [ ] **1. The full `ui-check`, with screenshots:** `node tools/ui-check/run.mjs` with `tools/ui-check/allow.json` equal to `[]`. Expected: exit 0, `0 findings, 0 known (allow.json), 0 new`, about 460 screenshots (both data sets, both languages, 2560×1392, 1600×900, 900×600, the pop-out at 460×680, the pill at 320×64). Allow 15 minutes. Look at Home, the first run, each Settings tab (also with Advanced open), Files with a result, Meetings open and recording, the Soundboard with its panel open and closed, the pop-out, in both languages at 1600×900 and 900×600, against the four mockups.
- [ ] **2. The unit tests and the frontend build:** `npm run test:unit` (41 pass), `npx tsc --noEmit`, `npx vite build`.
- [ ] **3a. Not yet run anywhere: the library's new tests.** On the PC where Task 3 was built, Windows Smart App Control refused to start the library's test binary (os error 4551), so `--lib meter` and `--lib the_load_state` (four tests: `the_meter_level_is_zero_for_silence_and_capped_for_loud`, `a_meter_that_is_not_running_stops_quietly`, `the_loudest_meter_level_wins_as_bits`, `the_load_state_follows_loads_and_unloads`) only compile there; the three `--bins` tests ran and pass. Run the two `--lib` commands on a PC that lets the binary start (the PC that makes the release build) before the release. The policy is not to be changed or worked around.
- [ ] **3. The Rust tests, filtered:** the five commands of Task 3 Step 3, and `<RUST-ENV> cargo test --no-default-features --bins hotkey` (see Build environment note).
- [ ] **4. Against the real app** (the spec's list). This needs a test instance, which takes the keyboard focus when it starts and writes into the installed app's `startup.log`: the controller tells the user first, starts it only when the user is not typing, with its own data folder (`RUDARIFLOW_DATA_DIR`), and stops it right after. Never the installed app or its data.
  - [ ] The sidebar in the real WebView2 window at 900×600: five items, Settings, version and credit visible (the audit's one finding that Chromium cannot settle).
  - [ ] Settings round trip: change every moved setting once (each tab, each Advanced fold, the quick switches on Home), quit, start: `config.json` holds the same keys as before and every control shows its saved value.
  - [ ] Hotkey capture from Home and from Settings › Dictation: both places show the new key at once; Esc cancels; a conflict is explained; a mouse side button works.
  - [ ] First run with an empty data folder: Home shows the steps, the level bar moves, the recommended model downloads with percent and size, the status goes from "Setup needed: no speech model" over "Downloading n %" and "Loading models…" to "Ready", Home switches to the daily view. Before the download, a press of the dictation key shows the no-model notice in the pill and records nothing.
  - [ ] The status in real use: Recording, Transcribing, a meeting's marker during a dictation, a file, Free GPU ("GPU freed"), a game (if one is at hand), idle unload followed by a change in Settings (must not rest on "Loading models…", Task 3 Step 2).
  - [ ] The pill and the tray menu after switching the Display Language (no restart).
  - [ ] The Soundboard pop-out: opens on the sounds, "Soundboard settings" opens the panel, its state survives closing and opening; the main window's remembered tab is not undone by it.
- [ ] **5. The user's try-out** on an installed build. The controller makes the GPU release build (see Build environment note; README "Production build": a fresh target folder, `CUDAARCHS=75;80;86;89;120`, `GGML_NATIVE=OFF` from `src-tauri/.cargo/config.toml`; then zero `zmm` instructions in `dumpbin /disasm` of the exe, and `git checkout -- src-tauri/Cargo.toml` if `npm run tauri build` changed only its line endings). Findings become `fix:` commits, each followed by the full `ui-check`.
- [ ] **6. Then, as a separate step:** version 0.17.0, PR, merge, GitHub release.

## Spec coverage

| Spec section / audit problem | Task |
|---|---|
| Decisions: navigation C | 3 |
| Decisions: Home layout 2 | 4 |
| Decisions: Settings 1 | 6 |
| Decisions: look B | 2 (tokens, components), every later task uses them |
| Decisions: scope (interface only) | all; `roundtrip` and `contract` in every task |
| Structure › Sidebar (logo one line, five items, status, fits 900×600, real buttons, `aria-current`) | 3 |
| Structure › Sidebar › status priority, secondary marker, "Ready" only when it is | 3 (`status.ts`, `speech_status`) |
| Structure › Home (header, hotkeys, quick switches, loaded, add word, recent, narrow order) | 4 |
| Structure › First run (steps, optional AI card, switch to the daily view) | 5 (conditions in 3: `setup.ts`; microphone meter in 3) |
| Structure › First run › pill notice without a model | 3 |
| Structure › Settings (tabs remembered, Advanced remembered per tab, More) | 3 (tabs), 6 (folds, hints, the table's grouping) |
| Structure › Settings › Dictionary tab | 6 (place), 7 (search, lists) |
| Structure › Settings › same value on Home and in Settings | 4 (`mirror.ts`, hotkey views) |
| Structure › Tool pages › Files | 8 |
| Structure › Tool pages › Meetings (unchanged; hotkey row in Settings) | 6 (the row), 7 (its delete) |
| Structure › Tool pages › Soundboard | 8 |
| Shared standard › tokens, font | 2 |
| Shared standard › components | 2, used from 3 on |
| Shared standard › delete | 7 |
| Shared standard › accessibility | 2 (focus, targets, contrast), 3 (nav), 6 (names), 7, 8 (the rest); checked by `ui-check` in every task |
| Shared standard › motion | 2 (`--ease`, reduced motion), 3 (`page-in`), 6 (`fold-in`), 8 (the audit of what is left) |
| Shared standard › languages (EN + DE, pill and tray, German overflows) | 3 (pill, tray), 4, 7, 8 (the three overflows); `i18n` and `dash` checks in every task |
| Out of scope | respected: no light theme, no new feature, no config key |
| Build order | Tasks 2 to 3 (shell and standard), 4 to 6 (Home, first run, Settings), 7 to 8 (tool pages and polish) |
| Testing › automatic | 1, then every task |
| Testing › unit tests | 3, 4, 6, 7 (frontend), 3 (Rust) |
| Testing › against the real app, the user's try-out | Final checks 4 and 5 |
| Audit 1: no first-run path, "Ready" when it is not | 3 (status, pill notice), 5 (setup) |
| Audit 2: ten flat items, the tenth unreachable | 3 |
| Audit 3: status scattered, incomplete | 3 |
| Audit 4: Engine buries model and language | 6 (Models & GPU: two rows, the rest under Advanced) |
| Audit 5: things that belong together on different tabs | 6 |
| Audit 6: hotkeys without an overview | 4 (Home), 6 (Dictation tab) |
| Audit 7: Soundboard settings before the sounds | 8 |
| Audit 8: help text too heavy, low contrast | 2 (contrast), 6 (one line with More) |
| Audit 9: lists do not scale | 4 (history search and paging), 7 (dictionary and replacement search), 8 (Files) |
| Audit 10: same job differs per tab, keyboard half-supported | 2 (focus, targets), 3 (nav), 6 (names, download state), 7 (delete, list rows) |
| Audit, smaller: German defects, Google Fonts, tray in English, em dashes | 8, 2, 3, `dash` check (new strings; the model labels with a dash go in 6) |
