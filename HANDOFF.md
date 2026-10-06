# Handoff: UI redesign (0.17.0) — halted 2026-10-07, to resume on another PC

Delete this file when the redesign is merged.

## Where we are

- **Released:** 0.16.0 (main, PR #16): Meetings, Free GPU for games, idle unload, unused models, Whisper q5.
- **This branch (`feature/ui-redesign`, from main 84447e5):** only documents so far.
  - Spec (approved by the user): `docs/superpowers/specs/2026-10-06-ui-redesign-design.md`
  - Audit of 0.16.0 it is based on: `docs/superpowers/specs/2026-10-06-ui-audit.md`
  - The mockups the user chose from: `docs/superpowers/specs/2026-10-06-ui-redesign-mockups/`
- **Not written yet:** the implementation plan `docs/superpowers/plans/2026-10-06-ui-redesign.md`. The planning agent was stopped mid-work.
  Its scratch prototype (the redesign prototyped through about task 7–8, plus the headless `ui-check` tool) is saved on branch
  **`wip/ui-redesign-prototype`** in `wip-prototype/` (reference only, never merge; see its README).
- **No app code has changed on this branch.**

## What the user decided

- Goal: as easy and *übersichtlich* as possible, for a newcomer and a power user alike.
- Navigation **C**: Home · Files · Meetings · Soundboard · Settings; Home is the dictation page.
- Home **layout 2**: two columns on wide windows (hotkeys, quick switches, "what's loaded" left; recent dictations with search right).
- Settings **1**: five tabs along the top (Dictation, AI cleanup, Dictionary, Models & GPU, General), each with an Advanced fold; one-line hints with "More".
- Look **B**: calm and airy dark (bigger type, more room, softer surfaces). No light theme in this round.
- Interface only: no feature changes, no `config.json` key lost or renamed.
- **Process: the full process** — plan, then one task at a time, each with its own review and fix round, then a whole-branch review. (The user declined the faster "lean" option.) Ships as 0.17.0 after the user's try-out.

## Next steps

1. Write the implementation plan (`docs/superpowers/plans/2026-10-06-ui-redesign.md`) from the spec, following the house format of
   `docs/superpowers/plans/2026-10-03-meeting-mode.md`. Planned task split: (1) bring the `ui-check` tool into the repo as `tools/ui-check/`
   (headless render with a mocked Tauri backend; fails on overflow, clipped text, contrast < 4.5:1, unnamed or unreachable controls, the sidebar
   not fitting at 900×600, missing EN/DE keys); (2) design tokens + shared components + bundled font; (3) shell: five-item sidebar, routing,
   the status model + small backend additions (speech model available/loaded, no-model pill notice, tray + pill language);
   (4) Home; (5) first-run setup; (6) Settings with five tabs; (7) Dictionary tab + unified lists and delete pattern;
   (8) tool pages (Files, Meetings touch-ups, Soundboard settings panel) + German overflow fixes; (9) docs + final checks.
   The prototype on `wip/ui-redesign-prototype` can be mined for code and for the tool.
2. Build task by task (subagent-driven development: implementer → reviewer → fix round → re-review), then a final whole-branch review and one fix wave.
3. Check against the real app, the user's try-out on an installed build, then version 0.17.0, PR, merge, GitHub release.

## Rules that apply to this repo (learned the hard way)

- **Rust tests only filtered:** `cargo test --no-default-features --lib <filter>` / `--bins <filter>`. Never the unfiltered suite: `paste.rs` tests overwrite the system clipboard.
- **Commit format:** `feat:`/`fix:`/`docs:`/`test:`/`build:` subject, an empty line, then exactly
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` (use `git commit -F -` with a heredoc).
- **All UI strings in English and German** (`src/i18n.ts`).
- **A test instance takes the keyboard focus when it starts** and writes into the installed app's `startup.log`: tell the user before starting one; never start it while they type. Never touch the installed app or its data without asking.
- **Release builds:** a fresh target dir of ≤ 4 characters (long paths), `CUDAARCHS=75;80;86;89;120`, `GGML_NATIVE=OFF` (already in `src-tauri/.cargo/config.toml`); verify zero `zmm` instructions with `dumpbin /disasm`. `npm run tauri build` rewrites `src-tauri/Cargo.toml` line endings: `git checkout` it afterwards.
- The build toolchain (Rust, VS Build Tools, CMake, LLVM, Vulkan SDK, CUDA 13.4, Node) must exist on the PC that builds; the README's build section and `scripts/setup-*.ps1` describe it. Frontend-only work (TypeScript, CSS, the `ui-check` tool) needs just Node.
- The untracked `android/` folder on the home PC belongs to the parked branch `feature/android-voice-keyboard` (not pushed yet; ask the user before relying on it).

## How to resume

Open the repo on the other PC, `git fetch`, check out `feature/ui-redesign`, and tell Claude:
"Read HANDOFF.md and continue the UI redesign with the full process."
