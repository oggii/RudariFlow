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
- **Pure modules and unit tests:** `status.ts`, `route.ts`, `prefs.ts`, `setup.ts`, `search.ts`, `models.ts`, `arm.ts` and, since wave 1 of the whole-branch review, `size.ts` have no DOM and no Tauri import (`activity.ts` has neither and is tested the same way). Their tests are `tests/unit/<name>.test.ts`, run by Node itself: `npm run test:unit` = `node --test "tests/unit/*.test.ts"` (Node 22.18 or newer strips the types; this PC has 24.15). Therefore these seven files use erasable TypeScript only (no `enum`, no parameter properties, no `namespace`) and import each other with the `.ts` extension. `tsc` checks `src/` only; the tests are type-stripped, not type-checked.
- **Per-task verification** (from `$R`, all four must pass before the commit):

```bash
npx tsc --noEmit                         # no output
npx vite build                           # "built in …", no warning about an unresolved import
npm run test:unit                        # "fail 0"; the task says how many tests
node tools/ui-check/run.mjs --no-shots --task <N>   # N = the task's number; exit 0; the task says how many findings are known
```

  A full `--no-shots` run takes about 21 minutes since the final verification (1255 s in the pages, 20 min 57 s by the clock, 113 pages in 652 views; 1186 s and 19 min 48 s with 112 pages in 640 views after wave 2 of the whole-branch review; 18 min 16 s after wave 1). Before the whole-branch review it took about 16 and three quarter minutes (1003 s in the pages, 16 min 45 s by the clock, measured after the re-review of Task 8: 102 pages in 584 views. After its review it was 977 s and 16 min 18 s with 100 pages in 576 views; the re-review added two pages, a window of 1920 px to two more and a proof of its state to every state page, see "After the re-review of Task 8". It was 877 s and 15 minutes after Task 8 with 45 pages in 362 views; the review's first part brought that to 738 s by running what is behaviour in one view, and its 55 state pages added the rest, see "After the review of Task 8". Earlier: 606 s measured after the re-review of Task 6; 699 s after its review, 463 s before Task 6: the four Advanced pages of Task 6, the five pages and the sweep of its review and the two pages of the failed downloads make the difference, and since the re-review a probe looks at behaviour in one window size only, see "After the re-review of Task 6"). `--times` adds the seconds each page took to the output. For the reviewer add screenshots of the task's pages: `node tools/ui-check/run.mjs --no-build --pages <ids> --size 1600x900` and `--size 900x600` (files in `tools/ui-check/shots/`, not committed; a page with sizes of its own, as every state page has, is opened at those whatever `--size` says). A filtered run does not report stale `allow.json` entries; only the full run is the gate. `--task <N>` makes the run ignore every `allow.json` entry with `until` <= N: what such an entry covered counts as new, and the run says how many entries it ignored instead of listing them as stale. So where a task below says "exit 1 only because … entries match nothing any more", the run with `--task <N>` exits 0 and names them as past their task; delete them as the task says.
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

**After the review of Task 4 (Home).** What later tasks build on changed in seven places. (1) The layout's steps: `home.ts` decides `wide` (900 px) and `wider` (1600 px) on `#content.offsetWidth`, the width with the scrollbar's room in it. With `clientWidth` the 1600 px step changed in every frame at some window sizes (1800 to 1805 px wide, about 900 px high): the wider form was 40 px higher, got a scrollbar, lost 6 px, stepped back, lost the scrollbar, and so on. In `wider` the two sides keep 5fr / 6fr (it was 4fr / 3fr, which made the list narrower at 1920 px than at 1600 px) and the controls' side is two columns of cards itself (4fr / 5fr, each card as high as its rows), so the wider form is never the higher one. A probe that reads the layout must use `offsetWidth` too. (2) The list's rows have one shape for all rows, chosen by the width of the card (`.home-recent` is a query container, the `@container` rules are in `home.css`), not by how many actions a row has: below 600 px the actions stand under the text, from 600 px at the right on the level of the second line, from 840 px beside the text in two columns all rows share (`subgrid`). Delete is the row's last action and stands apart (`.history-actions > :last-child`). The second line is made of `.history-part` spans that do not break. (3) Markup: `#home-ai-retry`, `#home-output-hint`, `#history-live` are new; `#home-ai-status` is hidden and empty unless AI cleanup loads or is not available; `#history-list` is a `role="list"` of `role="listitem"` rows named after their text (`#history-text-<id>`), with `data-id`; `#history-empty` takes the focus (`tabindex="-1"`). (4) `aiSummary()` (and `HomeHost.ai()`) returns `{ name, state, tone, kind, downloaded, retry }`: `state` is the text without the Retry button, `kind` is an `AiKind` (`"ready"`, `"off"`, `"missing"`, `"loading"`, `"failed"` …), `retry` is the function behind Retry or null. `ai-settings.ts` writes its state line only through `say(text, tone, kind)`. (5) `history.ts`: `action(label, onClick, name?)` catches a failed action and says "{action} failed" on the button for 2.5 s (`history_action_failed`); `render()` gives the keyboard focus back after the rows were drawn again (the same action of the same dictation; after a Delete the first action of the row that moved up; then the search field or the empty text) and no longer stops a recording whose row is still in the list (`playing.id`, `showPlaying()`); Re-run uses `aria-disabled` and the set `rerunning`. (6) The tool: `run.mjs` knows `alsoSizes` (sizes a page adds in a run without `--size`; `home` adds 1200x800), hands a probe a second argument `run = { openWindow, scenario, lang, size }`, and `openWindow({ scrollbars: true })` opens a window in a second browser that draws its scrollbars (Playwright hides them; the layout flicker was invisible to the tool). `mock.js`: `history_delete` removes the entry. `run.mjs` and `mock.js` are the same in every stage, so no merge touches them. (7) Unit tests: 37 after Task 4's review (search 5; status has had 16 since the re-review of Task 3, so it was 36 before, not 35), and every later count is 2 higher than first written (the tasks below carry the new numbers). The merges of the next stages were rehearsed with these fixes in place (`home.ts`, `history.ts`, `mirror.ts`, `main.ts`, `ai-settings.ts`, `i18n.ts`, `styles/home.css`, `index.html`, `pages.mjs`, `mock.js`, `run.mjs`; 5 to 6, 6 to 7, 7 to final; `home.ts` also with the first run put back as Task 5 will): the review adds no conflict. Two conflicts are there from earlier work and were not written down, both in Task 6, which now names them: `home.ts` (the Speech model line, Task 4's own change; the review made the hunk one line longer) and `ai-settings.ts` (the download's progress, Task 3's review). And one thing that merges without a conflict and loses a fix: Task 7's stage builds the row's Delete with `deleteButton`, past `action()` and its catch (Task 7 Step 2, correction 2).

**After the review of Task 5 (the first run).** What later tasks build on changed in eight places. (1) The microphone's level in step 1 runs only for someone who is at the window: `home.ts` starts the backend's meter, and starts it again when it fell silent, only while the steps are on screen, the window itself has answered that it shows (`windowUp` is false until then and only ever what `windowShows()` last answered; without an answer the window does not show) and the user touched the window within the last 60 s (`pointermove`, `pointerdown`, `keydown`, `focus`). Otherwise the level rests and step 1 says so in the bar's place (`#setup-mic-hint`, `setup_mic_rest`); the next touch starts it without a click. With nobody at the window the microphone is open for at most 60 s + the backend's 120 s. A probe that expects the microphone open must have a user at the window: `present(page)` in `pages.mjs` (off again after every reload). (2) The decisions are pure functions in `setup.ts` and unit-tested: `header()` (Home's heading and its pill: beside the welcome the pill says only "Setup needed" or the download's percent, under the plain heading "Setup needed" only the reason, `home_reason_*`; the heading is one line with the pill beside it at every window size, so the steps never move with the status), `modelStep()`, `meterMay()`, `meterStep()`. (3) `HomeHost` has `microphone()` (the microphone the backend has saved; `main.ts` keeps it in `savedMicrophone`, set when a save was answered) and `setUpSpeech(id)` (`main.ts`: the dropdown's own way, now the function `chooseModel()`); the level is started for another microphone only once its save was answered. A second word for a download that runs changes nothing: `chooseModel()` returns while `downloadInFlight`, `ai-settings.ts`'s `download()` joins the download that runs, and both setup buttons rest from the click itself. (4) Markup and look: the two Download and the two Change buttons have an `aria-label`; a step's button stands at the top of its step (it does not move when the step grows); the optional card is flat (`#setup-ai`: one line where the window has the room, the buttons at the right, the card's own `var(--s2)` above and below), so the daily view with the card does not scroll at 1600×900 (measured: one line from 1173 px of window in English and from 1310 px in German, where the text stands under its title below that; 50 px high in one line, 57 in two, 98 before). While the card's own download runs it says that AI cleanup turns on at its end, and "Not now" reads "Hide". (5) The step's suggestion no longer waits for `detect_gpus` without end: after 5 s it offers the model for every PC (`setup_model_any`), and takes the answer when it comes before anything was started. (6) The backend (commit `e457ac7`, before the frontend's): a `mic_meter_start` is numbered as it arrives (`counting_meter_starts` around the command handler, `MicMeter::arrived` and `take_run`), because the body of an async command runs later on the runtime's threads and a `mic_meter_stop` sent right after it was counted first. (7) The tool: `mock.js`'s meter opens the microphone that is saved when the start arrives, says which one (`meter.device`), and closes by itself after `meter.cap` ms; `saveDelay`, `window.delay`, `window.broken`, `keep({ window, gpus })` steer what the page cannot; `ai_download_model` refuses a second download as the backend does. `mock.js` and `run.mjs` are still the same in every stage. (8) Unit tests: 47 after Task 5's review (setup 18), so every later count is 10 higher than written before (the tasks below carry the new numbers). The merges of the next stages were rehearsed with these fixes in place (`home.ts`, `main.ts`, `ai-settings.ts`, `i18n.ts`, `index.html`, `pages.mjs`; 5 to 6, 6 to 7, 7 to final, each with its resolutions applied): the review adds no conflict of its own, but Task 5's commit had added four that were not written down (`home.ts`: the imports and the steps in `renderSetup()`; `main.ts`: the imports and `downloadCurrentModel()`), and `home.ts`'s `modelNamed` reads a function stage 6 deletes. Task 6 now names all six conflicts and the one rewrite; with them its result type-checks, and the final stage passes its 53 unit tests.

**After the re-review of Task 5.** What later tasks build on changed in six places. (1) A touch of the window is `pointermove` (only while the window has the focus: a pointer that crosses a window left open beside other work opens no microphone), `pointerdown`, `keydown`, `click` (all that a screen reader in browse mode or voice control sends) and `focus`. A probe's own click on a sidebar item is a touch too: `again()` in `pages.mjs` presses nothing where the window starts on Home, and a probe that wants a window nobody has touched must not call `section()` after the reload. (2) The minute since the last touch is measured on two clocks: `idleFor(running, wall)` in `setup.ts` takes what `performance.now()` and `Date.now()` say has passed and gives the longer answer, so neither a PC that slept nor a clock that was set back stretches it. (3) `meter()` in `home.ts` sends `mic_meter_stop` once more in two cases, because calls sent in one go can arrive swapped: an overtaken start opened the microphone although the page's last word is "stop", or the latest start is answered "stopped" (an older start may hold the microphone open). A restart for another microphone goes through `meterMay` like every start. (4) The optional card has one height in every state at every window width (measured every 20 px from 900 to 2600 px of window, in both languages, at the head of the daily view and under the steps: resting, downloading and failed are the same to the tenth of a pixel, and the daily view under it does not move). `#setup-ai-line` (new, with `.setup-ai-live` in it around `#setup-ai-text` and `#setup-ai-progress`) keeps the room of the text the card rests on (`data-rest`, laid under the line unseen), the download's bar stands on the text's row, and both buttons are as wide as their widest words (`data-alt`, `data-alt2`). For that the texts the card shows meanwhile are shorter than the resting one: `setup_ai_coming` no longer names the model ("AI cleanup turns on when it is done."), the card's failure is `setup_ai_failed` (new; without the advice of `setup_download_failed`, which step 2 keeps), a download started in Settings shows `setup_ai_fetching`, and the German `setup_downloading` reads "Lädt herunter…" (it was "Wird heruntergeladen…": 182 px of button, which left the German text no room on one row at 1200 px). The card is one line from 1200 px of window in English and from 1322 px in German; below that the text stands under its title, on one row from 1168 px in German. (5) The tool: `mock.js`'s meter can deliver a start after the call that was sent behind it (`meter.swap = "stop"` or `"start"`, with `meter.delays` and `meter.opens`); `pages.mjs` waits for a new start of the page by what the page shows (`started()`, `restart()`) instead of `networkidle` plus 500 ms; and the probe of the minute runs in a window of its own on Playwright's clock (`restsAlone()`, `page.clock.install()` before the load), which fakes both of the page's clocks (the probe checks that). A full `--no-shots` run takes about 8 minutes (463 s) instead of 11 (636 s). `mock.js` is the same in stages 5 and 6, so the merge does not touch it; `run.mjs` is unchanged. (6) Unit tests: 48 after the re-review (setup 19), so every later count is 1 higher than written before (the tasks below carry the new numbers). The merge of stage 5 to 6 was rehearsed again for the files the re-review touched (`home.ts`, `main.ts`, `i18n.ts`, `index.html`, `pages.mjs`): the same six conflicts with the same sides, except that our import line of `./setup.ts` in `home.ts` now also names `idleFor` and `meterMay` (Task 6 carries the line); `index.html`, `pages.mjs` and `i18n.ts` still merge cleanly.

**After the review of Task 6 (Settings).** What later tasks build on changed in ten places. (1) A model's download shows on the model's own row. `#ai-download-progress` moved from the main card of AI cleanup into the Advanced fold, under the AI model's row (its track is `#ai-progress-bar`, new); beside the switch the state line keeps the percent, in an element of its own after it (`#ai-status-percent`, new). Both bars are `role="progressbar"`, named after their row's label (`#model-label`, `#ai-model-label`, new ids), with `aria-valuenow` and `aria-valuetext` ("43 %, 201 MB of 466 MB", `progress_said`); neither number line (`#download-numbers`, `#ai-progress-text`) is a live region any more. Of a download only its start and its end are read out, by one polite line each: the speech model's by `#download-live` (new, `sr-only`: `download_started`, then `download_done` or the failure), the AI model's by its state line `#ai-status-line`, which `say()` writes only when it changes. `src/progress.ts` (new: `showProgress(parts, p)`, `NOT_STARTED`, the type `DownloadProgress`) draws every bar, Home's too; the words are `progressWords()` in `setup.ts` (pure, tested). (2) A download that did not finish is a state its row keeps: `downloadFailed` (the model's id) in `main.ts` and in `ai-settings.ts`, until another model is chosen or a download works. The note under the model (`#model-note`, `#ai-model-note`) then says `setup_download_failed` with the model and its size, in the colour of an error. The speech dropdown is back on the saved model by then (a model is saved only once it is there), so "Retry" stands in the note as a `.link-btn` (it sets the dropdown and calls `chooseModel()`); where the dropdown is still on the model that failed (the first run's Download button, the AI model) the Download button reads "Retry" (`renderDownloadButton()` in `main.ts`; both AI buttons in `renderStatus()`), and the AI's state line beside the switch says the failure too (kind `"missing"`, tone `"error"`), so Home says it under its switch. `aiSummary()` and `HomeHost.ai()` have `failed`, and Home's optional card shows its failure for it. `downloadCurrentModel()` starts clean (the note, the button's words, the bar and its numbers at "0 %") and puts the keyboard focus on the dropdown when the control that had it rested or went. (3) The width. `shell.ts` exports `WIDE` (900), `WIDER` (1600) and `roomBeside()` (`#content.offsetWidth`, with the reason for it); `home.ts` decides its two steps on them, and `initShell()` gives `#section-settings` the class `wider` from 1600 px. In that form (`styles/settings.css`, "A large window: two columns") the section has no `max-width` and a `.tab-panel` is two columns of at most 900 px on the page's left edge: Dictation and Models & GPU the main card and the fold, General its two cards (a grid that places them itself), AI cleanup the main card left over both rows, "Rules per app" right and the fold under the rules (`grid-template-rows: auto auto 1fr`, so the main card's height never pushes the fold away from the rules; until the re-review the fold stood left under the main card, and Tab went left, right, left), Dictionary the suggestions and the words left, the replacements, Swiss spelling and the fold right. The Dictionary's columns are columns of text flow (`columns: 2`, `break-before: column` on the replacements' card): two stacks of several cards cannot share the rows of a grid without a hole under the shorter card. No wrapper was added and nothing is moved in the page, so the Tab order is the single column's (AI cleanup: main card, rules, fold), and since the re-review it changes column once on every tab. A fold's `summary` is a bar on a card's ground there, as wide as its column and on the top edge of the card beside it. Below 1600 px nothing of this applies: one column of at most 1080 px. Columns: 768 px at 1800 px of window, 828 px at 1920 px, 900 px at 2560 px (where 496 px stay free at the right; it was 1232 px). (4) Key boxes share a right edge in Settings: `renderHotkeys()` gives a × the class `unset` (`visibility: hidden`) instead of `hidden`, and `#hotkey-btn` (Dictate has no ×) has the same 32 px as a margin. Home's keys had one edge already; the Soundboard's rows are its own. (5) `reveal(id)` opens a closed fold for the visit only: `visited` in `shell.ts`. Nothing is saved, and when the user goes to another place the fold is as it is remembered again; a fold the user toggles is saved as before. (6) Names. `nameRows()` gives every "More" an `aria-label` from `hint_more_about` / `hint_less_about` and its row's label or its card's heading ("More about PC check"), and `initHints()` keeps it right when it opens; `.hint-more[data-own]` is left to the Soundboard (Task 8, correction 9). The three Download buttons are named `setup_model_get` / `setup_model_retry` and `setup_ai_get` / `setup_ai_retry`. (7) Models & GPU. With the cloud engine and no key `#engine-cloud-note` has `data-tone="warn"`, says `cloud_note_no_key` (in `#engine-cloud-text`, new) and shows `#engine-cloud-key` (new, `cloud_note_open`), which calls `reveal("groq-key")`; `renderCloudNote()` in `main.ts` follows the engine, the key field as it is typed in and the language. `saveSettings()` stores `modelToSave(dropdown, lastSavedModel, downloadInFlight)` (`models.ts`, pure, tested): a save while a model downloads keeps the saved model (since the re-review the third argument is `dropdown !== verifiedModel`, see there). The detected graphics cards are kept (`detectedGpus`) and drawn again after a language change (`renderDetectedGpus()`). (8) Strings. Changed: `paste_last_hint`, `volume_hint`, `screen_context_hint` and `learn_hint` (each now says in its one line what stays on the PC; their `*_more` texts say the rest), German `send_command_hint`, `ui_language_hint`, `ai_status_not_downloaded` and `dictate_hint` (shorter: one line in a 768 px column), and the nine notes under the two model dropdowns (a full stop). Gone: `microphone_hint` and `meeting_hotkey_hint` (they repeated their labels; a row without a hint stands at the middle of its control, `.tab-panel .setting-row:not(:has(.label-hint))`) and `ai_download_failed`. New: `progress_said`, `download_started`, `download_done`, `home_output_warn`, `hint_more_about`, `hint_less_about`, `cloud_note_no_key`, `cloud_note_open`. `mirrorHint(sources, copy, here)` lets Home word a mirrored note for its own place: the Write in warning points to the Language row above it there (`home_output_warn`), to Models & GPU in Settings. (9) The tool. Five pages after the Advanced pages of `pages.mjs`: `settings-columns` (every tab with its fold closed and open in one column and in two, also at 1920x1080; once per run `settingsHold` sweeps the step in a window with its scrollbar drawn, as `layoutHolds` does for Home, and also expects the form to follow the width alone), `settings-keys` (the key boxes' edges, the names of "Download" and "More"), `settings-models-cloud`, `settings-models-download` (both data sets) and `settings-ai-download`; the helpers stand before `const pill` (`choose`, `asked`, `report`, `noteLive`, `liveNoted`, `downloadNow`, `COLUMNS`). `mock.js` and `run.mjs` are unchanged. (10) Unit tests: 52 after the review (models 3, setup 20), so every later count is 2 higher than written before (the tasks below carry the new numbers). The merges of the next stages were rehearsed on a scratch copy with these fixes in place (6 to 7 and 7 to final, for `index.html`, `main.ts`, `ai-settings.ts`, `i18n.ts`, `rows.ts`, `styles/settings.css`, `pages.mjs`): the conflicts Tasks 7 and 8 name (`style.css` once each, `overlay.html`) and no other, and the result type-checks but for the `rememberPrefs` that Task 8's correction 1 replaces. Four things keep it that way, should a later fix touch the same files: the new rules of `settings.css` stand in the middle of the file, before `/* A hint or a notice that stands in a card by itself */`, not at its end, where stage 7 appends its own; the new imports of `main.ts` and `ai-settings.ts` are lines of their own away from the ones stage 7 adds, and the lines `import { modelLabel, speechModel } from "./models.ts";` (`main.ts`) and `import { sizeText } from "./setup.ts";` (`ai-settings.ts`) are as the stages have them; the new keys of `i18n.ts` are not at the end of a table, where stages 7 and 8 add theirs; and the new pages and helpers of `pages.mjs` stand where no stage inserts (not between `const pill` and `export const PAGES`, not on the line of the plain tabs).

**After the re-review of Task 6.** What later tasks build on changed in eight places. (1) Only a speech model that is on disk is saved. `main.ts` keeps `verifiedModel`, the model last known to be there: the saved one at the start (`loadSettings()`), the one `check_model_downloaded` found, the one a download brought, and the previous saved one when the dropdown goes back after a failed download. `saveSettings()` stores `modelToSave(dropdown, lastSavedModel, dropdown !== verifiedModel)`. The third argument was `downloadInFlight`, which left two moments open: after a failed download, while the rows' ticks are asked for and the dropdown is not back yet, and the save of an earlier choice that finds the dropdown already on the next, missing model. `chooseModel()` takes the dropdown's model at its start: it vouches only for that one, starts no download when the dropdown has moved on (the newer choice has a call of its own), and puts the dropdown back only while it is still on the model that failed. (2) A failed download says the backend's reason after its sentence ("… Reason: There is not enough space on the disk. (os error 112)"; the sentence alone advises to check the connection, also for a full disk): `downloadFailure(model, reason)` in `progress.ts`, whose words are `failureWords()` in `setup.ts` (pure, tested), key `download_reason`. It stands on the speech model's note and in `#download-live`, on the AI model's note and its state line, and through those in Home's step 2 (`HomeHost.speechFailure()`, new) and under Home's AI switch. Home's optional card keeps its short sentence without the reason: the card has one height. A failed download has one colour, the error's, also in Home's step and on its card (`data-tone="error"`, it was `"warn"`). (3) Under Home's AI switch `#home-ai-retry` also retries a failed download (`aiSummary().retry`; the sentence there says "try again", and Home has no Download button), named `setup_ai_retry`. While that download runs the button rests where it is (`aria-disabled`: it has the keyboard focus), and when it goes at the end the focus moves to `#home-ai-toggle`. (4) `#download-live` is emptied with the next choice and with a change of the Display Language (`forgetDownload()` in `main.ts`): the line is not on screen, but a screen reader that reads the page still found the old failure there, in the old language. A probe that counts what a live region said counts the texts that are not empty (`spoken()`). A change of the Display Language while the dropdown's download runs no longer brings a Download button, and `loadSettings()` sets the key field before `setEngine()` (with the cloud engine and a key the notice warned for a moment at every start). (5) The two columns of AI cleanup: the main card left over both rows, "Rules per app" right, the fold under the rules (`grid-area` only, nothing is moved in the page), so Tab changes column once on every tab and the common rows come before Advanced. The AI's state line and the percent after it are boxes of their label (`.setting-label:has(> #ai-status-line)` is a flex row that wraps), not text in a line of it: the row is as high as its neighbours (62.7 px; it was 3 px more). (6) Strings: `screen_context_hint` says what the feature is for, with what stays on the PC, and `screen_context_more` no longer repeats it; English `learn_more` ("at the top of this tab"); German `send_command_hint` ("Sag am Schluss „Abschicken.“: Nach dem Einfügen folgt Enter."; at 900×600 the hint and "Mehr" share a line, and so does "Weniger": with "… wird Enter gedrückt." "Mehr" fits by 4 px and "Weniger" wraps, which the check "More opens the long text without moving its row's control" reports); new `download_reason`. (7) The tool. Behaviour is looked at once: what `speechDownload`, `aiDownload`, `cloudKey`, `controlNames` (page `settings-keys`) and the new start in `settings-models-advanced` find out does not depend on the window's size and runs only in the 1600x900 window (`BEHAVIOUR` in `pages.mjs`). What does depend on it (the bar on its row and in view, the key field coming into view, the key boxes' edges, "More" in place) runs at every size, as do the page's own checks and its pictures. `settingsHold` runs once per run (populated, English) at 1599 and 1600 px. `settings()` presses the sidebar only from another page, and the Advanced pages open their fold before the tab, with one wait. Two pages after `settings-ai-download`, whose `open` ends in the failure, so that state is measured and in the pictures (a page is measured before its probe, and the probes end on a download that runs or on one that worked): `settings-models-failed` (both data sets: Retry in the note, or on the button) and `settings-ai-failed` (the long reason of a full disk). `speechDownload` pins the two saves of (1) with the mocked backend's answers 150 ms late (`answerDelay` in `mock.js`, `slowAnswers()`): with `verifiedModel` taken out of the save, both fail (three findings). `columns` also expects that Tab changes column once, and measures AI cleanup with ten rules too (`COLUMNS.ai` has the fold in column 1; a new PC has no rule, the populated one three). `run.mjs` has `--times`. `mock.js` and `run.mjs` are still the same in every stage, so no merge touches them. (8) Unit tests: 53 after the re-review (setup 21: a failed download's words), so every later count is 1 higher than written before (the tasks below carry the new numbers). The merges of the next stages were rehearsed on a scratch copy with these fixes in place (6 to 7 and 7 to final, for the whole of `src`, `index.html` and `pages.mjs`): the conflicts Tasks 7 and 8 name (`style.css` once each, `overlay.html`) and no other, and the result type-checks but for the `rememberPrefs` that Task 8's correction 1 replaces. The four things that keep it that way are in "After the review of Task 6".

**After the review of Task 7 (the one way to delete).** What later tasks build on changed in nine places. (1) The rule keeps the time. `arm(state, event)` in `arm.ts` takes `ArmState { armed, last, run }` (`AT_REST` at the start) and a click with `at` (its time), `count` (the browser's count of a multi-click, 0 for the keyboard) and `held` (the click of a key that is held down); a step is a state with `fire`. The 300 ms guard counts from the last click on the armed button, not from the one that armed it: every click that comes too early starts it anew, so only a click after a pause deletes and no burst of any length does (before, clicks at 19, 269 and 335 ms deleted). A held Enter is no longer swallowed in `confirm-delete.ts`: its clicks reach the rule as `held` and change nothing but the guard, also on the next row's button after a delete handed the focus on. (2) An armed button that is scrolled out of view disarms (a capturing, passive `scroll` listener on the document; `inView()` clips the button with every box around it that cuts off what it holds, and with the window). A button that is armed from the keyboard while it is out of view is scrolled into view first, so "Delete?" is seen before it is answered. (3) `confirm-delete.ts` keeps nothing of a button that is gone: the delete and the `after` target travel with the click (`fired.after`), the maps `actions` and `afters` are gone, and `forgetDelete(id)` only ends a failure that still shows and disarms. (4) A failed delete looks the same everywhere: its button reads "Delete failed" and is named "Delete failed: <what>" for 2.5 s. The four deletes that say the reason in a live region of their own page (an unused model's row, the meeting's notice, the board's notice for a sound and a category) set that notice and throw `FailureSaid`: the button shows the failure, `#delete-live` stays silent, so one of the two lines speaks. (5) The line that is read out is worded from what it is about (`saying`, `words()`), again whenever its button is painted: after a change of the Display Language it is in the new language. `DeleteOptions.armedSaid` is the i18n key of what is read out when the button's word is not "Delete" (Files: `files_clear_said`, "Press again to clear. Esc cancels."), and `#mt-delete` is named after the open meeting (`nameDelete` in `renderView()`: "Delete: Weekly sync", armed "Delete? Weekly sync"). (6) `loadSettings()` in `main.ts` calls `repaintDeletes()` right after `setLang()`: "Delete history" and Files' "Clear" are given their words when their pages are wired, before the language is known, and stood in English in a German window until something was armed. `#mt-delete` is wired after the settings, the board draws again after them, and the pop-out sets the language before it mounts its board. Swept for the same mistake with the tool's build and mocked backend: in a German window at its start, on Home, Files (also with a result), Meetings (also with a meeting open), the Soundboard (also with its devices and a category's Delete), all five Settings tabs with every fold open and the pop-out, in both data sets, no text, `aria-label`, `title` or `placeholder` in the document, shown or hidden, equals an English string of `i18n.ts` whose German differs (452 strings, 68 patterns for the ones with a placeholder); with the `repaintDeletes()` taken out the same sweep names exactly the two buttons. (7) Dictionary. `addWords()` ends the word search after an add that added something (the search would hide the new word at once), `#replacement-add` ends the replacements' search. The words are columns of text flow (`#dict-list`: `columns: 220px`, a row has `break-inside: avoid`), so they read downwards in the alphabet's order, which is the page's and Tab's; the list has `padding-bottom: var(--s3)` while it holds a word, so the lines under the last words stand 20 px above the card's edge (it was 8). Measured with 12, 100 and 600 words at 900, 1600 and 1920 px of window: 2, 4 and 3 columns (the 1920 px window is the two page columns), no word split, nothing wider than its card. `.rule-language` has a basis of 260 px (its longest option, "Aserbaidschanisch (Azərbaycan)", needs 251 px with the arrow). (8) The tool. `deleteRule` also clicks three times 160 ms apart (the third later than the guard after the first), holds Enter with a repeat that starts later than the guard, and expects a failure on the button of every delete; a spec with `reason` says its page tells the reason itself (then `#delete-live` must stay silent), one with `said` what is read out when armed. `everyDelete` starts with the words of every delete button in a window where nothing was armed yet, and changes the Display Language while "Delete history" is armed; `scrolledAway` (new, after a new start, with 68 dictations) scrolls an armed button out of view; `popoutDeletes` looks at the pop-out's buttons at its start; `dictionaryProbe` adds a word and a replacement while their searches are on and measures the words' flow. `mock.js` and `run.mjs` are unchanged. (9) Unit tests: 62 after the review (arm 9), so Task 8 and the final checks carry that number. The merge of stage 7 to the final one was rehearsed on a scratch copy with these fixes in place (the whole of `src`, `index.html` and `pages.mjs`): the two conflicts Task 8 names (`style.css` at `.sb-layout`, `overlay.html`) and no other, and the result type-checks but for the `rememberPrefs` of Task 8's correction 1. What keeps it that way, and what Task 8 must keep of the board, is in Task 8 Step 1.

**After the review of Task 8 (the tool pages, and the states nobody had opened).** The review found two defects the gate had passed, because no page opened their state: while a sound's key box asked for its key, the volume of that sound lay on the tile beside it (the tile's second line was a grid with a `max-content` column), and in the wide panel a key box that listened covered its own label and hint. Its fix round has two commits, the fixes and then the states as pages of the tool with what those showed. What Task 9 and the final checks build on changed in eleven places. (1) A sound tile's second line wraps (`.sb-controls` is a flex row: the category 140 px, the key box at least 140 px, the volume takes the rest and ends at the tile's right edge like the first line). What does not fit goes to a line of its own inside the tile. Measured at tiles of 420 (the pop-out), 450, 461, 652 and 844 px, resting, listening, refused, with "Taken by another program", with combinations of three and four keys and with a missing file, in both languages: nothing leaves a tile, and at rest the controls of all tiles stand under each other. The tiles of a row share its height (`.sb-row`: the first line at its top, the second at its bottom), so a tile that says "File missing" is no higher than its neighbour. A key box of the board is a flex row that may shrink (`.sb-hotkey`), the panel's two key rows are stacked in every layout (`keyRow()` in `board.ts`, `.setting-row.stack`), and the fields that rename in place (a sound's name, a category's chip) have the size of what they replace: as text fields by their type they had taken a form field's 34 px and its line. (2) The bar. The switch's label is built like every setting's (`labelWithMore()`): `sb_switch_hint` is its one line, `sb_switch_more` (new) the rest behind "More", then the status. The panel has no lead of its own. `aria-controls` is set only while the panel is in the page. Without a virtual cable the box outside the panel also says how to choose the cable in Discord, whether "Got it" was pressed or not, as in 0.16.0. (3) `--measure` (`tokens.css`, 42em: 90 to 100 characters a line) is the widest a paragraph of running text gets; a frame may be wider. It holds for running text: a meeting's transcript (`.mt-para-text`) and notes, a file's transcript and summary, Home's dictations in the wide list, what "Try it" answers and the Soundboard's hint boxes; `.panel-lead` is 72ch again. (The review had also put it on hints, on empty states and inside two text boxes, and on every dictation; the re-review took it from those and wrote the rule down, see the next paragraph.) Swept at 1200, 1600, 1920 and 2560 px in both data sets and languages over every page and tab: the longest line is 103 characters (it was 265 in a meeting at 1920 px, 289 at 2560 px). A one-line hint is one line by its own rule and stays (the longest, German, has 103 characters since `screen_context_hint` lost a word). Home's daily view was up to 41 px higher for it at 1536 and 1600 px with the reference data; since the re-review a dictation keeps the measure only in the wide list, and the view has its height of before. (4) `#content` is `position: relative`. What is read out and not shown (`.sr-only`) stood against the window, so a line far down a long page (Home with "Show all") made the window's own document higher than the window (3952 px of 864), and bringing that line into view moved title bar and sidebar out of the window. The deletes' probe "the line that is read out does not make the page higher than the window" had passed only because Home happened to fit at 1600×900. (5) The pill. Its two fades are `var(--ease)` (a `--ease` of its own in `overlay.html`'s style, which the tool compares with the token's), the cancel button has no hover transition and is 24 px, its type is on the scale (12 px for the edit chip and the label of what the AI does), the bars give way to the edit chip at their left end (the 32 bars cannot shrink: with the chip beside them they pushed the cancel button out of the pill and out of the 320 px window, in 0.16.0 too), and its text is one line (a flex box had cut it at both ends; the review made it a centred line that ended in an ellipsis, the re-review a line that shows the end of what was said, see the next paragraph). The bars, the shimmer and the pulse while polishing stay. (6) Strings: `sb_switch_hint` shortened, `sb_switch_more` new, the four `mt_warn_*` rebuilt without their dash ("Microphone lost: retrying"), German `screen_context_hint` one word shorter. `files.ts` names the field that renames a speaker (`mt_rename_speaker`), `meetings.ts` is untouched. (7) Smaller ones: a meeting's row has no edge (the card surface, like a sound's tile); with a file loaded the Files drop zone is its one line in a large window too, beside the options and as high as they are; the pop-out's three Devices dropdowns are one width; `.sb-name` and the Devices summary have round focus rings; a sound's name is at least 24 px wide. (8) The tool's static rules (`static.mjs`, `styleChecks()`). Every `.css` under `src/` and the pill's `<style>` are read, by declaration (`declarations()`: several lines, no `;` needed, comments and strings are no code), so a new style sheet is checked from its first line; what a rule does not apply to stands in `EXEMPT` (a file) or `PASSES` (one declaration) with its reason, and an entry that matches nothing is a finding. The colour rule sees every declaration and named colours, the size rule the `font` shorthand and every unit. New: `motion` as a static rule, the plan's grep of correction 5. Every `transition` and `animation` is `none`, `var(--transition)`, `var(--ease)` on a place of `MOVES` (a page that comes, a fold that opens, the pill's two fades) or a state that shows itself and is named in `SHOWS_STATE`; the in-page check reads computed styles and never saw a transition written for `:hover`, `.dragging` or `[open]`. (9) The tool's run. `after` runs in a `finally` (a probe that threw left the panel toggled for the pages after it). `walk: false` leaves the keyboard walk out for a state its first step would end (a field that renames, an open menu, a key box that listens); such a page's probe asks for the focus ring itself (`ring()`, `menuItems()`). A page with sizes of its own walks at 1600x900 when it is opened there, else at its sizes. In the page (`inpage.js`): what stands in a drawn box stays in it (`BOXES`: a card, a sound's tile, a bar, a notice, the pill; check `overflow`, "… leaves …"), which is what sees a control on the neighbouring tile; the motion check knows the pill's states. The pill's pages are measured now (they were pictures only: the pill has none of the window's tokens, its ground is the desktop, and it never has the keyboard focus): overflow, cut text, names, 24 px, contrast on the stand-in grey, motion; not the walk. (10) Behaviour in one view: Home's probes (`firstRun` and the daily view go through the states for their layout in every view and do the rest once, 121 s instead of 230 s for the 16 views), the shell's, the Dictionary tab's and the panel's keyboard and reload (`soundboard-settings`). No check was dropped. (11) The state pages: 55 pages after the plain ones, `state()` in `pages.mjs` (the data of a PC in daily use, 900x600 and 1600x900, both languages, each in a window started anew by `restart`). Soundboard (13): `soundboard-states` (a taken key on a tile and on both keys of the panel, combinations of three and four keys, a missing file, a sound that plays and loops, the notice line), `-tile-capture`, `-tile-refused`, `-panel-capture`, `-panel-refused`, `-error`, `-no-cable`, `-popped`, `-rename`, `-no-match`, `-drag`, `-keys-off`, `-many` (24 sounds in 5 categories). Meetings (11): `meetings-quit`, `-warnings` (the library while a meeting records, with the four warnings, the paused line, the reminder and a finishing line), `-interrupted`, `-no-notes`, `-live-long` (no walk: Tab through the transcript's play buttons ends at its end, which is "live" again, and whether the button was gone before Tab came to it differed from run to run), `-title-edit`, `-speaker-edit`, `-export`, `-start-error`, `-no-match`, `-many` (12 meetings, also at 1920x1080). Files (11): `files-running`, `-model-download`, `-failed`, `-busy`, `-cancelled`, `-summary-running`, `-summary-failed`, `-summary-hidden`, `-export`, `-times-rename`, `-drag`. Settings and Home (14): `settings-pc-check-running`, `-pc-check-report` (with the line of Free GPU for games), `settings-ai-test`, `-ai-test-plain`, `-ai-test-error`, `settings-keys-capture`, `-keys-refused`, `home-keys-capture`, `-keys-refused` (both also at 1800x1000, where Home's card is narrowest), `home-setup-key-capture`, `-refused` (a new PC's data), `settings-dictionary-long`, `settings-ai-warnings`, `home-output-warn`. The pop-out (2): `popout-states`, `popout-capture`. The pill (4): `pill-edit`, `-polishing`, `-editing`, `-notices` (each of its 21 notices in the Display Language fits in two lines). One key box listens at a time, so a capture page shows one; its probe brings every key box of its place into both states and runs the layout checks again (`keyBoxes()`). A refused key stays on its box for 2.5 s, which `holdRefusal` holds for the picture. `mock.js` got what these need, each as the backend has it (read in `main.rs`, `meeting/mod.rs`, `soundboard/`): the hotkey commands refuse a Windows shortcut and a key another hotkey has, in the backend's words; `refuseNext` and `holdNext` make a command fail once or wait (a file's run, a summary, the PC check); `sb`, `board`, `manySounds`, `meetings`, `addMeetings`, `meetingLines`, `speakerModel`, `savePath`, `aiFallback`; a fourth meeting without notes and speakers in the library. What the new pages found is fixed in the app and in the second commit: the pill's cancel button outside the pill and the window in Edit mode (with 0.16.0's styles it stands at x 312 to 334 of the 320 px window beside "12 words") and its 22 px, a rename field without a name in Files, a sound's name of three letters under 24 px. Found by looking at the pictures: the rename fields that made a tile and the chips' bar higher, the pill's text cut at both ends, the dashes in the warnings. Mutation: with the old CSS of the tile's second line put back, `soundboard-tile-capture`, `soundboard-states` and `popout-capture` fail (81 findings: "input[s1-volume] leaves div.sb-row", "nothing leaves its sound tile"), `soundboard` and `popout` stay clean as they did before. `allow.json` is `[]`. Unit tests: 62, unchanged.

**After the re-review of Task 8 (the end of what was said, the measure's rule, state pages that prove their state).** The re-review found the pill's text frozen at its beginning, the measure in places where it left a field or a frame half empty, and 23 of the 55 state pages passing with an `open` that never reached its state. Its fix round is one commit. What Task 9 and the final checks build on changed in eight places. (1) The pill shows the end of what was said. While Whisper transcribes, the text grows by a segment at a time (`whisper_engine.rs`, the segment callback), and the one line with its ellipsis showed the first 45 characters and then never changed again. The text is a `span` in a line of its own (`#transcript > .transcript-line > #transcript-text`, `src/overlay.html`). The line is a flex row that ends at its right edge (`justify-content: flex-end`, `overflow: hidden`) with the text as its one item (`margin: 0 auto`): a text that fits stands in the middle, a longer one keeps its end in view and loses its beginning, which fades out over the line's own 16 px of left padding (`mask-image`; a text that fits never stands there). While the AI polishes or edits, the line is a block: the label, the text from its start, an ellipsis, as before. Edit mode's bars: the row runs from right to left and wraps, and only its first row shows, so a bar that does not fit beside the chip goes whole and none is cut to a sliver (the newest bar is the first in the markup, `waveform.prepend`; hiding a fixed number of bars would cut again at a chip of another width). (2) One rule for `--measure`, written at the token in `tokens.css` with the list of its places. Running text is what is read line after line, three lines or more at the measure: a meeting's transcript and notes, a file's summary and transcript, a dictation in Home's wide list, what "Try it" answers, the Soundboard's instructions (and `.panel-lead` and `.hint-long` at 72ch). It keeps the measure. A hint is a sentence or two of the app's own: a card's own hint (`.card > .label-hint`, the one of "Unused models"), an empty state, a meeting's hint rows, warnings and reminder. It has the width of its row or card and is one line where the room is there. A field is never narrowed from the inside: "Try it" (field, buttons, result) and a rule's fields are at most 720 px wide (`.ai-test`, `.rule-fields`, `settings.css`) and use all of it, and a rule's Delete stands after its fields. Home's dictations keep the measure only in the wide list (`@container (min-width: 840px)`, `home.css`), where it holds at 2560 px and does nothing at 1920 px: at 1600×900 in German the daily view is 25 px over the window again (66 with the cap), at 1536×864 75. (3) Frames that end near their text. Files in the `wider` form (`style.css`, `#section-files.wider`): the file's line and the result are as wide as the transcript's field, which is as wide as its text (`--file-frame`: the measure, the field's padding and edge and the room of its scrollbar, 634 px; no padding inside the field stands in for a wider frame). With a summary the summary stands beside the transcript as a meeting's notes do: at the left (`--file-side`, 340 to 460 px) with Hide and Copy over its own text, the transcript at the right under its toolbar, a grid on `.file-result` chosen with `:has(> .file-summary:not(.hidden))`. Nothing is moved in the page, so Tab goes toolbar, speakers, summary, transcript. Below `wider` Files is as it was, as the re-review asked: at 1600 px the field is still 1352 px wide with lines of 588 px. An open meeting without notes is 840 px wide in every window (`.mt-open:not(.mt-has-notes) .mt-layout`), the width a transcript has beside notes: the head's buttons end with the frame, and a hint row has the line for its sentence. A meeting with notes is unchanged. (4) Soundboard. The switch and its text ask for 420 px of the bar (`.sb-bar-mic`), so in the smallest window the three buttons stand under the switch in both languages (English kept them beside a text column of 220 px). A sound's tile is three lines that the tiles of a row share (`.sb-row` takes three rows of the list and passes them on, `grid-template-rows: subgrid`): the first line, the controls, and the note of a key another program has. That note is the tile's own element now (`soundRow` in `board.ts`; the key box names it with `aria-describedby`) and starts under the key box, so category, key and volume stay on one line, and the controls of a row's tiles stand on one level. The space between two rows of tiles is each tile's margin: a gap of the list would stand between a tile's lines too. The price of shared lines: beside a tile that says "File missing" a tile with a wrapped second line is about 20 px higher than its own content. A combination of three keys still puts the volume on a line of its own in tiles of 450 px or less. (5) `src-tauri/src/meeting/capture.rs` quotes the four warnings as they read now (comments only). (6) The tool: a state page proves its state. A page has `shows` (`onScreen`, `keyBoxShows`, `pillShows`, `pillPolishes`, `triedIt` in `pages.mjs`): what the state looks like, asked by `run.mjs` right after `open` and before anything is measured (the dialog is open and modal, the status line is red and says the backend's words, the key box is in its accent form with the prompt or with a reason, the menu is open, the field has the focus). `state: true` marks a state page, and `run.mjs` does not start (exit 2) while one has no `shows`. All 55 have one, and so have the pill's other pages. Proven for five by taking the state out of their `open` in a copy of `pages.mjs` (`meetings-quit`, `soundboard-error`, `files-summary-running`, `soundboard-tile-refused`, `pill-polishing`): each fails with "the page shows its state: …" and what it found instead. (7) The tool: two pages and one check more, 102 pages. `pill-segments`: a short text stands whole in the middle; then a dictation of three sentences, segment by segment, in both languages: after each the last word is inside the pill, past the fade, on the one line, and the three together have lost their beginning. `measure` (1920×1080, both languages): place by place the running text is there and its longest line has at most 110 characters (Home, a file's summary and transcript, a meeting with and without notes, "Try it" with a long sample, the Soundboard without a cable). The same is a check of every page opened at 1920 px or wider (`measure` in `inpage.js`: `RUNNING`, `lineLengths`, which measures a text box in a copy of its text). "Leaves the window" asks for the part of a box that a cutting box around it leaves to be seen (`seenSideways`): the pill's text leaves nothing. New in the probes: `resultLayout` on `files-loaded` and `files-result` (both also at 1920×1080: the field as wide as its text, the buttons and Clear ending with it, the summary beside it; one column keeps the page's width), `meetings-no-notes` also at 1920×1080 with its frame and its hint rows, `tryItFields` (no field of AI cleanup keeps a part of itself empty, none is wider than 720 px), the bar's room on `soundboard`, the taken tile on `soundboard-states`, a dictation's width on `home`, `wholeBars` on `pill-edit` (one word to five digits), `pillOneLine` on the pill's pages with text. (8) Mutations. With the pill's old CSS `pill-segments` fails after each of the three segments (the last word at x 331 to 365 of a box that ends at 301), and `pill-edit` sees the cut bar at "128 words". With `--measure: 999em` the run fails with 8 findings: `measure` in five places (a file's transcript 131 characters a line, the Soundboard's instructions 220), `files-result` and `meetings-open`. With the bar's old 240 px `soundboard` fails in English at 900×600, with the old cap on every dictation `home` fails in 6 views. The full run: 102 pages in 584 views, `0 findings, 0 known (allow.json), 0 new`, exit 0, twice in a row with the same report (16 min 45 s and 16 min 42 s by the clock, 1003 s in the pages); `allow.json` is `[]`; `roundtrip` and `contract` green. Unit tests: 62, unchanged.

**After the whole-branch review, wave 1 (behaviour, robustness, accessibility).** The review of the whole branch found thirteen things the task reviews had not: two that lose a user's data or reach, the rest in the start, in saving, and in what a screen reader or a contrast theme gets. Wave 1 fixes those; wave 2 (layout and wording) follows. No Rust changed. What later work builds on changed in fourteen places. (1) The history stays reachable under the setup steps. Home hid the whole daily view, and with it "Recent dictations", whenever a step was open: someone whose only microphone was unplugged, whose cloud key was cleared or whose model file was gone found the three steps and nowhere to copy yesterday's dictation (in 0.16.0 History was its own page). Now `renderSetup()` keeps the daily view as its list alone while the steps show and the history has entries (`layout(listOnly)` in `home.ts`, the class `list-only`, `styles/home.css`: the controls are not shown, the list is 832 px wide like the steps); a PC without a history sees the steps alone. `setup()` in `setup.ts` takes `history` (the number of dictations, null until read) and answers `known` (the speech model's state, the microphones and the history are all read) and `firstRun` (no model for the local engine AND an empty history). Only `firstRun` is welcomed (`header(now, s)`, which lost its `cloud` argument) and only `firstRun` opens on Home (`startRoute(saved, firstRun)`, `startOn(firstRun)`, `decideStart()` in `main.ts`): everyone else gets the plain "Setup needed" with the reason and the window where they left it. `history.ts` exports `historyCount()` and tells its host when the list was read (`changed`). (2) Nothing is saved before the settings are shown. `saveSettings()` reads thirteen controls and the replacements' rows, and `loadSettings()` filled them between two awaits while every control was live: one click on "Hold" in that window saved the microphone as "", the model as "small", no replacement and no rule (in 0.16.0 too). Fixed both ways. The fill is one synchronous run right after `get_settings` answers: `showSettings()` sets every control, `showTexts()` draws everything that is written in the Display Language or built from what the backend last said, and neither asks or waits for anything; what else the start asks is asked beside it. And a gate: `settingsLoaded` in `main.ts`. Until it is true `store()` (the one way to the backend's `save_settings`: the controls, the rules, the dictionary, the replacements, Files' and Meetings' own values, the first run's language) refuses, the handlers that write the settings return, and Home, Files and Settings are `inert` (the attribute is in `index.html` and is taken away when the settings are shown), so a click is not swallowed while looking accepted: it does not arrive. The modules ask `host.loaded()`. If `get_settings` fails the three pages stay at rest and the notice of (4) says so (`settings_load_failed`). (3) The start. Home and the status are wired at module start (`startHome()`, `initStatus()`), the language is set there from what is known without the backend (`prefs.lang`, new in `prefs.ts`: the Display Language the window was last shown in; else `detectDefaultLang()`), and the start's questions go out together: `get_settings`, `list_microphones`, `history_list`, `ai_status`, the status's four, `detect_gpus`; after the settings, which models are on disk and the unused models. `#home-daily` is hidden in `index.html` like `#home-setup`, and Home shows its heading alone ("Getting ready…", `header()` for a setup that is not `known`) until it knows which view it shows, so a new PC no longer sees the daily view first. `status()` has `aiKnown`: not "Ready" before the AI's first state is in (`aiActivity().known`; a failed question counts as known). `src/start.ts` (new) asks once what two parts asked: `askOnce("detect_gpus")` (Home's suggestion and the "Detected" line: looking probes CUDA and Vulkan), `stateOnce("meeting_state", "meeting-status")` and `stateOnce("game_free_state", "game-free")` (the status, the Meetings page, Settings: the answer comes with what the event said since, `later()`, for a part that wired its own listener late). `main.ts` no longer asks `soundboard_state` (`BoardView.redraw()` draws from the state the board has; `setActive()` joins a refresh that is out). The Meetings page registers its five listeners together. `document.body` has `data-loaded` (the settings are shown) and `data-started` (every first answer is drawn and every page wired); the tool's `started()` waits for the second. With 300 ms for every answer Home shows its view after about 400 ms and the start is over after about one second (Home was wired after the eighth answer in a row: 2.4 s). (4) One wrapper for every save. `saveSettings()` answers true or false and never rejects: a save the backend refuses is said in a notice at the top of the page (`#save-notice` with `#save-notice-text` and `#save-notice-close`, sticky; read out by `#save-live`, which is there from the start; `save_failed`), and `currentSettings` and every control go back to `savedSettings` (the copy of what the backend has: as read, then as the last answered save sent it; `change_hotkey` and `pc_check` keep it in step). Not while a later save is out: that one carries the change, and its answer decides. The next save that works ends the notice. `saveStrict()` throws, for the three deletes that say a failure on their own button (a rule, a word, a replacement: not said twice). The hosts have `save(): Promise<boolean>`, `saveStrict()` and `loaded()`; `addWords()` answers -1 for words that could not be saved (the word stays in its field, Home does not say "Added"); Files' and Meetings' `saveSettings(patch)` answer a boolean; "Start with Windows" tells Windows the saved value again when its save is refused. (5) The Display Language is saved first (`saveSettings()` is the handler's first call; it was the tenth step after four questions), then `showTexts()` draws the window from what it knows: nothing is asked but the Meetings list. What was written once in the old language is emptied (`clearDictionaryStatus()`, `forgetHomeSaid()`, `soundboard.redraw(true)`, `#download-live`) or drawn from kept data (`renderTest()` in `ai-settings.ts`, `renderPcCheck()`, `drawUnusedModels()`, `renderModels()`, `renderHistory()`). `renderAiSettings()` is gone: `showAiSettings()` fills the tab without asking, `refreshAiStatus()` asks. (6) The speech models can be read about without choosing one. `#model-more` (new, behind a "More" on the Speech model row) lists all eight with size and their line (`renderModels()` in `main.ts`; `model_note_base` and `model_note_medium` are new), marks the one `recommend()` gives for this PC ("Recommended for this PC"), and the dropdown's option has "· recommended". While the dropdown's model is not on disk the row's note also says which model is recommended and for which graphics card (`setup_model_for` / `setup_model_cpu`); the dropdown stays on what the settings say. The model selects are at most 344 px wide (320 before) for the longest option, and the German `model_hint` is shorter ("Größere Modelle: genauer, mehr Speicher."): beside the wider dropdown the old sentence and "Mehr" no longer shared a line at 1920 px with the Download button there, and a middle length let "Mehr" fit and "Weniger" wrap at 900×600 (the check "More opens the long text without moving its row's control"). (7) Smaller ones in the interface: "History settings" under the list (`#history-settings`) leads to Keep history, and with the history off the sentence itself does (`history_off_open`); a failed download's advice to check the connection shows only where no reason is known (`failureWords(sentence, advice, because, model, reason)`, `download_advice`; `setup_download_failed` is the bare sentence); the optional card's button reads "Hide" in every state and its text says where the model is later (`setup_ai_dismiss` is gone). That text is longer, so the card needs more room than it did (one line from 1200 px of window in English and 1322 px in German before): at 1200 px its text takes two lines under its title (77 px of card, 57 before), at 1600 px English is one line and German stands under its title (57 px), at 2560 px both are one line; between those sizes it was not measured. It still has one height in every state, and the daily view still does not scroll at 1600×900. The probe's limits follow that. Wave 2 may shorten the text. (8) Accessibility: the Soundboard's switches have `role="switch"`; `layout()` gives the keyboard focus back after it moved the list across the 900 px step (the list is still moved and not reordered with CSS `order`: with `order` the eye would see the list after the quick switches and Tab would reach it after "add a word"); `#home-notice` has no role and its sentence is written into `#home-live` when it shows; Files' bar is `#file-progress-bar` (`role="progressbar"`, named after the file, with the status line as its `aria-valuetext`) and the end of a run is said once by `#file-live`; a page's title is its `h1`, a card's heading an `h2`, a meeting's notes headings `h3`; the pill sets `<html lang>`. (9) Windows contrast themes: one `@media (forced-colors: active)` block each at the end of `components.css`, `shell.css`, `home.css` and `style.css`. Areas get an edge, a switch a track and a thumb, and what is on or selected the theme's Highlight / HighlightText (`forced-color-adjust: none` where a ground must stay one). System colour names pass the static colour rule as they are. In a light theme the logo is inverted. (10) Robustness: every `.replace("{…}", value)` in `src/` takes a function (about fifty places; "$&" in a name came out as the placeholder); `refreshStatus()` in `ai-settings.ts` and `refreshHistory()` number their questions and drop an older answer; `downloadRuns()` is the one answer to "does the AI model download" for the row, the state line, Home's card and the sidebar (after a reload during a download they disagreed); `setDownload()` in `activity.ts` keeps whole percents, so a download's ten reports a second draw Home at most a hundred times. (11) Clean-up: `src/size.ts` (new, pure) holds the one size formatter, `sizeText(bytes)` (`formatSize` in `main.ts` and `gb()` in `ai-settings.ts` are gone, `modelSize()` calls it; an unused model of 999.6 MB read "1000 MB"); the Soundboard's search is `matches()` of `search.ts`; the duplicate imports, the export `statusInput`, three dead strings (`audio_empty_message`, `transcribing_message`, `hotkey_taken`), three unused CSS aliases, three classes without markup and a container without a query are gone (54 Soundboard pictures are the same to the byte without it); `contract.json`'s `dashKeys` is empty (`unused_model_links` lost its dash). `overlay.html` has no comment that names an old tab. (12) New ids, none dropped or renamed: `save-notice`, `save-notice-text`, `save-notice-close`, `save-live`, `home-live`, `history-settings`, `file-progress-bar`, `file-live`, `model-more`. (13) The tool. `mock.js`: `keep({ answerDelay, settings, ai })` (late answers from the first moment of the next start, values laid over the settings, a download that runs in the backend), `lateNext(cmd, ms)` (an answer that is true when asked and arrives later), `ai`. `static.mjs`: a command counts as called through `askOnce` and `stateOnce` too. `pages.mjs` (the block "After the whole-branch review, wave 1", before the pill's): nine pages before `measure`. `home-no-microphone` and `home-cloud-no-key` (state pages: the steps with the list under them; the list is searched and a dictation copied; the plain heading; the window opens where it was left), `settings-load-window` (real clicks and clicks from code on Hold, Toggle, Add rule, a switch, Add replacement and three more while the settings are 600 ms away, on four tabs: no save, nothing changed; then every control is filled the moment the settings are read, and a click right then saves that one setting), `home-start` (the start with 300 ms answers, noted about every 100 ms in both data sets and languages: one view and never the other first, the neutral heading until then, never an empty key box, "Ready" only once and only with the daily view, no text of the other language at any moment; a Display Language that is not Windows' own; `UI_CHECK_FILM=<folder>` saves the frames as pictures), `save-failed` (a state page: the notice, and for a segmented choice, a select, a switch, a text field, a rule's and a replacement's field, Home's switch, Start with Windows, Files' Speakers, Home's word and the Display Language that the control is back on the saved value), `language-change`, `settings-models-list` (both data sets), `wave1` (the pages' outlines, the links to Keep history, the focus over the 900 px step, "$&", older answers that arrive last, a download after a reload) and `forced-colors`. Existing probes got what belongs to them: the notice's line in `loadFailed`, the file's bar and its end, the board's switches, the pill's `lang`, and that a failing delete does not also show the save notice. (14) Mutations, each restored: with the list hidden under the steps again `home-no-microphone` and `home-cloud-no-key` fail (8 findings, first "the page shows its state"), with Home forced while anything is missing "with a history the window opens where it was left" fails; with the gate open from the start `settings-load-window` fails on every tab (the handlers run on settings that are not there: failed checks and page errors), and with the gate lifted before the controls are filled and two awaits between (the shape of 0.16.0) it reproduces the defect: one click changes `whisperModel`, `replacements`, `sendCommand`, `muteAudio`, `freeGpuForGames`, `idleUnloadMinutes` and four more; with `#home-daily` shown from the start and no language before the settings `home-start` fails with 5 findings (a new PC sees the daily view, empty key boxes, English in a German window). The full run: 111 pages, `0 findings, 0 known (allow.json), 0 new`, exit 0, 18 min 16 s by the clock and 1095 s in the pages, in 618 views (16 min 45 s and 1003 s before, with 102 pages in 584 views); `allow.json` is `[]`; `roundtrip` and `contract` green (177 ids, 76 commands). Unit tests: 74 (62 before: size 3, activity 3, setup 3 more, status, prefs and models 1 more each). `size.ts` joins the pure modules of the Global Constraints, and `activity.ts` is tested like one.

**After the whole-branch review, wave 2 (layout, design, wording).** The design review of the whole branch found the window calm and consistent, and two things wrong with it as a whole: several views were a narrow column in a half-empty large window, and the right edge jumped by 200 to 270 px from page to page at the most common laptop sizes. It also found the daily list out of sight in the smallest window, thirty grey words on eight rows, and one thing under several names. Wave 2 is four commits (the window: the layout system, Home, the names and the details; the pill; the tool; the docs). No Rust changed, no id was dropped or renamed, `meetings.ts` and `files.ts` changed only what they write into the page. What later work builds on changed in fourteen places. (1) **The layout system**, decided once and written down at the head of `styles/shell.css`. A page's content runs from the common left edge to the window's right edge (the content area's padding) at every window size: `.content-section` has no `max-width`, and no page has one of its own. Inside that width a page has columns, decided on `roomBeside()` (`#content.offsetWidth`) and written on every `.content-section` as classes by `layoutSteps()` in `shell.ts`: `wide` from `WIDE` (900 px), `roomy` from `ROOMY` (1250 px, new), `wider` from `WIDER` (1600 px). Under 900 px every page is one column. From 900 px the pages with a narrow side beside a list are two: Home (controls, dictations; `home.ts` still writes `wide` and `wider` on `#home-daily` and moves the list) and the Soundboard (panel, sounds; `board.ts`). From 1250 px the pages of setting rows or of two texts are two: Settings, the Meetings library, an open meeting, Files with a file. From 1600 px Home's controls are two columns of cards, and the first run is Home's grid. 1250 px and not 900 for setting rows: the columns are 593 px at the step (a row's hint is two lines there in German, never three), 668 px at 1600×900, 828 px at 1920×1080, 1148 px at 2560 px. Between 900 and 1250 px the one column fills the width. One gutter between two columns on every page, `--gutter` (16 px; Files' result and an open meeting had 20, the Soundboard 24), and one side column beside a transcript, `--side-col` (`clamp(360px, 38%, 622px)`: 457 px at the step, 622 px from 1920 px), both in `tokens.css`. A frame takes its column's width and running text keeps `--measure` inside it: a transcript's frame runs to the window's right edge with its text at the measure (the frames that ended near their text, `--file-frame` and the 840 px of a meeting without notes, are gone; `tokens.css` says so at the measure). A wider form is still never the higher one. (2) **Settings** (`styles/settings.css`): one column of the page's width below `roomy` (the 1080 px cap is gone), two columns that share the width from it (`repeat(2, minmax(0, 1fr))`, no 900 px cap; the Dictionary's columns of text flow likewise). Everything else of "A large window: two columns" stands: the placement per tab, the fold's bar, the Tab order. A rule's Delete stands at the card's right edge (`.rule-fields` keeps its 720 px). (3) **Meetings** (`style.css`, "Meetings: two columns"; `index.html`): `.mt-layout` has the page's width, so the start row spans it. The library's rows fill it; from `roomy` they are two columns of text flow (`columns: 2`, rows spaced by their own margin), filled one after the other: the list is sorted newest first, and a sorted list reads downwards, so the left column is the newer half and the right one goes on where it ends (across, the dates would zigzag and every second entry would stand a window's width away; with two meetings both ways are the same picture, with twelve the columns are six and six). An open meeting is one shape with and without notes: `#mt-hint` and `#mt-notes` stand in a new wrapper, `.mt-side` (`display: contents` in one column, so the page's one stack is as it was), which from `roomy` is the side column, and `.mt-main` (the transcript) is the other, to the window's right edge. While the side column has neither a hint row nor notes (a meeting that records, a finished one that never got notes), a quiet line stands in the notes' place (`.mt-notes-none`: `mt_notes_live` / `mt_notes_never`, chosen by `#mt-view[data-state]`, which `renderView()` now writes; in one column it is not shown). The container query on `mtmain` is gone: the step is the class, on `offsetWidth`. (4) **Files** (`style.css`, "Files"; `index.html`): without a file the drop zone takes the height the window leaves (`flex: 1 0 auto`) and the options stand under it, their two choices side by side from `roomy`. With a file the zone is one line and so are the options (their short form: each choice under its name, no hint, and `#file-options-more`, a "More" that opens the card as it is without a file; the speakers' line keeps it open while it has something to say that is no hint, `data-state="busy"` or `"error"`, written by `speakersSay()` in `files.ts`). `#file-summarize` and `#file-summary-box` moved out of `#file-result` to stand before it: the page's order is the file's line, Summarise and its summary, then the transcript under its toolbar and its speakers, which is the single column's order and Tab's. From `roomy` the page is a grid: the side column (zone, options, file's line, Summarise, summary) and `#file-result` beside all of them, down to the page's bottom. At 900×600 the transcript starts at y 429 with speakers' names over it and at y 393 without (y 520 before). `rows.ts`: a "More" may name several hints (`aria-controls` with several ids), leave showing them to the style sheet (`data-shows`) and say what it is about (`data-about`, an i18n key). (5) **The first run** (`styles/home.css`): the steps and the optional card have the page's width (the 832 px are gone, and so is `list-only`'s); from `wider` the page is Home's grid (5fr / 6fr): the steps at the left, the optional card and, for someone with a history, the list at the right; with neither the steps keep the width. Nothing is moved in the page. (6) **Home in one column** (the smallest window): the four keys stand two by two (`.home-grid:not(.wide) #home-hotkeys`), their rows and the quick switches' are lower, so at 900×600 the head of "Recent dictations" stands at y 433 and the first dictation with its second line ends at y 523, in both languages (the head stood at y 565). A key box that asks for its key goes under its name there. (7) **A dictation's row** (`history.ts`, `styles/home.css` "Row actions"). The second line is `.history-parts` (app, time, length: one line that never breaks, an ellipsis if a name is too long) and, for an edit, `.history-edit` under it; the length reads "6 s" or "1 min 12 s" (`formatDuration`), and the model is not named. The actions' order is Original, Play, Re-run, Copy, Delete: Copy has `data-action="copy"`, stands at one place in every row (before Delete, which ends the row at the card's edge as in every list) and always shows; the others have `opacity: 0` until the pointer is on the row or the row holds `:focus-visible`, and keep their places (and the Tab order, and their names) meanwhile. An action that says something of the moment stays in view through `data-on` (`keep()` in `history.ts`; a failed delete through `confirm-delete.ts`), an armed Delete through `.armed`, a running Re-run through `aria-disabled`. With `(hover: none)` or `forced-colors` all show. `restoreFocus()` hands the focus to Copy of the row that moved up after a Delete (it was the row's first action, which is now one that may not be seen). From a card of 600 px the list is the two-column grid its rows share (it was that only from 840 px), so the actions' column is as wide as the fullest row. (8) **One form for a key that is not set**: a key box that says "Not set" in quieter words (`.key-unset`, now in `components.css`; Home, Settings and a sound's tile set it). `home_key_unset` and `HotkeyView.home` are gone. (9) **One name for a model**: a meeting's line and the unused models' rows use `speechModel(id).name` and the backend's labels (`aiModelNamed(file)` in `ai-settings.ts`); under Unused models the file's name is the second line. (10) **Strings** (the changelog lists old and new): `language_label` "Spoken language", `engine_label` "Transcription" with "On this PC" / "Groq Cloud" and "Groq Cloud" in the sentences that said "the cloud engine (Groq)", `files_clear` "Remove transcript", the microphone as "System default: name", German `ai_desc`, `ai_retry`, `history_stop`, `setup_problem`, `setup_mic_retry`, the five "… gefunden.", "Diktiertaste" for "Hotkey", "Ctrl" and "Shift" as the key boxes show them, `sb_pop_out`, `sb_toggle_hotkey_label`, `model_hint` (a sentence again: "Größer ist genauer und braucht mehr Speicher."), `setup_ai_text` (shorter: the optional card is one line from 1200 px of window in both languages, 490 of 498 px in German; `setup_ai_coming` is shorter too, "Danach ist die KI-Korrektur an.", because whatever the card says meanwhile must fit the room of the text it rests on), full stops on three Soundboard hints, `model_note_q5` with the size formatter's decimal point. `sb_auto` keeps the word "Auto" and takes the microphone's form, "Auto: {name}" (measured: "Automatisch: CABLE Input (VB-Audio Virtual Cable)" needs 323 px and the panel's dropdown has 312; "Auto: …" needs 273). New: `files_options_about`, `mt_notes_live`, `mt_notes_never`. The pill: `mt_no_model` and `rewrite_needs_ai`. (11) **Details** (`components.css` unless said): one scrollbar rule for every scroller (`::-webkit-scrollbar`, 6 px, the thumb in the colour of a field's edge at 55 %; the rules of `#content`, `#sidebar` and `.mt-transcript` are gone); a tab keeps the room of its bold label (`.tab::before` with `data-label`, which `applyTranslations()` keeps in the Display Language); `.has-menu` (Export) ends in the select's arrow and the Soundboard's Devices has the fold's mark; "More" never stands alone on a line (the hint's text keeps room for it as a padding that cannot break off its last word, the button stands in that room, and no space stands between the two in the page: at a space the line could break and put the button a room's width left of its card, which the tool's `overflow` check found in one window width); the summary, a meeting's notes and the dictionary's suggestions have no outline; `.page-notice` is `position: fixed` under the title's row and pushes nothing down; the open list of speech models takes its row's width (`#local-settings:has(#model-more:not([hidden]))` is a grid) and the chosen model's line rests meanwhile; a sound's volume shrinks to 80 px before it wraps; after an import with failures only those are red (`.sb-notice-ok`). (12) **The pill** (`overlay.html`): `@import` of `tokens.css` and of the font's Latin part in two weights (`latin-500.css`, `latin-600.css`); the font's imports moved from `tokens.css` to `styles/font.css`, which `style.css` loads first, so the tokens can be had without the font's other scripts. Its text, record, wait and Edit colours are tokens; its see-through ground, its edge and its resting bars stay its own. A text state's ground is solid (`var(--surface)`). Built, the pill's page is 16.4 kB (9.9 kB before) and its script is unchanged (6.5 kB); one font file of 24 kB is fetched when the page loads and the second with the first chip, neither holds the first paint back (`font-display: swap`). The pill does not take the tokens' `color-scheme: dark` (`:root { color-scheme: normal }` after the import): its window is see-through around the pill, and a dark scheme may give a page without a ground of its own a dark one. `licenses/IBM-Plex-Sans-OFL.txt` is the font's licence, and both READMEs credit it. (13) **The tool.** `pages.mjs`: `WIDE`, `ROOMY`, `WIDER`; `columns` and `settingsHold` follow the new step (the page `settings-columns` also at 1450×820, the step itself); `filesLayout`, `resultLayout` and `optionsMore` (new) for Files (`files`, `files-loaded`, `files-result` also at 1450×820); the Meetings probes (`meetings` also at 1450×820; `meetings-many` asks for six and six, read downwards); `rowActions` (new, on `home`: Copy alone at rest and under each other, the others where they stood once the pointer or the keyboard is there, an armed Delete that stays), the first screen at 900×600 and the keys two by two; `home-no-microphone` also at 1920×1080 (the list beside the steps); and one page more, `edges` (1536×864 and 1920×1080, both languages): `sameEdges` visits 18 places (Home, Files empty, with a result and with a summary, the Meetings library, an open meeting with and without notes, the Soundboard with and without its panel, the five tabs with their folds closed and open) and asks that the largest right edge of anything drawn is one x on all of them, within 1 px, and the smallest left edge too; `pagesHold` (once per run) sweeps the steps Home's and Settings' own sweeps do not cover, in a window that draws its scrollbar: the first run's grid at 1600 px, Files without a file and with a result, the Meetings library and an open meeting with and without notes at 1250 px. `inpage.js`: a hint may take two lines in a row narrower than 760 px (a column of a page in two columns), one line stays the rule where the room is there; what is not drawn at the moment (`opacity: 0`) is not judged for contrast. `static.mjs`: the row actions' selector passes the focus rule by name (it asks where the focus is and draws no ring). `USER_TEXT` has `.history-parts`. (14) **Mutation and the gate.** With `roomBeside()` reading `clientWidth` (the width a scrollbar takes from), a run of `home`, `settings-columns`, `edges` and `soundboard` (populated, English) fails with 7 findings: `pagesHold` on an open meeting with notes (4 of 8 sizes are one column at 1250 px and more, because the one column's own scrollbar took the width), on Files with a result and on the first run's grid, `settingsHold` (27 of 72 sizes, and it never sees two columns with a scrollbar), and `boardHolds` (the panel flips in 9 of 40 sizes); restored. The full run: 112 pages in 640 views, `0 findings, 0 known (allow.json), 0 new`, exit 0, twice in a row with the same report (19 min 48 s both times by the clock, 1186 s in the pages; 18 min 16 s and 1095 s before, with 111 pages in 618 views: `edges` with its sweep takes 57 s, and four pages are also opened at 1450×820); `allow.json` is `[]`; `roundtrip` and `contract` green (177 ids, 76 commands; the new ids are `file-options-more` and `file-language-hint`, none was dropped or renamed). Unit tests: 74, unchanged. What the pictures still show as weak is in the report of this wave: a transcript's frame in a 2560 px window is 1670 px wide with 620 px of text in it (the rule: the frame has its column, the text its measure); a Settings tab with its fold closed has only the fold's bar in its second column; without a file the drop zone of a 1920 px window is 810 px high; a meeting that records has one quiet line in its side column.

**After the final verification.** The final verification review found nothing that does not work and fourteen things a user sees in the first minute: layout, wording, docs. One round, two commits (the window with the tool; the docs). No Rust changed, no id was dropped or renamed (new: `file-summary-more`), `meetings.ts` and `files.ts` are untouched. What later work builds on: (1) **Home's quick switches** (`styles/home.css`): both selects stand beside their names at every width (the name keeps one line, the control is `flex: 1 1 180px` and its select fills it up to 320 px); the card is the container `switches`, and under 340 px between its paddings, which no window of 900 px or more has, both go under their names together. (2) **A dictation's row** (`history.ts`, `styles/home.css` "Row actions"): the order is Delete, Original, Play, Re-run in a group of their own (`.history-more`), then Copy, the row's last action, whose words end at the card's right edge where the search field ends (it keeps the width of the wider of "Copy" and "Copied"). The group shows with `:hover` or `:focus-within` (not `:focus-visible`: after a click on Re-run the focus sat on a button nobody saw). In a narrow list (a card under 600 px) the group lies over the row's second line (`.history-parts`), whose words are not drawn meanwhile; where nothing hovers or a contrast theme is on, the group has a line of its own. (3) **A meeting that records** is one column from `roomy` too, with `.mt-notes-none` as one line over the transcript, until a hint row or notes are there (`#mt-view[data-state="recording"]`, `style.css`). (4) **The page's notice** lies at the bottom of the content area (`.page-notice`, `bottom`), and every page leaves its height free at its end (`--notice-room`, written by a ResizeObserver in `main.ts`, used by `.content-section` in `shell.css`). (5) **Files**: the options card stands before the drop zone in the page (`index.html`; rows 2 and 3 of the two-column grid swapped, the toolbar has the options' line). In one column the summary shows five lines, two in a window lower than 700 px, with `#file-summary-more` (`data-clamps`; `initClamps()` in `rows.ts` shows the button only while the text is cut). (6) The Soundboard's gutter is `--gutter`; in the pop-out a stacked row's label has the row's width. (7) **The start's wait** (`start.ts`: `START_WAIT_MS`, `startWaitOver`): after five seconds without every answer `main.ts` sets `startWaited`, says `backend_silent` in the page's notice, draws the status and announces the route; `status()` and `setup()` take `waited` (what is unknown then is neither missing nor a reason to wait; without the speech model's state the status is never "Ready"); the status counts the speech model as unknown until the settings are read (`StatusHost.loaded`), so the sidebar never says "Ready" beside "Getting ready…"; `initStatus()` takes each of its four answers as it comes and draws at the latest after the wait. The Meetings page's own start still waits for `meeting_state` (`meetings.ts` is not touched). (8) **The pill**: the grounds of its text states are `inset: 8px` (304 by 48 px, the pill's own box), and both weights of the font are asked for at the script's start. (9) **Strings**: "Whisper" is gone from the window's sentences ("the speech model", or "the app" for the dictionary), `model_hint` and German `dictate_hint` are one line in a column of 604 px, German `setup_ai_text` ends in a whole sentence ("Sie bleibt in den Einstellungen."; "lokal" went for the room), `backend_silent` is new, and every fallback text in `index.html` is the current English string. (10) **The tool**: `mock.js` answers `history_rerun` and `history_audio` as the backend does and holds a question of the start with `keep({ hold: [cmd] })`; `rowActions` (rewritten: Copy at the edge, one height, the narrow list's line, a Re-run and an Original by mouse), the quick switches' one form (`home`, now also at 1920×1080), `meetings-recording` (also at 1536×864 and 1920×1080), `noticePlace` (on `save-failed`), `files-result` (the transcript's first line on the first screen in one column, More and Less, Copy copies all), the Soundboard's gutter, `pillOutline`, and one page more, `start-hangs` (each of `list_microphones`, `speech_status`, `meeting_state` and `get_settings` held, then released); `inpage.js` lets a text be cut where a "More" on screen names it. The probes were seen to fail without their fix (see the round's report). The full run: 113 pages in 652 views, `0 findings, 0 known (allow.json), 0 new`, exit 0 (20 min 57 s by the clock, 1255 s in the pages); `allow.json` is `[]`; `roundtrip` and `contract` green. Unit tests: 76 (two more: `waited` in `setup()` and in `status()`). No layout threshold moved: `WIDE`, `ROOMY` and `WIDER` and every container query's width are as they were. What still looks weak is in the round's report.

**After the user's try-out decisions.** The user tried the window and decided two things. (1) **Swiss spelling in the German interface.** The user is Swiss: every German text the app shows is written with ss, never ß (`src/i18n.ts`: 14 texts, among them "Schliessen", "Abschliessen", "Grössere Modelle sind genauer."; the pill's table and the tray's German texts had none). Only the two texts that name the character keep it, `swiss_spelling_hint` and `ai_instructions_placeholder`, and the English ones that mention it. `README.de.md` is written the same way. `ui-check` holds it: the static check `spelling` (`static.mjs`, `SHARP_S_KEYS`) fails on an ß in the German table of `src/i18n.ts` or in the pill's German table outside those two keys, and on a listed key that has none any more. The changelog's "Labels renamed" keeps "Modellgröße": that is the name 0.16.0 showed. (2) **The typeface is Windows' own Segoe UI, as in the mockups the user chose** (`look.html`: `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`). Task 2's bundled IBM Plex Sans is gone: `--font` is that stack and `--mono` is the mockup's `ui-monospace, Consolas, monospace` (`styles/tokens.css`), `styles/font.css`, the dependency `@fontsource/ibm-plex-sans`, `licenses/IBM-Plex-Sans-OFL.txt` and the pill's own font imports and `document.fonts.load` are removed. The app is Windows only and Segoe UI ships with every Windows, so nothing is bundled and nothing is fetched; the spec's point "no request to Google Fonts" holds. What later work builds on: **the weights.** The webview draws Segoe UI in three faces whatever weight is asked for, in the Variable family of Windows 11 and in the static one of Windows 10 alike (measured in headless Chromium with `CSS.getPlatformFontsForNode`: up to 450 is Regular, 500 to 600 Semibold, from 650 Bold). The 500 the styles used for labels would have drawn everything Semibold, as heavy as what is chosen. So the styles write the weight that is drawn: 400 for text, labels and controls at rest (a setting's name, a nav item, a tab, a secondary button, a segmented choice, a sound's and a meeting's name, the pill's text and notices), 600 for what is chosen, a card's heading, a button that acts and a speech model's name in the list behind "More" (it leads a line of the same size), 700 for a page's heading (the mockup's 650, which is drawn Bold). `ui-check` holds it in `static.mjs`: `font-weight` is 400, 600 or 700, `font-family` is `var(--font)` or `var(--mono)`, the two tokens are set once with these values, and no style sheet has an `@font-face` or imports anything but a style sheet of the app's own. The pill's probes ask for the token's family and for no loaded font file instead of the two weights of the bundled font; the run no longer waits for fonts. The gate raised no finding with the new face: no layout and no limit of a probe had to change.

## File map

| File | Change | Task |
|---|---|---|
| `tools/ui-check/*` (`run.mjs`, `inpage.js`, `mock.js`, `pages.mjs`, `static.mjs`, `roundtrip.mjs`, `gen-contract.mjs`, `contract.json`, `allow.json`, `package.json`, `package-lock.json`) | the headless check | 1, then `pages.mjs`, `mock.js`, `contract.json`, `allow.json` in 2 to 8; `static.mjs`, `run.mjs`, `inpage.js`, `mock.js`, `pages.mjs` in the review of 8 |
| `package.json`, `.gitignore` | scripts `ui-check`, `test:unit`; ignore the tool's output | 1 |
| `src/styles/tokens.css`, `src/styles/components.css` | tokens, components, bundled font | 2 |
| `package.json`, `package-lock.json` | `@fontsource/ibm-plex-sans` | 2 |
| `index.html`, `soundboard.html` | no Google Fonts; then the new shell, Home, Settings | 2, 3, 4, 5, 6, 7, 8 |
| `src/style.css` | shrinks to the page rules | 2 to 8 |
| `src-tauri/src/audio.rs`, `whisper_engine.rs`, `main.rs` | `MicMeter`, `LoadState`, `SpeechStatus`, commands, events, tray language | 3 |
| `src/overlay.html` | Display Language, `speech-notice`; the standard's fades and sizes, Edit mode's chip inside the pill | 3, review of 8 |
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
- Produces (`src/mirror.ts`): `mirrorSelect(source, copy) -> sync`, `mirrorSwitch(source, copy) -> sync` (a second control for a Settings control: same value, the change goes through the Settings control's own handler); since the review `mirrorHint(sources, copy) -> sync` (the notes under a Settings control shown again under its copy: the text of every source that is not `.hidden`; hidden and empty with none).
- Produces (`src/history.ts`): `HistoryHost { mode() }`, `initHistory(host)`, `refreshHistory()`; rows are `article.list-row.history-item` (`role="listitem"`, `aria-labelledby` its text, `data-id`) with `.history-text` (`id="history-text-<id>"`), `.history-meta` (app · time · length · model as `.history-part` spans that do not break; the line wraps between them), actions Copy, Original / AI version, Play (`data-action="play"`), Re-run (`data-action="rerun"`), Delete (the last one). `action(label, onClick, name?)` makes an action's button and catches its failure.
- Produces (`src/home.ts`): `HomeHost { recordingMode(), dictationKey(), ai(), addWords(text) }` (Task 5 adds three members), `initHome(host)`, `renderHome()`. (`src/ai-settings.ts`): `aiSummary() -> { name, state, tone, kind, downloaded, retry }`, `AiKind`. (`src/dictionary.ts`): `addWords(text)` exported.
- Produces (markup): `#home-title`, `#home-status`, `#home-status-text`, `#home-how`, `#home-notice`, `#home-notice-open`, `#home-daily.home-grid` (class `wide` from 900 px and `wider` from 1600 px of `#content.offsetWidth`), `#home-controls`, `#home-hotkeys` (`#home-hotkey-btn`, `#home-paste-last-btn`, `#home-rewrite-last-btn`, `#home-free-gpu-btn` with `…-text`; an unset key's text is "Not set · " and `span.key-set`), `#home-switches` (`#home-ai-toggle` described by `#home-ai-status`, `#home-ai-retry`, `#home-language-select`, `#home-output-select` described by `#home-output-hint`), `#home-loaded` (`button.home-loaded-row[data-reveal]`, `#home-loaded-speech|ai|mic`; with the cloud engine the first line leads to `#groq-key`), `#home-word-form`, `#home-word-input`, `#home-word-status`, `#home-recent` (`#history-search`, `#history-list` as `role="list"`, `#history-empty`, `#history-live` as `role="status"`, `#history-more`, `#history-less`). In Settings › General: `#history-count`, `#history-clear`.
- Produces (i18n): `home_how_hold|toggle`, `home_key_dictate|paste|rewrite|unset|missing`, `home_loaded_speech|ai`, `home_speech_loading|failed|unloaded|missing`, `home_mic_missing`, `home_load_failed`, `home_open_models`, `home_word_label|added|known`, `home_recent_title|search|all|more|less|none|found|found_one`, `history_action_failed`. `home_key_unset` is two parts around " · ": the second one is underlined.

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

`npx tsc --noEmit` clean; `npx vite build` clean; `npm run test:unit`: `tests 35` (+ search 4); after the review `tests 37` (search 5, status 16).

`node tools/ui-check/run.mjs --no-shots --task 4`: `49 findings, 49 known`, one stale entry (`span.history-meta`, `"until": 4`); delete it (10 remain); exit 0. The `home` probe checks: two columns from 900 px of content and the recent dictations after the quick switches below it; Home's AI switch, Language and a hotkey set on Home change the setting and show in Settings at once; "Add a word" lands in the dictionary; the search finds a dictation by its app. `home-all` checks Show all (50), Show more (+50), the end of the list, Show fewer (8).

Since the review the run is still `49 findings, 49 known` (name 32, hint-lines 12, clipped 5), with `home` also at 1200x800, and the probes check more. `home`: what is loaded has no colour while nothing is missing, and in the first-run data set both model lines are tinted and say "not downloaded"; the AI's state line is hidden and empty while it is ready, and shows why the switch is off in the first run; both sides start on one top edge and the list is the wider one; every row is a named list item, all rows have one shape and no part of a second line is broken; an unset key underlines only "Set" and shows the accent box while it listens; "Write in" with AI cleanup off shows Settings' reason under Home's select (`aria-describedby`) and loses it with the language; the search says what it found (`#history-live`); Delete from the keyboard puts the focus on the next row's first action; with the cloud engine the Speech model line says "API key missing" and leads to `#groq-key`, the other two lines lead to their selects; and once per run (English, 1600x900) the layout's two steps are tried in a window with its scrollbar drawn, one pixel below, at and above each step, at the heights where the page just fits and just does not: nothing may change by itself (on the code before the review 10 of 75 sizes did). `home-all`: after the last page the focus is on Show fewer, after Show fewer on Show all.

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
- Produces (`src/setup.ts`, pure, since the review): `header(status, setup, cloud)` (the i18n keys of Home's heading and of the pill beside it), `modelStep(input)` (step 2's state `"key" | "cloud" | "checking" | "todo" | "starting" | "downloading" | "failed" | "loading" | "done"` and whether its download counts as failed), `meterMay(input)` and `meterStep(now)` (`"start" | "restart" | "stop" | "keep"`) with `METER_USE_MS` (60 s), `METER_SILENT_MS`, `METER_REVIVE_MS`; since the re-review `idleFor(running, wall)` (the time since the last touch from two clocks).
- Produces (`src/home.ts`): `HomeHost` gains `microphones(): number | null`, `microphone(): string` (the microphone the backend has saved; it changes only once a save was answered), `aiModel(id): { name, bytes } | null`, `setUpSpeech(id): Promise<boolean>`, `setUpAi(id): Promise<boolean>`. (`src/ai-settings.ts`): `aiModelInfo(id)`, `setUpAi(id)`; `download()` joins a download that runs. (`src/main.ts`): `savedMicrophone`, `chooseModel()` (the body of the speech model dropdown's `change` listener; true when the model is there and saved).
- Produces (markup): `#home-setup` (`#setup-mic`, `#setup-mic-text`, `#setup-meter` with `#setup-level` as `role="meter"`, `#setup-level-fill` and `#setup-mic-hint`, `#setup-mic-select`, `#setup-mic-change`, `#setup-mic-retry`; `#setup-model`, `#setup-model-text`, `#setup-model-progress`, `#setup-model-fill`, `#setup-model-numbers`, `#setup-model-download`; `#setup-key`, `#setup-key-text`, `#setup-hotkey-btn`, `#setup-key-change`), `#home-ai-card` (`#setup-ai-line` around `#setup-ai-text` and `#setup-ai-progress`, `#setup-ai-download`, `#setup-ai-dismiss`). The two Download and the two Change buttons carry an `aria-label` that says what they act on.
- Produces (i18n): the 40 `setup_*` keys (39 before the re-review, which added `setup_ai_failed`), the four `home_reason_*` keys (the pill under the plain heading "Setup needed"), `progress_numbers` ("{percent} % · {done} of {total}").
- Behaviour: Home shows the steps while `setup(...).needed` (no microphone, or no speech model for the engine, or the cloud engine without its key). The microphone is opened only while the steps are on screen, the window itself has answered that it shows, and the user touched the window within the last minute (pointer, key, click, focus; a move of the pointer only in a window that has the focus); without that the level rests and step 1 says so, and the next touch starts it. With nobody at the window it is open for at most 60 s + the backend's 120 s. The optional AI card stays until its model is downloaded or it is dismissed (`prefs.aiCardDismissed`); after the setup it heads the daily view as one flat line, with one height whether it rests, downloads or has failed.

- [ ] **Step 1: Put back what Task 4 left out**

Everything in Task 4 Step 2's list, taken from `$P/app_src_task5/` (`home.ts`, `main.ts`, `ai-settings.ts`, `i18n.ts`, `styles/home.css`), `$P/app_index_task5.html` (lines 85 to 149) and `$P/tool5/pages.mjs` (the `home` probe's first-run branch and its original daily-view line). Afterwards `diff -ru --strip-trailing-cr $P/app_src_task5 src` shows only the corrections of Tasks 3 to 5 and review fixes. (Not the heading lines Task 4 deleted from `status-view.ts`: they stay deleted.)

Notes from the review of Task 4. Stage 5 is older than its fixes: where a line of stage 5 differs from the repo's in what follows, the repo's stays.

- `src/home.ts`: `layout()` reads `$("content").offsetWidth` and sets `wider` (stage 5: `clientWidth`, no `wider`). `HomeHost.ai()` returns `{ name, state, tone, kind, downloaded, retry }`; the three members come back beside it. The `syncs` array ends with `mirrorHint(…)`: put `mirrorSelect(select("mic-select"), select("setup-mic-select")),` back before it. `renderLoaded()` is the repo's whole (no colour for a value, "not downloaded" for the AI model, the microphone line with `home_mic_missing`, the state line only when there is something to say, `#home-ai-retry`); `renderSetup()` reads `host.ai().downloaded` as before.
- `src/main.ts`: the listener for the window's focus stays as it is (it lists the microphones only while none is listed and the settings are loaded; stage 5's line asks at every focus). `renderHotkeys()` stays (the unset key's two parts). `renderMicOptions()` marks an unplugged microphone's option with `data-missing`.
- `src/ai-settings.ts`: `aiModelInfo` and `setUpAi` come back after `aiSummary`, unchanged. Whatever writes `statusLine` goes through `say(text, tone, kind)`; stage 5's two functions do not write it.
- `src/styles/home.css`: only the block from `/* ── First run ─` to the end comes back, at the end of the file.
- `index.html`: lines 85 to 149 of the stage's file go where they were (between `#home-notice` and `#home-daily`); nothing inside `#home-daily` is taken from the stage.
- `tools/ui-check/pages.mjs`: the first-run branch replaces only the line `if (firstrun) return out; // the first run: Task 5`. The checks before it (what is loaded, the AI's state line) run in both data sets and read text and classes, so they hold while `#home-daily` is hidden behind the steps. The probe's signature is `async (page, run)`.

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

`npx tsc --noEmit`, `npx vite build` clean; `npm run test:unit`: `tests 37`; after the review `tests 47` (setup 18: the heading and its pill, step 2's states, when the level may run); after the re-review `tests 48` (setup 19: the two clocks). `node tools/ui-check/run.mjs --no-shots --task 5`: `49 findings, 49 known` (name 32, hint-lines 12, clipped 5; the same after the review), exit 0 (no entry has `"until": 5`). After the review a full `--no-shots` run took about 11 minutes (636 s measured): once per run the `home` probe waited out the minute after which the level is no longer started. Since the re-review that probe runs on a faked clock in a window of its own and the walk waits for a reloaded page by what it shows: about 8 minutes (463 s measured). The re-review added to the first-run branch: a pointer that moves over a window without the focus opens no microphone; a click alone starts the level; a stop that arrives before the start that was sent before it, and a start that arrives after the start that was sent after it, both end with the microphone closed (the mock swaps them); the optional card has one height, one place for its text and its button, and the daily view under it stays where it is, while the card rests, downloads and after a failure (every size, both languages), with the bar on the text's row from 1200 px. The first-run branch of the `home` probe checks, since the review: a window nobody has touched opens no microphone and step 1 says that the level rests, the first touch starts it without a click, and a minute after the last touch it is no longer started again (the mock's meter closes after 2.5 s there); a window that starts hidden, is slow to say so, or does not answer opens none; a microphone chosen in the step is opened only once its save was answered, and the level is that microphone's; Download pressed twice in one go starts one download and ends with the model saved, on step 2 and on the card; the steps stand at the same place in every state of the setup (eight states at every size in both languages) under a one-line heading whose pill says only the short state or only the reason; Retry after the only microphone was unplugged finds that out; the keyboard focus of a control that goes moves to the one that stands in its place; the optional card is flat from 1200 px and the daily view does not scroll because of it at 1600×900; the step offers the model for every PC when the graphics cards do not answer within 5 s. Before the review it checked: the steps show instead of the daily view; `mic_meter_start` is called and the level bar follows `mic-level`; Download asks for the model `recommend` suggests for the graphics card (`large-v3-turbo-q8_0` in the mock); the progress reads "43 % · 374 MB of 870 MB" (the sidebar's status says "Downloading 43 %" meanwhile, since Task 3's review); leaving Home calls `mic_meter_stop`. The `shell` probe: the first run starts on Home with the status kind `setup`.

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
- Create: `src/rows.ts`, `src/models.ts`, `src/styles/settings.css`, `tests/unit/models.test.ts`; since the review `src/progress.ts`
- Modify: `index.html`, `src/main.ts`, `src/ai-settings.ts`, `src/home.ts`, `src/i18n.ts`, `src/style.css`, `src/styles/components.css`, `tools/ui-check/pages.mjs`, `allow.json`; since the review also `src/shell.ts`, `src/mirror.ts`, `src/setup.ts`, `tests/unit/setup.test.ts`

**Interfaces:**
- Produces (`src/rows.ts`): `nameRows(root = document)` (every control of a `.setting-row` is named after its `.label-text`; switches get `role="switch"`; a key box reads "label, key"; since the review every `.hint-more` but the Soundboard's own gets an `aria-label`, "More about PC check"), `initHints()` ("More" / "Less" on `.hint-more[aria-controls]`, the long text is `.hint-long[hidden]`).
- Produces (`src/models.ts`, pure): `SpeechModel`, `SPEECH_MODELS` (8), `speechModel(id)`, `modelSize(mb)`, `modelLabel(id)` ("Large v3 Turbo q8 · 870 MB"); since the review `modelToSave(chosen, saved, downloading)`, since the re-review `modelToSave(chosen, saved, unverified)` (the dropdown's model is not the one last known to be on disk).
- Produces, since the review (`src/progress.ts`): `DownloadProgress`, `ProgressParts { bar, fill, numbers }`, `NOT_STARTED`, `showProgress(parts, p)` (the bar's width, its numbers, `aria-valuenow` and `aria-valuetext`; returns the whole percent). (`src/setup.ts`, pure): `progressWords(p, shown, said)`; since the re-review `failureWords(sentence, because, model, reason)` and, in `src/progress.ts`, `downloadFailure(model, reason)`. (`src/shell.ts`): `WIDE`, `WIDER`, `roomBeside()`; the class `wider` on `#section-settings`; `reveal(id)` opens a fold without saving it. (`src/mirror.ts`): `mirrorHint(sources, copy, here?)`. (`src/ai-settings.ts`): `aiSummary()` has `failed`.
- Produces, since the review (markup): `#download-live` (`role="status"`, `sr-only`), `#model-label`, `#ai-model-label`, `#ai-progress-bar`, `#ai-status-percent`, `#engine-cloud-text`, `#engine-cloud-key`; `#ai-download-progress` stands under the AI model's row in the fold; `#progress-bar` and `#ai-progress-bar` are `role="progressbar"`; `#download-numbers` and `#ai-progress-text` have no role.
- Behaviour, since the review: a model's download shows on its row (bar, percent and size) and is read out at its start and its end only; one that did not finish is said by the row's note in the colour of an error, with Retry, until another model is chosen or a download works; with the cloud engine and no key the notice in the main card warns and leads to the key field; from 1600 px beside the sidebar a tab is two columns of at most 900 px, in the order of the page (see "After the review of Task 6").
- Produces (markup, per the spec's table): `#panel-dictation` (Dictate with Hold / Toggle and the key, Paste last, Rewrite last, Microphone, Start and stop sounds; `details.fold[data-fold="dictation"]`: Free GPU key, Meeting key, Mute other apps, "Send it"); `#panel-ai` (switch and status, Style, Write in, Edit mode, Instructions for all apps, Rules per app; fold: AI model, Try it); `#panel-dictionary` (suggestions, words with search and add, replacements with search and add, Swiss spelling; fold: Words on screen, Learn from corrections, Import and export); `#panel-models` (Speech model with ✓ / Download and percent plus size, Language; fold: Engine and Groq key, GPU backend with detected GPUs, PC check, Free GPU for games, Unload when idle, Unused models); `#panel-general` (Display Language, Start with Windows, Keep history, "Stored on this PC" with Delete history; no fold). Every control id of 0.16.0 is kept.
- Produces (i18n): `advanced`, `hint_more`, `hint_less`, the `*_more` long texts, `dictate_label|hint`, `mode_label`, `model_note_*`, `cloud_note`, `dict_words_title`, `dict_io_label|hint`, `history_stored_label`; about 30 hints shortened to one line; the eight `model_*` option labels and four Recording keys removed. Since the review: `progress_said`, `download_started`, `download_done`, `home_output_warn`, `hint_more_about`, `hint_less_about`, `cloud_note_no_key`, `cloud_note_open`; `microphone_hint`, `meeting_hotkey_hint` and `ai_download_failed` removed.

- [ ] **Step 1: Merge stage 6**

```bash
cd $R && apply_stage $P/app_src_task5 $P/app_src_task6 src
git merge-file index.html $P/app_index_task5.html $P/app_index_task6.html
rm src/confirm-delete.ts src/replacements.ts         # stage 6 has them, nothing imports them yet: Task 7
cp $P/app/tests/unit/models.test.ts tests/unit/
git merge-file tools/ui-check/pages.mjs $P/tool5/pages.mjs $P/tool6/pages.mjs
```

Expected: `merged` for `i18n.ts`, `style.css`, `styles/components.css`; `CONFLICT` for `home.ts` (three places), `main.ts` (two places) and `ai-settings.ts` (one place), all below; `new` for `confirm-delete.ts`, `models.ts`, `replacements.ts`, `rows.ts`, `styles/settings.css`; no other conflict (rehearsed with the corrections of Tasks 3 to 5 in place, and again with Task 2's review fixes: `style.css` merges cleanly; for `styles/components.css` the stage's one line, `flex-wrap: wrap;` in `.setting-control`, is already there from Task 2's review, so the merge changes nothing and `git diff src/styles/components.css` stays empty). The two removed files are dead code in stage 6 (and `replacements.ts` uses two i18n keys that only stage 7 has, which the tool would report).

The six conflicts (rehearsed after the review of Task 5 on the repo as that review left it, with the resolutions below applied; the result type-checks, and Tasks 7 and 8 then merge with the conflicts they name and no other; `index.html`, `pages.mjs` and `i18n.ts` merge cleanly). They are listed in the order they stand in each file. Four of them, the first and the third in `home.ts` and both in `main.ts`, came with Task 5's own commit, which wrote the first run anew where the plan expected the prototype's:

- `src/home.ts`, the imports: our side has the lines for `./status.ts` and `./setup.ts`, the stage's side has its older two and the new import of `./models.ts`. Keep our two lines and add the stage's third:

```ts
import { type Status } from "./status.ts";
import { header, idleFor, meterMay, meterStep, modelStep, recommend, setup, sizeText, METER_SILENT_MS, type Gpu, type MeterNow, type Recommendation, type Setup } from "./setup.ts";
import { modelLabel, speechModel } from "./models.ts";
```

- `src/home.ts`, in `renderLoaded()`: our side has the comment `// The name alone: …`, the line with `speechModelName(speech.model).replace(/\s*\(.*$/, "")`, the comment `// A value is plain text. …` and the tone line `speechLine.dataset.tone = speech.load === "failed" || !speech.downloaded ? "warn" : "";`; the stage's side has its name line and the old tone line (with `"ok"`). Write the stage's name line and our tone line with its comment:

```ts
    speechLine.textContent = `${speechModel(speech.model).name} · ${state[speech.load]}`;
    // A value is plain text. Only what is missing or failed is tinted, in all three lines.
    speechLine.dataset.tone = speech.load === "failed" || !speech.downloaded ? "warn" : "";
```

  (`models.ts` has the name without the size, so the comment about the dropdown's size goes with the regular expression. The stage deletes `speechModelName` itself without a conflict.)
- `src/home.ts`, in `renderSetup()`: our side is the whole of steps 1 and 2 as Task 5 and its review wrote them (from `// 1. The microphone: …` to the `default:` case of the `switch`); the stage's side is the prototype's older two steps with two lines changed to `speechModel(…).name` and `modelLabel(…)`. Take our side whole. What the stage wants there is done in one place instead: the stage also deletes `speechModelName` (without a conflict), which our `modelNamed` reads, so write `modelNamed` with `models.ts` (and "Large v3 Turbo q8 · 870 MB" as the example in its comment):

```ts
function modelNamed(id: string, size: boolean): string {
  return whole(size ? modelLabel(id) : speechModel(id).name);
}
```

  The step's model then reads "Large v3 Turbo q8 · 870 MB", so in the `home` probe's first-run branch (`tools/ui-check/pages.mjs`) the two patterns with `\s\(~870\sMB\)` (the checks "named with its size" and "with the model and its size") become `\s·\s870\sMB`.
- `src/main.ts`, the imports: our side has `refreshSpeech` in the import of `./status-view` (Task 5 Step 2), the stage's side has its three new lines. Write:

```ts
import { currentSpeech, initStatus, onStatus, refreshSpeech, renderStatus } from "./status-view";
import { setup, sizeText } from "./setup.ts";
import { initHints, nameRows } from "./rows";
import { modelLabel, speechModel } from "./models.ts";
```

- `src/main.ts`, in `downloadCurrentModel()`: the stage hides the button where ours wrote the tick, and ours also sets `ok` (Task 5 Step 2). Write the stage's line and keep ours:

```ts
    downloadBtn.classList.add("hidden");
    ok = true;
```

- `src/ai-settings.ts`, in the listener of `ai-download-progress`: the stage writes the numbers with `progress_numbers`, Task 3's review had put `if (downloadInFlight)` before `setDownload("ai", percent);` on the next line. Take the stage's four lines for `progressText` (with their comment) and keep our guarded line with its comment:

```ts
    // Always the numbers: percent and size.
    progressText.textContent = total
      ? t("progress_numbers").replace("{percent}", String(Math.round(percent))).replace("{done}", sizeText(downloaded)).replace("{total}", sizeText(total))
      : `${Math.round(percent)} %`;
    // A progress event that arrives after the download ended must not bring it back into the status.
    if (downloadInFlight) setDownload("ai", percent);
```

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

`npx tsc --noEmit`, `npx vite build` clean; `npm run test:unit`: `tests 50` (+ models 2); after the review `tests 52` (models 3: which model a save stores while one downloads; setup 20: a download's numbers); after the re-review `tests 53` (setup 21: a failed download's sentence with its reason).

`node tools/ui-check/run.mjs --no-shots --task 6`: `17 findings, 17 known` (name 9: the rule rows, the replacement rows, the Files transcript; clipped 5: the rule-language selects, the Soundboard's device selects; hint-lines 3: the Soundboard), three stale entries (`name *`, `hint-lines *`, `select#*model-select`, all `"until": 6`); delete them (7 remain); exit 0. The run covers: every tab and every tab with Advanced open at three sizes in both languages; every hint on one line at 1600 px (two below); every control named; the `settings-models-advanced` probe (More opens the long hint in place, an open fold is remembered over a new start); the `shell` probe (the tab is remembered); and `roundtrip`: all 32 values shown, all 39 changes saved, among them every hotkey from its new place.

Since the review the run is `20 findings, 20 known (name 11, clipped 6, hint-lines 3: the three more are the rule rows' two names and the rule-language select, which Task 7 fixes, counted once more on the new page `settings-ai-download`; no entry was added to `allow.json`)`, exit 0, and it covers more. `settings-columns`: at every size, in both data sets and languages, every tab with its fold closed and open is one column of at most 1080 px below 1600 px beside the sidebar and two columns from there (also in a 1920x1080 window, which the page adds): the parts in the order of the page, each in its column, one left edge and one top edge, as wide as their column and at most 900 px, 16 px apart, the tab bar over the whole width, a fold's heading a bar as wide as its column, every hint one line; and once per run (English, 1600x900) the step is swept in a window that draws its scrollbar, one pixel below, at and above 1600 px at the heights where each form just fits and just does not, for all nine tab states: nothing changes by itself, the form follows the width alone, and the sweep has seen both forms with and without the scrollbar (decided on `clientWidth`, 54 of 108 sizes fail). `settings-keys`: the key boxes of the Dictation card and of its fold end on one right edge each, the × of a key that is not set keeps its room and is not shown, no key box stands under its label, Home's four key boxes share an edge; every "More" and the three Download buttons have a name that holds their word and follows the Display Language. `settings-models-cloud`: the notice warns, its button lands on the key field with the fold open and not remembered, the fold closes again after the visit, a fold the user opens is remembered, with a key the notice is plain. `settings-models-download` (populated: another model chosen in the dropdown; first run: Download pressed): the bar and "43 % · 32 MB of 75 MB" under the row, a `progressbar` named after the row with the numbers in words, no live region; a save meanwhile keeps the saved model; after the mock fails it the note names the model in the colour of an error, with Retry in the note or on the button, the settings keep their model and Home's step says the same; the next download starts at "0 %" without the failure or "Retry"; from its start to its end each live region of Settings is written at most twice and the sidebar's says no number; the failure survives a language change and goes with the next choice; the detected graphics cards follow the language. `settings-ai-download`: the same on the AI model's row inside Advanced, with the progress in view beside the control (also at 900×600), the percent beside the switch, both buttons "Retry", the failure still there after the AI's state was read again and said on Home.

Since the re-review the run is `23 findings, 23 known (name 13, clipped 7, hint-lines 3: the three more are again the rule rows' two names and the rule-language select, counted on the new page `settings-ai-failed`; no entry was added to `allow.json`)`, exit 0, in about 10 minutes (606 s; 699 s before, measured with `--times`). It covers more and looks at behaviour once (see "After the re-review of Task 6"). `settings-models-failed` and `settings-ai-failed`: the page's own checks on a download that failed (the note in the colour of an error with the backend's reason, Retry in the note or on the button, the AI's state line with the same sentence). `settings-models-download`, in the 1600x900 window: the failure's note, what a screen reader is told and Home's step end with the reason, and Home's step has the row's colour; the next choice and a change of the Display Language empty what a screen reader was told; a save in the moment after a failed download (the dropdown still on the model that failed) keeps the model that is on disk; of two choices in quick succession, a model that is there and then a missing one, the first one's save does not store the second, and after that one's download failed the settings and the dropdown are on a model that is on disk; a change of the Display Language while the dropdown's download runs shows no Download button. `settings-ai-download`: the reason on the model's row, beside the switch and on Home; Home's Retry after the sentence, named, starts the download again and rests with the keyboard focus while it runs. `settings-columns`: in two columns Tab goes down the left one and then down the right one on every tab, and AI cleanup holds with ten rules (the fold 16 px under the rules, both columns on one top edge).

Screenshots: `--pages "settings-*" --size 1600x900`, `--size 900x600`, and `--lang de --size 900x600`; compare with `mockups/settings.html` option 1 and the spec's table row by row. For the two columns add `--size 1920x1080` and `--size 2560x1392`.

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
- Produces (`src/arm.ts`, pure): `ArmEvent` (`{ type: "click", id } | { type: "cancel" }`), `ArmStep { armed, fire }`, `arm(armed, event)`: the first click arms, the second on the same id fires, a click on another id arms that one, cancel disarms. Since the review the rule keeps the time too: `ArmEvent` is `{ type: "click", id, at, count?, held? } | { type: "cancel" }`, `ArmState { armed, last, run }`, `ArmStep` = `ArmState` and `fire`, `AT_REST`, `arm(state, event)` (see "After the review of Task 7").
- Produces (`src/confirm-delete.ts`): `DeleteOptions { name?, label?, armedLabel? }`, `confirmDelete(button, id, onDelete, options)`, `deleteButton(id, onDelete, options)` (a `.btn-text` with `data-delete-id`, class `armed` while armed), `forgetDelete(id)`, `repaintDeletes()` (after a language change). A button is known by its id, not its element: a list redrawn while a button is armed gets it back armed. Since the review also `DeleteOptions.after` and `armedSaid`, `nameDelete(button, name)`, `disarmDelete(id)` and the error `FailureSaid`.
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

The conflict in `src/style.css` is the block under `/* ── AI cleanup ── */`, after the three `.ai-status[data-tone]` lines: the stage deletes it whole (`.link-btn` to `.pc-check-result`), Task 2's review had already deleted `.link-btn`, `.progress-track`, `.progress-fill` and `.field-textarea` from it and changed `.download-progress`. Our side holds `.ai-model-row`, `#download-progress, .download-progress`, `.rule-list`, `.rule-row`, `.rule-instructions` and `.pc-check-result`; the stage's side is empty. Take the stage's side: delete everything from `<<<<<<<` to `>>>>>>>` (in an editor, see the note on `sed -i` under "The prototype's measured state"); the next line is `.pc-check-result pre {`. Afterwards `diff --strip-trailing-cr $P/app_src_task7/style.css src/style.css` shows only Task 3's two `margin: 0;`, the `padding-bottom: var(--s3);` in `.ai-test` (Task 6's commit `9aa954f`: the room under the Try it box at the foot of its card) and the missing `.mt-sr-only` rule (`components.css` hides it together with `.sr-only`). With the block the review's room above a download's bar goes, so put it where the rule now lives: in `src/styles/settings.css`, `.download-progress` gets `padding: var(--s2) 0 var(--s3);` instead of `padding: 0 0 var(--s3);` (the stage's bar touches the dividing line of the row above it).

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

Correction 2, from the review of Task 4: a delete that fails must say so. `src/history.ts` merges without a conflict, and the stage's `deleteButton(…)` takes the place of `action(t("history_delete"), …)`, whose `action()` catches a failed action and writes "{action} failed" on its button. `deleteButton` runs the delete without anyone waiting for it, so a failure would be an unhandled rejection again. Write the block as (and import `repaintDeletes` with `confirmDelete` and `deleteButton`):

```ts
  const del = deleteButton(
    `history-${e.id}`,
    async () => {
      try {
        if (playing && item.contains(playing.btn)) stopPlayback();
        await invoke("history_delete", { id: e.id });
        await refreshHistory();
      } catch (err) {
        console.error("history_delete failed:", err);
        del.textContent = t("history_action_failed").replace("{action}", () => t("delete"));
        setTimeout(repaintDeletes, 2500);
      }
    },
    { name: e.text.slice(0, 40) },
  );
  actions.appendChild(del);
```

What else the review of Task 4 built into the rows holds without a change: Delete is still the row's last action (the gap before it is `.history-actions > :last-child` in `home.css`); after a delete `render()` puts the focus on the first action of the row that moved up; and the `home` probe's Delete from the keyboard presses Enter a second time when the first press only armed the button.

- [ ] **Step 3: Verify**

`npx tsc --noEmit`, `npx vite build` clean; `npm run test:unit`: `tests 57` (+ arm 4; 53 since the re-review of Task 6). The task's commit had 59 (arm 6), and after its review it is `tests 62` (arm 9).

`node tools/ui-check/run.mjs --no-shots --task 7`: `8 findings, 8 known` (clipped 3 and hint-lines 4 on the Soundboard, name 1 on the Files transcript), three stale entries (`*.rule-*`, `*.replacement-*`, `select.rule-language`, all `"until": 7`); delete them (4 remain); exit 0. The `settings-dictionary` probe checks: the first click on Delete only arms, Esc disarms, a click elsewhere disarms, the second click deletes; the suggestions are in the Display Language; the word search finds "Zürich" for "zurich"; the replacement search hides rows and a save while searching keeps the hidden ones; a replacement needs two clicks. `grep -rn "armedDelete\|armedTimer\|_delete_confirm\|replacement_remove" src` prints nothing.

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
- Modified by its re-review (see "After the re-review of Task 8"): `src/overlay.html`, `src/soundboard/board.ts`, `src/style.css`, `src/styles/tokens.css`, `components.css`, `home.css`, `settings.css`, `src-tauri/src/meeting/capture.rs` (comments), `tools/ui-check/run.mjs`, `inpage.js`, `pages.mjs`, `README.md`, `README.de.md`, `CHANGELOG.md`
- Modified by its review (see "After the review of Task 8"): `src/soundboard/board.ts`, `src/files.ts`, `src/i18n.ts`, `src/overlay.html`, `src/style.css`, `src/styles/tokens.css`, `components.css`, `shell.css`, `home.css`, `settings.css`, `tools/ui-check/static.mjs`, `run.mjs`, `inpage.js`, `mock.js`, `pages.mjs`

**Interfaces:**
- Consumes: `shell.ts` (`prefs`, `updatePrefs`), `confirm-delete.ts`, `rows.ts`.
- Produces (Files): title "Files" / "Dateien"; `#section-files.has-file` while a file is loaded (the drop zone becomes one line, the description hides); `#file-text` has a name (`files_transcript`); Language and Speakers sit in a `.card`.
- Produces (Soundboard, `mountBoard`): a bar `.sb-bar` (`[data-key="enabled"]` switch with its status line, always visible; Stop all; Pop out; `[data-key="settings"]` with `aria-expanded`, `aria-controls="sb-panel"`), the panel `#sb-panel.sb-col.sb-col-settings` (Others hear, You hear, Play over each other, Sound hotkeys with More, its toggle key with More, Stop all key with More, Devices, the Discord hint), then the library. Open by default only in the layout `"wide"` (content at least 900 px, the left column as today); closed by default in `"narrow"` and `"popout"`; the user's choice per layout is kept in `prefs.panels`. The missing-cable hint shows outside the panel. `.hint-more[data-own]` buttons are the board's own (it redraws; `rows.ts` leaves them alone).
- Produces (i18n): `sb_settings`, `sb_hotkey_more`, `sb_sound_hotkeys_more`; changed `files_title`, `sb_stop_hotkey_hint`, `sb_sound_hotkeys_hint`, `sb_toggle_hotkey_label`, `sb_toggle_hotkey_hint`, `sb_auto`, `sb_auto_none`.
- Motion: only `page-in` (a section becoming active) and `fold-in` (a fold opening), both `var(--ease)` = 150 ms ease-out; none with `prefers-reduced-motion`. State indicators (the pulse of a recording dot, a progress bar's width) are not motion in this sense and stay. Since the review the pill's two fades are `var(--ease)` too, and the tool's static `motion` rule holds every declaration to this (the lists `MOVES` and `SHOWS_STATE` in `static.mjs`).

- [ ] **Step 1: Merge the final stage**

```bash
cd $R && apply_stage $P/app_src_task7 $P/app/src src
git checkout -- src/overlay.html                     # Task 3 took the pill; the merge would only repeat or fight it
git merge-file index.html $P/app_index_task7.html $P/app/index.html
git merge-file tools/ui-check/pages.mjs $P/tool7/pages.mjs $P/tool8/pages.mjs
```

Expected: `merged` for `files.ts`, `i18n.ts`, `rows.ts`, `soundboard/board.ts`; `CONFLICT overlay.html` (undone by the checkout); `CONFLICT style.css` in one place, `#section-soundboard .sb-layout`: write `max-width: 880px;` (the stage's) and `margin: 0;` (Task 3's correction). Rehearsed again with Task 2's review fixes: this one conflict and no other; afterwards `diff --strip-trailing-cr $P/app/src/style.css src/style.css` shows only the two `margin: 0;` of Task 3, the `padding-bottom: var(--s3);` in `.ai-test` (Task 6's commit `9aa954f`) and the missing `.mt-sr-only` rule. `index.html` and `pages.mjs` merge cleanly (the pill entries Task 3 took from `tool8` are recognised as the same).

Three things from the review of Task 7 that this merge and the corrections below must keep (rehearsed on a scratch copy with the review's fixes in place: the two conflicts above and no other, and the result type-checks but for the `rememberPrefs` of correction 1):

- **The board swaps its rows in one go.** `src/confirm-delete.ts` knows a delete button by its id, and a list that is drawn again gives the armed button back armed and focused because the new row is in the page in the same turn as the old one leaves it (`root.replaceChildren(...build(state))` in `render()`, `box.replaceChildren()` and the appends after it in `fillList()`, all without an `await` between). A list that clears, awaits, then fills would lose the armed button (safe: it disarms), and after a delete it would send the keyboard focus to the `after` target ("Add sounds…", the "All" chip) although rows are left whose Delete should get it. The stage's settings panel and library must keep building their rows first and swapping them in afterwards; do not put an `await` between the clearing and the filling.
- **The deletes' probes use Soundboard selectors** that the stage's markup must keep, or `pages.mjs` must follow: `.sb-delete` (the armed page `soundboard-armed`, the rule "a sound", the pop-out's rule and its check at the start), `.sb-chip:nth-child(2)` (the first category's chip, pressed to show its Delete), `[data-delete-id^="category-"]`, `.sb-length` (the "elsewhere" a click disarms on in the pop-out) and, in `board.ts`, `[data-key="add"]` and `[data-key="chip-all"]` (where the focus goes after the last sound or a category). With the stage's panel closed by default in the pop-out the sounds must still show at its start, or `popout-deletes` opens nothing.
- **A failed delete of a sound or a category** goes through `failedDelete()` in `board.ts`, which says the reason in the board's notice and throws `FailureSaid`, so the button reads "Delete failed" like every other. The import `import { FailureSaid } from "../confirm-delete";` is a line of its own above `import { t } from "../i18n";`, away from the line the stage adds under `import { deleteButton } …` (joined with it, the merge conflicts there).

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

Correction 9 comes from the review of Task 6, which gave every "More" of Settings a name that says what it is about (`rows.ts`, `nameMore`: an `aria-label` from `hint_more_about` / `hint_less_about` and the row's label, "More about PC check"). `rows.ts` leaves `.hint-more[data-own]` alone, so the three the board draws itself would be the only buttons left that are named just "More".

9. `src/soundboard/board.ts`: where the board builds a `.hint-more[data-own]` button, give it the same name: `b.setAttribute("aria-label", t(open ? "hint_less_about" : "hint_more_about").replace("{label}", () => label));` with `label` the text of that row's `.label-text` and `open` the state the board keeps for it (it redraws, so the name is set with every draw). Check: in a German window `[...document.querySelectorAll(".hint-more")].every((b) => (b.getAttribute("aria-label") ?? "").length > b.textContent.length)` is true on the Soundboard with its panel open.

- [ ] **Step 3: Verify**

`npx tsc --noEmit`, `npx vite build` clean; `npm run test:unit`: `tests 62`.

`node tools/ui-check/run.mjs --no-shots --task 8`: `0 findings` and the line that 4 of 4 `allow.json` entries are past their task; set `tools/ui-check/allow.json` to `[]`; run again: `0 findings, 0 known, 0 new`, exit 0. (Measured on a scratch copy with every correction of this plan.) The run covers: the Soundboard probes (the panel is open only where it has its own column, the switch always shows, the first sound is on the first screen also at 900×600, the panel's state is remembered, the pop-out opens on the sounds with its settings closed); `files-loaded` and `files-result`; every pill probe.

After the review of Task 8 the same command covers 100 pages in 576 views (45 in 362 before): the 55 state pages, the pill's pages measured, the static `standard` and `motion` rules over every style sheet. Still `0 findings, 0 known, 0 new`, exit 0, `allow.json` `[]`; two full runs in a row gave the same; 977 s in the pages, 16 min 18 s by the clock. `tests 62`.

After the re-review of Task 8: 102 pages in 584 views (`pill-segments`, `measure`, `files-result` and `meetings-no-notes` also at 1920×1080, and every state page proves its state). Still `0 findings, 0 known, 0 new`, exit 0, `allow.json` `[]`, twice in a row the same; 1003 s in the pages, 16 min 45 s by the clock. `tests 62`.

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

`npx tsc --noEmit`, `npx vite build`, `npm run test:unit` (62), `node tools/ui-check/run.mjs --no-shots --task 9` (0 findings, `allow.json` is `[]`). `git status --short` shows only the three docs and the deletion.

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

- [ ] **1. The full `ui-check`, with screenshots:** `node tools/ui-check/run.mjs` with `tools/ui-check/allow.json` equal to `[]`. Expected: exit 0, `0 findings, 0 known (allow.json), 0 new`, 1236 screenshots of 111 pages in 618 views (since wave 1 of the whole-branch review; 1152 of 100 pages in 576 views before the re-review of Task 8 and that wave; both data sets, both languages, 2560×1392, 1600×900, 900×600, Home and the Soundboard also at 1200×800, Files, Meetings, the Soundboard and the Settings columns also at 1920×1080, the pop-out at 460×680, the pill at 320×64; 428 of them from the 55 state pages of the review of Task 8, which are opened at 900×600 and 1600×900 with the data of a PC in daily use). Allow 25 minutes: without screenshots the run takes 16 and a half, and a screenshot pair adds about 0.6 s a view (measured on the state pages). Look at Home, the first run, each Settings tab (also with Advanced open, and in two columns at 1920×1080 and 2560×1392), Files with a result, Meetings open and recording, the Soundboard with its panel open and closed, the pop-out, in both languages at 1600×900 and 900×600, against the four mockups; and at the state pages (a key box that listens and one that refuses on a tile, in the panel, in Settings, on Home and in the first run; the board's hard states; a meeting's warnings, dialogs and hint rows; a file's run, errors and summary; the PC check; the pill's chip and labels).
- [ ] **2. The unit tests and the frontend build:** `npm run test:unit` (74 pass since wave 1 of the whole-branch review), `npx tsc --noEmit`, `npx vite build`.
- [ ] **3a. Not yet run anywhere: the library's new tests.** On the PC where Task 3 was built, Windows Smart App Control refused to start the library's test binary (os error 4551), so `--lib meter` and `--lib the_load_state` (four tests: `the_meter_level_is_zero_for_silence_and_capped_for_loud`, `a_meter_that_is_not_running_stops_quietly`, `the_loudest_meter_level_wins_as_bits`, `the_load_state_follows_loads_and_unloads`) only compile there; the three `--bins` tests ran and pass. Run the two `--lib` commands on a PC that lets the binary start (the PC that makes the release build) before the release. The policy is not to be changed or worked around.
- [ ] **3. The Rust tests, filtered:** the five commands of Task 3 Step 3, `<RUST-ENV> cargo test --no-default-features --bins hotkey`, and `<RUST-ENV> cargo test --no-default-features --bins meter` (two tests; the second, `a_meter_stopped_right_after_its_start_stays_stopped`, came with the review of Task 5 and its fix of the meter's order, commit `e457ac7`) (see Build environment note). On 2026-10-07 Smart App Control refused the freshly built `--bins` test binary once (os error 4551) and let the same command run a while later (2 passed); a refusal is waited out or the tests are run on another PC, never worked around.
- [ ] **4. Against the real app** (the spec's list). This needs a test instance, which takes the keyboard focus when it starts and writes into the installed app's `startup.log`: the controller tells the user first, starts it only when the user is not typing, with its own data folder (`RUDARIFLOW_DATA_DIR`), and stops it right after. Never the installed app or its data.
  - [ ] The sidebar in the real WebView2 window at 900×600: five items, Settings, version and credit visible (the audit's one finding that Chromium cannot settle).
  - [ ] Settings round trip: change every moved setting once (each tab, each Advanced fold, the quick switches on Home), quit, start: `config.json` holds the same keys as before and every control shows its saved value.
  - [ ] A model's download in Settings (review of Task 6): choose a speech model that is not there on Models & GPU and an AI model that is not there under AI cleanup › Advanced: the bar and percent with size show on the model's row; pull the network: the row's note names the model in the colour of an error with Retry and ends with the reason the backend gave, `config.json` keeps the old speech model, and Retry resumes. With NVDA or Narrator: the start and the end are said once, no percent is read out by itself, and the bar answers with percent and size when it is asked.
  - [ ] Hotkey capture from Home and from Settings › Dictation: both places show the new key at once; Esc cancels; a conflict is explained; a mouse side button works.
  - [ ] First run with an empty data folder: Home shows the steps, the level bar moves, the recommended model downloads with percent and size, the status goes from "Setup needed: no speech model" over "Downloading n %" and "Loading models…" to "Ready", Home switches to the daily view. Before the download, a press of the dictation key shows the no-model notice in the pill and records nothing.
  - [ ] The status in real use: Recording, Transcribing, a meeting's marker during a dictation, a file, Free GPU ("GPU freed"), a game (if one is at hand), idle unload followed by a change in Settings (must not rest on "Loading models…", Task 3 Step 2).
  - [ ] The pill and the tray menu after switching the Display Language (no restart).
  - [ ] Wave 1 of the whole-branch review, what Chromium with a mocked backend cannot settle: with a history and the only microphone unplugged, the window opens where it was left and Home shows the steps with the recent dictations under them (copy one); the start on a cold PC (no English in a German window, no empty key box, no daily view before the steps on an empty data folder); a click on a setting in the first second after the start changes nothing in `config.json`; a save that fails (make `config.json` read-only for a moment) shows "Could not save: …" and the control goes back; a Windows contrast theme, dark and light (Settings › Accessibility › Contrast themes): every switch, the open tab, the current page, a chosen chip and a playing sound show; NVDA or Narrator: a page's title is announced as heading level 1, the Soundboard's switches as switches, the end of a file's transcription once.
  - [ ] The Soundboard pop-out: opens on the sounds, "Soundboard settings" opens the panel, its state survives closing and opening; the main window's remembered tab is not undone by it.
  - [ ] The first run's microphone, which the review of Task 5 could not settle without the real window (watch the Windows microphone indicator in the taskbar; the steps show, a microphone is plugged in):
    1. Close the window to the tray with the steps showing: the indicator goes off at once and is still off after 10 s and after 130 s.
    2. Minimise the window: off within 3 s.
    3. Back from the tray, from the taskbar and by Alt+Tab: the level returns on the first interaction (the focus, a move of the pointer, a key), without a click.
    4. Log in with autostart (`--start-minimized`) while the setup is needed: the indicator never comes on.
    5. Another window in front for over 3 minutes, Win+L for over 3 minutes, sleep and wake: the indicator goes off (at the latest 60 s + 120 s after the last touch) and stays off until the user touches the window; step 1 reads "The level shows while you use this window." meanwhile.
    6. Change the microphone in the step with two devices connected and tap each: the bar is the chosen one's. With a Bluetooth headset: does the playback quality drop while the steps show (the headset switching to its hands-free profile)?
    7. The level while a dictation is tried, while a meeting records and while the Soundboard's virtual microphone is on: all of them go on working, and so does the level.
    8. A real download from step 2: the status never returns to "Setup needed" after "Downloading", also when Download is double-clicked. Pull the network: the step says that the download of the model (name and size) did not finish, and Retry resumes from the partial file; then the daily view.
    9. How long "Looking at this PC's graphics card…" shows on a cold start (after 5 s the step offers the model that fits every PC; the answer still replaces it while nothing was started).
    10. NVDA or Narrator through the steps: the marks ("Done", "To do", "Needs attention"), the level (`role="meter"`) and its resting line, the progress bar with percent and size, the names of the two Download and the two Change buttons.
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
