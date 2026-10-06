# -*- coding: utf-8 -*-
import io, json
def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, (p, old[:60], s.count(old))
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)

for d in ["tool", "tool3"]:
    edit(d + "/run.mjs", [(
'''              if (lang === WALK.lang && (size === WALK.size || def.sizes)) report(def.id, where, await keyboardWalk(win.page, scope));
              if (def.probe) report(def.id, where, await def.probe(win.page));
            }
''','''              if (lang === WALK.lang && (size === WALK.size || def.sizes)) report(def.id, where, await keyboardWalk(win.page, scope));
            }
            if (def.probe) report(def.id, where, await def.probe(win.page));
''')])

edit("tool3/mock.js", [
(
'''    get_settings: () => JSON.parse(JSON.stringify(settings)),
    save_settings: (a) => { settings = a.settings; return null; },
''',
'''    get_settings: () => JSON.parse(JSON.stringify(settings)),
    save_settings: (a) => {
      settings = a.settings;
      // The backend reports the speech model again after a change.
      setTimeout(() => window.__MOCK__.emit("speech-status", handlers.speech_status()), 0);
      return null;
    },
    speech_status: () => {
      const downloaded = whisperDownloaded.includes(settings.whisperModel);
      const local = settings.engine === "local";
      return {
        engine: settings.engine, model: settings.whisperModel, downloaded,
        load: local && downloaded ? "loaded" : "unloaded", freed: false, cloudKey: !!settings.groqApiKey,
        device: local && downloaded ? "NVIDIA GeForce RTX 5080 (CUDA)" : "",
      };
    },
'''),
])
c = json.load(io.open("tool3/contract.json", encoding="utf-8"))
why = "Task 3: the page became a tab of Settings"
c["removedIds"] = {
    "section-general": why, "section-engine": why, "section-recording": why, "section-dictionary": why,
    "section-replacements": why, "section-ai": why,
    "section-history": "Task 3: the list is on Home, its setting in Settings > General",
}
io.open("tool3/contract.json", "w", encoding="utf-8", newline="\n").write(json.dumps(c, indent=1) + "\n")
print("ok")
