// The Soundboard: sounds on hotkeys, played into the virtual microphone.
// One component for the tab (index.html) and the pop-out window
// (soundboard.html). The library, playback and settings live in the
// backend; both views render from `soundboard_state` and follow its events.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { t } from "../i18n";
import { hotkeyLabel, startCapture } from "../hotkey-capture";
import {
  api,
  EXTENSIONS,
  type AddResult,
  type BoardState,
  type DeviceChoices,
  type Devices,
  type PlayingVoice,
  type Problem,
  type Sound,
  type Status,
} from "./api";

const CABLE_URL = "https://vb-audio.com/Cable/";
/** Set once the Discord hint was dismissed (a per-PC convenience). */
const HINT_KEY = "rudariflow-soundboard-hint-seen";

const PLAY_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 2.2v7.6L9.8 6z" fill="currentColor"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor"/></svg>';
const X_ICON =
  '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const LOOP_ICON =
  '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M1.8 5.6V5a2 2 0 0 1 2-2h5.7M8.2 1.5L9.7 3 8.2 4.5M10.2 6.4V7a2 2 0 0 1-2 2H2.5M3.8 7.5L2.3 9l1.5 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PEN_ICON =
  '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 9.5l.6-2.3 5-5 1.7 1.7-5 5z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>';

export interface BoardOptions {
  /** The pop-out window: an Always on top switch instead of Pop out. */
  popOut: boolean;
}

export interface BoardView {
  /** Load the state again and redraw (also after a language change). */
  refresh(): Promise<void>;
  /** The tab is shown: files dropped on the window are added. */
  setActive(active: boolean): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className: string, text: string, key: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", className, text);
  b.type = "button";
  b.dataset.key = key;
  b.addEventListener("click", onClick);
  return b;
}

function iconButton(icon: string, label: string, key: string, onClick: () => void): HTMLButtonElement {
  const b = button("icon-btn", "", key, onClick);
  b.innerHTML = icon;
  b.title = label;
  b.setAttribute("aria-label", label);
  return b;
}

function option(value: string, label: string): HTMLOptionElement {
  const o = el("option", "", label);
  o.value = value;
  return o;
}

/** "0:02", "12:40". */
function clock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function problemText(p: Problem): string {
  return t(`sb_err_${p.reason}`)
    .replace("{device}", t(`sb_dev_${p.device}`))
    .replace("{name}", p.name)
    .replace("{detail}", p.detail);
}

function statusText(s: Status): string {
  if (s.state === "on") return t("sb_status_on").replace("{cable}", s.cable);
  if (s.state === "error") return problemText(s.problem);
  return t("sb_status_off");
}

/** A backend reason ("too_long", "disk: …") in words; unknown ones as they are. */
function reasonText(error: string): string {
  const [code, ...rest] = error.split(": ");
  const key = `sb_reason_${code}`;
  const text = t(key);
  return text === key ? error : text.replace("{detail}", rest.join(": "));
}

function hintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

function setHintSeen() {
  try {
    localStorage.setItem(HINT_KEY, "1");
  } catch {
    // The hint shows again next time.
  }
}

export function mountBoard(root: HTMLElement, options: BoardOptions): BoardView {
  let state: BoardState | null = null;
  let devices: DeviceChoices | null = null;
  let active = options.popOut;
  let query = "";
  /** The category chip that filters the list; "" = All. */
  let category = "";
  let devicesOpen = false;
  /** Rename fields and hotkey captures open: redraws wait until they close. */
  let editing = 0;
  let pending = false;
  /** The virtual microphone switch is being changed: it stays disabled across redraws. */
  let switching = false;
  /** Newest refresh started / applied (an older answer is dropped). */
  let refreshSeq = 0;
  let appliedSeq = 0;
  let notice = { text: "", tone: "" };
  let armedDelete: string | null = null;
  let armedTimer: number | undefined;
  let listBox: HTMLElement | null = null;
  root.classList.add("sb");

  async function refresh() {
    const seq = ++refreshSeq;
    const fresh = await api.state();
    if (!devices) devices = await api.devices().catch(() => null);
    // A newer refresh already drew; this answer is older.
    if (seq < appliedSeq) return;
    appliedSeq = seq;
    state = fresh;
    render();
  }

  function render() {
    if (editing > 0) {
      pending = true;
      return;
    }
    pending = false;
    if (!state) return;
    if (category && !state.board.categories.some((c) => c.id === category)) category = "";
    const focused = document.activeElement as HTMLElement | null;
    const focusKey = focused && root.contains(focused) ? focused.dataset.key : undefined;
    const caret = focused instanceof HTMLInputElement && focused.type === "text" ? focused.selectionStart : null;
    root.replaceChildren(...build(state));
    if (focusKey) {
      const again = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`);
      again?.focus();
      if (again instanceof HTMLInputElement && again.type === "text" && caret !== null) again.setSelectionRange(caret, caret);
    }
    showPlaying(state.playing);
  }

  function setNotice(text: string, tone = "") {
    notice = { text, tone };
    render();
  }

  /** A command failed: say so in the notice line, and redraw from the backend's state. */
  function fail(e: unknown) {
    console.error("soundboard command failed:", e);
    setNotice(reasonText(String(e)), "error");
    void refresh().catch(console.error);
  }

  function build(s: BoardState): HTMLElement[] {
    if (!options.popOut && s.board.window.poppedOut) return [popped()];
    listBox = el("div", "sb-list");
    fillList(listBox, s);
    const parts = [top(s), devicesBox(s), ...hints(s), toolbar(), chips(s)];
    if (notice.text) {
      const line = el("p", "sb-notice", notice.text);
      line.dataset.tone = notice.tone;
      line.setAttribute("role", "status");
      parts.push(line);
    }
    parts.push(listBox);
    return parts;
  }

  function row(label: string, hint: string, ...controls: HTMLElement[]): HTMLElement {
    const r = el("div", "setting-row");
    const l = el("div", "setting-label");
    l.append(el("span", "label-text", label));
    if (hint) l.append(el("span", "label-hint", hint));
    const c = el("div", "setting-control sb-control");
    c.append(...controls);
    r.append(l, c);
    return r;
  }

  function toggle(key: string, label: string, checked: boolean, onChange: (on: boolean, input: HTMLInputElement) => void): HTMLElement {
    const wrap = el("label", "switch");
    const input = el("input");
    input.type = "checkbox";
    input.checked = checked;
    input.dataset.key = key;
    input.setAttribute("aria-label", label);
    input.addEventListener("change", () => onChange(input.checked, input));
    wrap.append(input, el("span", "switch-slider"));
    return wrap;
  }

  function slider(key: string, label: string, value: number, onChange: (value: number) => void): HTMLElement {
    const wrap = el("div", "sb-slider");
    const input = el("input");
    input.type = "range";
    input.min = "0";
    input.max = "100";
    input.value = String(Math.round(value * 100));
    input.dataset.key = key;
    input.setAttribute("aria-label", label);
    const shown = el("span", "sb-slider-value", `${input.value} %`);
    input.addEventListener("input", () => (shown.textContent = `${input.value} %`));
    input.addEventListener("change", () => onChange(Number(input.value) / 100));
    wrap.append(input, shown);
    return wrap;
  }

  /** `off`: a sound's hotkey while the sound hotkeys are switched off (shown dimmed). */
  function hotkeyControl(key: string, current: string, taken: boolean, save: (combo: string) => Promise<unknown>, off = false): HTMLElement {
    const wrap = el("div", `hotkey-control sb-hotkey${off ? " off" : ""}`);
    const kbd = el("kbd", "", hotkeyLabel(current));
    const btn = button("hotkey-btn", "", key, () => {
      const started = startCapture({
        button: btn,
        text: kbd,
        allowBare: true,
        apply: async (combo) => {
          await save(combo);
          current = combo;
        },
        render: () => (kbd.textContent = hotkeyLabel(current)),
        done: () => {
          editing--;
          if (pending) render();
        },
      });
      if (started) editing++;
    });
    btn.append(kbd);
    btn.setAttribute("aria-label", `${t("sb_hotkey")}: ${hotkeyLabel(current)}${off && current ? ` (${t("sb_sound_hotkeys_off_note")})` : ""}`);
    if (off && current) btn.title = t("sb_sound_hotkeys_off_note");
    wrap.append(btn);
    if (current) wrap.append(iconButton(X_ICON, t("paste_last_clear"), `${key}-clear`, () => void save("").catch(fail)));
    if (taken) wrap.append(el("span", "sb-note", t("sb_hotkey_elsewhere")));
    return wrap;
  }

  function top(s: BoardState): HTMLElement {
    const b = s.board;
    const list = el("div", "settings-list sb-top");
    const onSwitch = toggle("enabled", t("sb_switch_label"), s.status.state === "on", async (wanted, input) => {
      if (switching) return;
      switching = true;
      input.disabled = true;
      try {
        const status = await api.setEnabled(wanted);
        if (state) state.status = status;
      } catch (e) {
        console.error("soundboard_set_enabled failed:", e);
        notice = { text: reasonText(String(e)), tone: "error" };
      }
      switching = false;
      render();
    });
    onSwitch.querySelector("input")!.disabled = switching;
    const switchRow = row(t("sb_switch_label"), t("sb_switch_hint"), onSwitch);
    const status = el("span", "label-hint sb-status", statusText(s.status));
    status.dataset.tone = s.status.state;
    switchRow.querySelector(".setting-label")?.append(status);
    list.append(
      switchRow,
      row(t("sb_others_label"), t("sb_others_hint"), slider("others", t("sb_others_label"), b.othersVolume, (v) => void api.setVolumes(v, b.meVolume).catch(fail))),
      row(t("sb_me_label"), t("sb_me_hint"), slider("me", t("sb_me_label"), b.meVolume, (v) => void api.setVolumes(b.othersVolume, v).catch(fail))),
      row(t("sb_layer_label"), t("sb_layer_hint"), toggle("layer", t("sb_layer_label"), b.layer, (on) => void api.setLayer(on).catch(fail))),
      row(
        t("sb_stop_hotkey_label"),
        t("sb_stop_hotkey_hint"),
        hotkeyControl("stop-hotkey", b.stopHotkey, s.hotkeysTaken.includes("stopSounds"), (combo) => api.setStopHotkey(combo)),
      ),
      row(
        t("sb_sound_hotkeys_label"),
        t("sb_sound_hotkeys_hint"),
        toggle("sound-hotkeys", t("sb_sound_hotkeys_label"), b.soundHotkeys, (on) => void api.setSoundHotkeys(on).catch(fail)),
      ),
      row(
        t("sb_toggle_hotkey_label"),
        t("sb_toggle_hotkey_hint"),
        hotkeyControl("toggle-hotkey", b.toggleHotkey, s.hotkeysTaken.includes("toggleSoundHotkeys"), (combo) => api.setToggleHotkey(combo)),
      ),
    );
    if (options.popOut) {
      list.append(row(t("sb_always_on_top"), "", toggle("on-top", t("sb_always_on_top"), b.window.alwaysOnTop, (on) => void api.setAlwaysOnTop(on).catch(fail))));
    }
    return list;
  }

  function devicesBox(s: BoardState): HTMLElement {
    const box = el("details", "sb-devices");
    box.open = devicesOpen;
    const summary = el("summary", "", t("sb_devices"));
    summary.dataset.key = "devices";
    box.append(summary);
    box.addEventListener("toggle", () => {
      // A redraw makes a new, already open element: not a user's toggle.
      if (box.open === devicesOpen) return;
      devicesOpen = box.open;
      if (devicesOpen) {
        api
          .devices()
          .then((d) => {
            devices = d;
            render();
          })
          .catch(console.error);
      }
    });
    const list = el("div", "settings-list");
    const pick = (kind: keyof Devices, label: string) => {
      const select = el("select");
      select.dataset.key = `device-${kind}`;
      select.setAttribute("aria-label", label);
      const saved = s.board.devices[kind];
      const names = (kind === "microphone" ? devices?.inputs : devices?.outputs) ?? [];
      const auto = devices?.automatic[kind];
      select.append(option("", auto ? t("sb_auto").replace("{name}", auto) : t("sb_auto_none")));
      for (const name of names) select.append(option(name, name));
      if (saved && !names.includes(saved)) select.append(option(saved, `${saved} (${t("mic_not_connected")})`));
      select.value = saved;
      select.addEventListener("change", () => {
        void api.setDevices({ ...s.board.devices, [kind]: select.value }).catch(fail);
      });
      return row(label, "", select);
    };
    list.append(pick("microphone", t("sb_dev_microphone")), pick("cable", t("sb_dev_cable")), pick("headphones", t("sb_dev_headphones")));
    box.append(list);
    return box;
  }

  function hints(s: BoardState): HTMLElement[] {
    const noCable = devices !== null && !devices.automatic.cable && !s.board.devices.cable;
    const box = el("div", "sb-hint");
    if (noCable) {
      box.append(
        el("p", "", t("sb_cable_missing")),
        button("btn-secondary", t("sb_cable_link"), "cable-link", () => void openExternal(CABLE_URL).catch(console.error)),
        el("p", "", t("sb_discord_hint")),
      );
      return [box];
    }
    if (hintSeen()) return [];
    box.append(
      el("p", "", t("sb_discord_hint")),
      button("btn-ghost", t("sb_hint_dismiss"), "hint-dismiss", () => {
        setHintSeen();
        render();
      }),
    );
    return [box];
  }

  function toolbar(): HTMLElement {
    const bar = el("div", "sb-toolbar");
    const search = el("input", "sb-search");
    search.type = "text";
    search.value = query;
    search.placeholder = t("sb_search");
    search.dataset.key = "search";
    search.setAttribute("aria-label", t("sb_search"));
    search.addEventListener("input", () => {
      query = search.value;
      if (state && listBox) {
        fillList(listBox, state);
        showPlaying(state.playing);
      }
    });
    bar.append(
      button("btn-secondary", t("sb_add"), "add", () => void chooseFiles()),
      search,
      button("btn-secondary", t("sb_stop_all"), "stop-all", () => void api.stopAll().catch(fail)),
    );
    if (!options.popOut) bar.append(button("btn-secondary", t("sb_pop_out"), "pop-out", () => void api.popOut(true).catch(fail)));
    return bar;
  }

  function chips(s: BoardState): HTMLElement {
    const bar = el("div", "sb-chips");
    const chip = (label: string, id: string) => {
      const c = button("speaker-chip sb-chip", label, `chip-${id || "all"}`, () => {
        category = id;
        render();
      });
      c.setAttribute("aria-pressed", String(category === id));
      return c;
    };
    bar.append(chip(t("sb_all"), ""));
    for (const c of s.board.categories) {
      bar.append(chip(c.name, c.id));
      if (category === c.id) {
        const rename = iconButton(PEN_ICON, t("sb_category_rename"), `chip-${c.id}-rename`, () =>
          inlineEdit(rename, c.name, t("sb_category_placeholder"), (name) => api.categoryRename(c.id, name)),
        );
        const remove = iconButton(X_ICON, t("sb_category_delete"), `chip-${c.id}-delete`, () => {
          api.categoryRemove(c.id).catch((e) => setNotice(reasonText(String(e)), "error"));
        });
        bar.append(rename, remove);
      }
    }
    const add = button("speaker-chip sb-chip", t("sb_new_category"), "chip-new", () =>
      inlineEdit(add, "", t("sb_category_placeholder"), async (name) => {
        category = await api.categoryAdd(name);
      }),
    );
    bar.append(add);
    return bar;
  }

  /** Put a text field where `anchor` is; Enter or leaving it saves, Escape cancels. */
  function inlineEdit(anchor: HTMLElement, value: string, placeholder: string, commit: (value: string) => Promise<unknown>) {
    const input = el("input", "speaker-chip-input");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    input.setAttribute("aria-label", placeholder);
    // After the redraw, focus goes back to the control this field replaced.
    input.dataset.key = anchor.dataset.key ?? "";
    editing++;
    let over = false;
    const finish = async (save: boolean) => {
      if (over) return;
      over = true;
      const text = input.value.trim();
      if (save && text && text !== value) {
        try {
          await commit(text);
        } catch (e) {
          notice = { text: reasonText(String(e)), tone: "error" };
        }
      }
      editing--;
      render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void finish(true);
      else if (e.key === "Escape") void finish(false);
    });
    input.addEventListener("blur", () => void finish(true));
    anchor.replaceWith(input);
    input.focus();
    input.select();
  }

  function fillList(box: HTMLElement, s: BoardState) {
    box.replaceChildren();
    if (s.board.sounds.length === 0) {
      box.append(el("p", "empty-state", t("sb_empty")));
      return;
    }
    const q = query.trim().toLowerCase();
    const shown = s.board.sounds.filter((x) => (!category || x.category === category) && (!q || x.name.toLowerCase().includes(q)));
    if (shown.length === 0) box.append(el("p", "empty-state", t("sb_empty_filter")));
    for (const sound of shown) box.append(soundRow(sound, s));
  }

  function soundRow(sound: Sound, s: BoardState): HTMLElement {
    const on = s.status.state === "on";
    const missing = s.missing.includes(sound.id);
    const r = el("div", "sb-row");
    r.dataset.id = sound.id;
    r.dataset.name = sound.name;

    const play = button("sb-play", "", `${sound.id}-play`, () => {
      api.play(sound.id).catch((e) => setNotice(`${sound.name}: ${reasonText(String(e))}`, "error"));
    });
    play.innerHTML = PLAY_ICON;
    play.dataset.icon = "play";
    play.disabled = !on || missing;
    play.title = !on ? t("sb_play_off_hint") : missing ? t("sb_missing") : t("sb_play");
    play.setAttribute("aria-label", `${t("sb_play")}: ${sound.name}`);

    const main = el("div", "sb-main");
    const name = button("sb-name", sound.name, `${sound.id}-name`, () =>
      inlineEdit(name, sound.name, t("sb_rename_placeholder"), (v) => api.rename(sound.id, v)),
    );
    name.title = t("sb_rename_hint");
    const progress = el("div", "sb-progress");
    progress.append(el("div", "sb-progress-fill"));
    main.append(name, progress);
    if (missing) main.append(el("span", "sb-note", t("sb_missing")));

    const side = el("div", "sb-side");
    side.append(loopButton(sound), el("span", "sb-length", clock(sound.durationMs)), deleteButton(sound));

    const controls = el("div", "sb-controls");
    const cat = el("select", "sb-category");
    cat.dataset.key = `${sound.id}-category`;
    cat.setAttribute("aria-label", `${t("sb_category")}: ${sound.name}`);
    cat.append(option("", t("sb_no_category")), ...s.board.categories.map((c) => option(c.id, c.name)));
    cat.value = sound.category;
    cat.addEventListener("change", () => void api.setCategory(sound.id, cat.value).catch(fail));
    controls.append(
      cat,
      hotkeyControl(
        `${sound.id}-hotkey`,
        sound.hotkey,
        s.hotkeysTaken.includes(sound.id),
        (combo) => api.setHotkey(sound.id, combo),
        !s.board.soundHotkeys,
      ),
      slider(`${sound.id}-volume`, `${t("sb_volume")}: ${sound.name}`, sound.volume, (v) => void api.setSoundVolume(sound.id, v).catch(fail)),
    );
    r.append(play, main, side, controls);
    return r;
  }

  /** Loop on/off: a looping sound repeats until it is stopped. */
  function loopButton(sound: Sound): HTMLElement {
    const b = iconButton(LOOP_ICON, `${t("sb_loop")}: ${sound.name}`, `${sound.id}-loop`, () => {
      void api.setSoundLoop(sound.id, !sound.loop).catch(fail);
    });
    b.classList.add("sb-loop");
    b.title = t("sb_loop_hint");
    b.setAttribute("aria-pressed", String(sound.loop));
    return b;
  }

  function deleteButton(sound: Sound): HTMLElement {
    const armed = armedDelete === sound.id;
    const label = t(armed ? "sb_delete_confirm" : "sb_delete");
    const b = button(`btn-ghost sb-delete${armed ? " armed" : ""}`, label, `${sound.id}-delete`, () => {
      window.clearTimeout(armedTimer);
      if (armedDelete !== sound.id) {
        armedDelete = sound.id;
        armedTimer = window.setTimeout(() => {
          armedDelete = null;
          render();
        }, 3000);
        render();
        return;
      }
      armedDelete = null;
      api.remove(sound.id).catch((e) => setNotice(`${sound.name}: ${reasonText(String(e))}`, "error"));
    });
    b.setAttribute("aria-label", `${label}: ${sound.name}`);
    return b;
  }

  function showPlaying(voices: PlayingVoice[]) {
    const byId = new Map(voices.map((v) => [v.id, v]));
    root.querySelectorAll<HTMLElement>(".sb-row").forEach((r) => {
      const voice = byId.get(r.dataset.id ?? "");
      r.classList.toggle("playing", voice !== undefined);
      const fill = r.querySelector<HTMLElement>(".sb-progress-fill");
      if (fill) {
        const width = voice && voice.durationMs > 0 ? Math.min(100, (voice.posMs / voice.durationMs) * 100) : 0;
        // A looping sound starts its next round: jump back rather than slide.
        const back = width < Number(fill.dataset.width ?? 0);
        fill.classList.toggle("no-slide", back);
        fill.dataset.width = String(width);
        fill.style.width = `${width}%`;
      }
      const play = r.querySelector<HTMLButtonElement>(".sb-play");
      const icon = voice ? "stop" : "play";
      if (play && play.dataset.icon !== icon) {
        play.dataset.icon = icon;
        play.innerHTML = voice ? STOP_ICON : PLAY_ICON;
        play.setAttribute("aria-label", `${t(voice ? "sb_stop" : "sb_play")}: ${r.dataset.name ?? ""}`);
      }
    });
  }

  async function chooseFiles() {
    const picked = await open({ multiple: true, directory: false, filters: [{ name: t("sb_filter_name"), extensions: EXTENSIONS }] });
    if (!picked) return;
    await addPaths(Array.isArray(picked) ? picked : [picked]);
  }

  async function addPaths(paths: string[]) {
    if (paths.length === 0) return;
    setNotice(paths.length === 1 ? t("sb_adding_one") : t("sb_adding").replace("{n}", String(paths.length)));
    let results: AddResult[];
    try {
      results = await api.add(paths);
    } catch (e) {
      setNotice(reasonText(String(e)), "error");
      return;
    }
    const failed = results.filter((r) => r.error);
    const added = results.length - failed.length;
    const lines: string[] = [];
    if (added > 0) lines.push(added === 1 ? t("sb_added_one") : t("sb_added").replace("{n}", String(added)));
    for (const f of failed) lines.push(`${f.name}: ${reasonText(f.error ?? "")}`);
    setNotice(lines.join("\n"), failed.length > 0 ? "error" : "ok");
  }

  function popped(): HTMLElement {
    const box = el("div", "sb-popped");
    box.append(el("p", "empty-state", t("sb_popped")), button("btn-secondary", t("sb_bring_back"), "dock", () => void api.dock().catch(fail)));
    return box;
  }

  listen("soundboard-changed", () => void refresh().catch(console.error));
  listen<PlayingVoice[]>("soundboard-playing", (e) => {
    if (state) state.playing = e.payload;
    showPlaying(e.payload);
  });
  listen<Status>("soundboard-status", (e) => {
    if (!state) return;
    state.status = e.payload;
    render();
  });
  getCurrentWebview().onDragDropEvent((event) => {
    if (!active || (state && !options.popOut && state.board.window.poppedOut)) return;
    const p = event.payload;
    if (p.type === "enter" || p.type === "over") root.classList.add("dragging");
    else if (p.type === "leave") root.classList.remove("dragging");
    else if (p.type === "drop") {
      root.classList.remove("dragging");
      void addPaths(p.paths);
    }
  });
  void refresh().catch(console.error);

  return {
    refresh,
    setActive(on: boolean) {
      active = on;
      if (on) void refresh().catch(console.error);
    },
  };
}
