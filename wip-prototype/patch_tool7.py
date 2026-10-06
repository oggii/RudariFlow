# -*- coding: utf-8 -*-
import io
def edit(p, pairs):
    s = io.open(p, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, (p, old[:60], s.count(old))
        s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)

edit("tool7/pages.mjs", [
(
'''  ...TABS.map((tab) => ({ id: `settings-${tab}`, open: (page) => settings(page, tab) })),
''',
'''  ...TABS.map((tab) => ({ id: `settings-${tab}`, open: (page) => settings(page, tab), probe: tab === "dictionary" ? dictionaryProbe : undefined })),
'''),
(
'''export const PAGES = [
''',
'''/** The Dictionary tab: the searches, and the one way to delete. */
async function dictionaryProbe(page) {
  const out = [];
  if (await page.evaluate(() => window.__MOCK_CFG__.scenario === "firstrun")) return out;
  const words = () => page.locator("#dict-list .dict-row").count();
  const saved = () => page.evaluate(() => window.__MOCK__.settings());
  const first = page.locator("#dict-list .dict-row [data-delete-id]").first();
  // Nothing deletes on a single click; Esc disarms; the second click deletes.
  await first.click();
  out.push(...expect((await words()) === 12 && (await first.getAttribute("class")).includes("armed"), "the first click on Delete only arms it"));
  await page.keyboard.press("Escape");
  out.push(...expect(!(await first.getAttribute("class")).includes("armed"), "Esc disarms Delete"));
  await first.click();
  await page.click("#dict-input");
  out.push(...expect(!(await first.getAttribute("class")).includes("armed") && (await words()) === 12, "a click elsewhere disarms Delete"));
  await first.click();
  await first.click();
  await wait(page, 150);
  out.push(...expect((await words()) === 11, "the second click deletes the word", String(await words())));
  // The word search ignores case and accents.
  await page.fill("#dict-search", "zurich");
  await wait(page, 100);
  out.push(...expect((await words()) === 1, "the word search finds Zürich for zurich", String(await words())));
  await page.fill("#dict-search", "");
  // The replacement search hides rows and loses none of them.
  await page.fill("#replacement-search", "signat");
  await wait(page, 100);
  const shown = await page.locator("#replacement-list .replacement-row:not(.hidden)").count();
  out.push(...expect(shown === 1, "the replacement search shows the rows it finds", String(shown)));
  await page.evaluate(() => {
    const to = document.querySelector("#replacement-list .replacement-row:not(.hidden) .replacement-to");
    to.value = "Best regards";
    to.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await wait(page, 150);
  out.push(...expect((await saved()).replacements.length === 3, "a save while searching keeps the hidden replacements", String((await saved()).replacements.length)));
  await page.fill("#replacement-search", "");
  const del = page.locator("#replacement-list .replacement-row [data-delete-id]").first();
  await del.click();
  out.push(...expect((await saved()).replacements.length === 3, "one click deletes no replacement"));
  await del.click();
  await wait(page, 150);
  out.push(...expect((await saved()).replacements.length === 2, "the second click deletes the replacement"));
  await page.reload({ waitUntil: "networkidle" });
  await wait(page, 500);
  await settings(page, "dictionary");
  return out;
}

export const PAGES = [
'''),
])
print("ok")
