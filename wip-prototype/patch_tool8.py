# -*- coding: utf-8 -*-
import io


def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, (p, old[:60], s.count(old))
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)


edit(
    "tool8/pages.mjs",
    [
        (
            '''      await page.click("#file-summarize");
      await wait(page, 400);
    },
  },
''',
            '''      await page.click("#file-summarize");
      await wait(page, 400);
    },
    // With a file loaded the transcript starts on the first screen.
    probe: async (page) => {
      const at = await page.evaluate(() => [Math.round(document.getElementById("file-text").getBoundingClientRect().top), window.innerHeight]);
      return expect(at[0] < at[1], "the transcript starts on the first screen", `y ${at[0]} of ${at[1]}`);
    },
  },
''',
        ),
        (
            '''  { id: "soundboard", open: (page) => section(page, "soundboard") },
''',
            '''  {
    id: "soundboard",
    open: (page) => section(page, "soundboard"),
    // The sounds first: the panel is the left column with room, closed without; the switch always shows.
    probe: async (page) => {
      const out = [];
      const see = await page.evaluate(() => ({
        wide: document.getElementById("content").clientWidth >= 900,
        panel: !!document.getElementById("sb-panel"),
        expanded: document.querySelector('[data-key="settings"]').getAttribute("aria-expanded"),
        switchShown: !!document.querySelector('.sb-bar [data-key="enabled"]'),
        firstSound: Math.round(document.querySelector(".sb-row, .sb-list .empty-state").getBoundingClientRect().top),
        height: window.innerHeight,
      }));
      out.push(...expect(see.panel === see.wide && see.expanded === String(see.wide), "the settings panel is open only where it has its own column", JSON.stringify(see)));
      out.push(...expect(see.switchShown, "the virtual microphone's switch is always visible"));
      out.push(...expect(see.firstSound < see.height, "the first sound is on the first screen", JSON.stringify(see)));
      return out;
    },
  },
  {
    id: "soundboard-settings",
    fresh: true,
    // The other state of the panel: opened in a narrow window, closed in a wide one.
    open: async (page) => {
      await section(page, "soundboard");
      await page.click('[data-key="settings"]');
      await wait(page);
    },
    probe: async (page) => {
      const out = [];
      const wide = await page.evaluate(() => document.getElementById("content").clientWidth >= 900);
      out.push(...expect((await page.evaluate(() => !!document.getElementById("sb-panel"))) === !wide, "Soundboard settings opens and closes the panel"));
      // The choice is remembered for this layout; put it back for the pages that follow.
      await page.reload({ waitUntil: "networkidle" });
      await wait(page, 500);
      await section(page, "soundboard");
      out.push(...expect((await page.evaluate(() => !!document.getElementById("sb-panel"))) === !wide, "the panel's state is remembered"));
      await page.click('[data-key="settings"]');
      await wait(page);
      await page.click('[data-key="settings"]');
      await wait(page);
      return out;
    },
  },
''',
        ),
        (
            '''      await section(page, "soundboard");
      await page.click(".sb-devices > summary");
      await wait(page, 400);
    },
  },
  { id: "popout", url: "/soundboard.html", scope: "body", sizes: ["460x680"], open: (page) => wait(page) },
''',
            '''      await section(page, "soundboard");
      if (!(await page.evaluate(() => !!document.getElementById("sb-panel")))) await page.click('[data-key="settings"]');
      await page.click(".sb-devices > summary");
      await wait(page, 400);
    },
  },
  {
    id: "popout",
    url: "/soundboard.html",
    scope: "body",
    sizes: ["460x680"],
    open: (page) => wait(page),
    probe: async (page) => expect(!(await page.evaluate(() => !!document.getElementById("sb-panel"))), "the pop-out opens on the sounds, its settings closed"),
  },
  {
    id: "popout-settings",
    url: "/soundboard.html",
    scope: "body",
    sizes: ["460x680"],
    fresh: true,
    open: async (page) => {
      await page.click('[data-key="settings"]');
      await page.click(".sb-devices > summary");
      await wait(page, 400);
    },
  },
''',
        ),
        (
            '''  pill("notice", `window.__MOCK__.emit("gpu-notice", "freed");`),
''',
            '''  pill("notice", `window.__MOCK__.emit("gpu-notice", "freed");`, async (page) => {
    // The pill speaks the Display Language, not Windows' language.
    const out = [];
    const lang = await page.evaluate(() => window.__MOCK_CFG__.lang);
    const text = () => page.evaluate(() => document.getElementById("notice").textContent);
    out.push(...expect((await text()) === (lang === "de" ? "GPU freigegeben" : "GPU freed"), "the pill's notice is in the Display Language", await text()));
    await page.evaluate(() => {
      window.__MOCK__.emit("ui-language", "de");
      window.__MOCK__.emit("gpu-notice", "loaded");
    });
    await wait(page, 150);
    out.push(...expect((await text()) === "Modelle geladen", "the pill follows a change of the Display Language", await text()));
    return out;
  }),
  pill("no-model", `window.__MOCK__.emit("speech-notice", "no_model");`, async (page) => {
    const fits = await page.evaluate(() => {
      const n = document.getElementById("notice");
      return [n.textContent.length > 20, n.scrollWidth <= n.clientWidth, n.scrollHeight <= n.clientHeight];
    });
    return expect(fits.every(Boolean), "the no-model notice shows and fits the pill", JSON.stringify(fits));
  }),
''',
        ),
        (
            '''  out.push(...expect((await words()) === 12 && (await first.getAttribute("class")).includes("armed"), "the first click on Delete only arms it"));
''',
            '''  out.push(...expect((await words()) === 12 && (await first.getAttribute("class")).includes("armed"), "the first click on Delete only arms it"));
  // The suggestions are in the Display Language too.
  const add = await page.evaluate(() => [document.documentElement.lang, document.querySelector("#dict-suggest-list button").textContent]);
  out.push(...expect(add[1] === (add[0] === "de" ? "Hinzufügen" : "Add"), "the suggestions follow the Display Language", JSON.stringify(add)));
''',
        ),
    ],
)
print("ok")
