# -*- coding: utf-8 -*-
import io, sys
p = sys.argv[1] + "/src/home.ts"
s = io.open(p, encoding="utf-8").read()
def rep(old, new):
    global s
    assert s.count(old) == 1, (old[:60], s.count(old))
    s = s.replace(old, new)
rep('''  /** The AI model in use and its state, for the "loaded" card and the setup. */
  ai(): { name: string; state: string; tone: string; downloaded: boolean; bytes: number };
''', '''  /** The AI model in use and its state line, as Settings shows them. */
  ai(): { name: string; state: string; tone: string; downloaded: boolean };
  /** An AI model's name and size (the setup suggests one for this PC). */
  aiModel(id: string): { name: string; bytes: number } | null;
''')
rep('''import { t } from "./i18n";
import { mirrorSelect, mirrorSwitch } from "./mirror";
''', '''import { t } from "./i18n";
import { activity } from "./activity";
import { mirrorSelect, mirrorSwitch } from "./mirror";
''')
rep('''  if (s.aiCard) {
    const ai = host.ai();
    $("setup-ai-text").textContent = t("setup_ai_text").replace("{model}", ai.name).replace("{size}", sizeText(ai.bytes));
  }
}
''', '''  if (s.aiCard) {
    const ai = host.aiModel(suggestion.ai);
    $("setup-ai-text").textContent = t("setup_ai_text").replace("{model}", ai?.name ?? "").replace("{size}", ai ? sizeText(ai.bytes) : "");
  }
  // A download that ended, also one that failed: its bar goes.
  if (activity().download === null) {
    progress("setup-model", null);
    progress("setup-ai", null);
  }
}
''')
rep('''  $("setup-ai-download").addEventListener("click", async () => {
    const button = $<HTMLButtonElement>("setup-ai-download");
    button.disabled = true;
    await host.setUpAi(suggestion.ai);
    button.disabled = false;
    progress("setup-ai", null);
    renderHome();
  });
''', '''  $("setup-ai-download").addEventListener("click", async () => {
    const button = $<HTMLButtonElement>("setup-ai-download");
    button.disabled = true;
    await host.setUpAi(suggestion.ai);
    button.disabled = false;
    renderHome();
  });
''')
rep('''  listen<DownloadProgress>("download-progress", (e) => progress("setup-model", e.payload.percent >= 100 ? null : e.payload));
  listen<DownloadProgress>("ai-download-progress", (e) => progress("setup-ai", e.payload.percent >= 100 ? null : e.payload));
''', '''  listen<DownloadProgress>("download-progress", (e) => progress("setup-model", e.payload));
  listen<DownloadProgress>("ai-download-progress", (e) => progress("setup-ai", e.payload));
''')
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
