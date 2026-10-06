# -*- coding: utf-8 -*-
import io, shutil
def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, (p, old[:60], s.count(old))
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)

edit("tool/inpage.js", [(
'''      const inSentence = [...(el.parentElement?.childNodes ?? [])].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (inSentence) continue; // a link inside a sentence
''',
'''      // A link inside a sentence ("More" after a hint) is as high as its line.
      const parent = el.parentElement;
      const inline = /^inline/.test(getComputedStyle(el).display) && parent && !/(flex|grid)/.test(getComputedStyle(parent).display);
      if (inline && parent.textContent.trim() !== el.textContent.trim()) continue;
''')])
for d in ["tool3", "tool5", "tool6"]:
    shutil.copy("tool/inpage.js", d + "/inpage.js")

edit("app/src/styles/components.css", [(
'''.setting-control {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--s2);
''',
'''.setting-control {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--s2);
''')])
edit("app/src/styles/settings.css", [(
'''.model-row {
  display: flex;
  align-items: center;
  gap: var(--s2);
''',
'''.model-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--s2);
'''), (
'''  min-width: 200px;
  max-width: 320px;
''',
'''  min-width: 160px;
  max-width: min(320px, 100%);
''')])
print("ok")
