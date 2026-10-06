# -*- coding: utf-8 -*-
import io
def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, (p, old[:60], s.count(old))
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)

edit("tool6/pages.mjs", [
(
'''  ...TABS.map((tab) => ({ id: `settings-${tab}`, open: (page) => settings(page, tab) })),
''',
'''  ...TABS.map((tab) => ({ id: `settings-${tab}`, open: (page) => settings(page, tab) })),
  // The same tabs with Advanced open (General has no fold).
  ...TABS.filter((tab) => tab !== "general").map((tab) => ({
    id: `settings-${tab}-advanced`,
    open: async (page) => {
      await settings(page, tab);
      await page.evaluate((t) => (document.querySelector(`details.fold[data-fold="${t}"]`).open = true), tab);
      await wait(page);
    },
    probe:
      tab !== "models"
        ? undefined
        : async (page) => {
            const out = [];
            // "More" opens the long hint in place.
            const more = page.locator("#panel-models .hint-more").first();
            await more.click();
            const opened = await page.evaluate(() => {
              const b = document.querySelector("#panel-models .hint-more");
              return [b.getAttribute("aria-expanded"), !document.getElementById(b.getAttribute("aria-controls")).hidden];
            });
            out.push(...expect(opened[0] === "true" && opened[1], "More opens the long hint", JSON.stringify(opened)));
            await more.click();
            // The fold stays open over a new start.
            await page.reload({ waitUntil: "networkidle" });
            await wait(page, 500);
            const kept = await page.evaluate(() => [document.querySelector('details.fold[data-fold="models"]').open, document.querySelector('details.fold[data-fold="general"]') === null]);
            out.push(...expect(kept[0] === true, "an open Advanced fold is remembered", JSON.stringify(kept)));
            return out;
          },
  })),
'''),
])
print("ok")
