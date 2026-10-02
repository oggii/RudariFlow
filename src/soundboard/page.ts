// The Soundboard in its own window (label "soundboard"): the same board as
// the tab, with an Always on top switch. Closing the window brings the
// board back to its tab (main.rs).
import { invoke } from "@tauri-apps/api/core";
import { detectDefaultLang, setLang } from "../i18n";
import { mountBoard } from "./board";

async function start() {
  const settings = await invoke<{ uiLanguage: string }>("get_settings").catch(() => ({ uiLanguage: "" }));
  setLang(settings.uiLanguage || detectDefaultLang());
  mountBoard(document.getElementById("sb-root")!, { popOut: true });
}

void start();
