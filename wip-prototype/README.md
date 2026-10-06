# UI redesign — planner's scratch prototype (WIP, never merge)

Saved on 2026-10-07 when work was halted on the home PC to continue on another PC.
This is the scratch work of the planning agent that was writing
`docs/superpowers/plans/2026-10-06-ui-redesign.md` (the plan document itself was NOT written yet).
The agent had prototyped the redesign task by task in a scratch copy to compile-check the plan's code.

Contents (as left when stopped; not reviewed, not guaranteed to build):
- `tool/`, `tool3/` … `tool8/` — the headless ui-check tool at successive plan tasks (`run.mjs`, mock backend, checks);
  `tool8/` is the newest. Originated from the audit harness (mock `__TAURI_INTERNALS__`, screenshots, probes).
- `app/`, `app_src_task3|5|6|7/`, `app_index_task*.html` — the frontend (`src/`, `index.html`) as the plan's tasks 3–7 would leave it.
- `rs/src-tauri/src/` — the Rust sources with the small backend additions of task 3 (status command/event, no-model notice, tray/pill language).
- `*.py`, `*.keep`, `home_section.html`, `settings_section.html` — the agent's patch scripts and kept fragments.

How to use: read `HANDOFF.md` on branch `feature/ui-redesign` first. Treat this as reference material for
writing the plan (or as a head start for the implementers) — the spec is binding, this prototype is not.
