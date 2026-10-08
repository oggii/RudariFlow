// The Soundboard in its own window (label "soundboard"): the same board as
// the tab, with an Always on top switch. Closing the window brings the
// board back to its tab (main.rs).
import { invoke } from "@tauri-apps/api/core";
import { detectDefaultLang, getLang, setLang } from "../i18n";
import { mountBoard } from "./board";

async function start() {
  const settings = await invoke<{ uiLanguage: string }>("get_settings").catch(() => ({ uiLanguage: "" }));
  setLang(settings.uiLanguage || detectDefaultLang());
  const board = mountBoard(document.getElementById("sb-root")!, { popOut: true });
  // The main window saves a new UI language but sends no event, so the
  // pop-out checks the saved one whenever it gets focus.
  window.addEventListener("focus", () => {
    void (async () => {
      const saved = await invoke<{ uiLanguage: string }>("get_settings").catch(() => null);
      if (!saved) return;
      const lang = saved.uiLanguage || detectDefaultLang();
      if (lang === getLang()) return;
      setLang(lang);
      // The notice line was written in the old language.
      board.redraw(true);
      await board.refresh();
    })();
  });
}

void start();
