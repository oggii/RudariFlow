// Checks that read the source instead of a rendered page: every string in
// English and German, every key that is used exists, and the frontend still
// calls every backend command it called before the redesign.
import fs from "node:fs";
import path from "node:path";

function filesUnder(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** An em dash, or an en dash between words (a range like 5–10 is none). */
export const DASH = /—|\s–\s/;

/** The object literal that starts at `marker` (up to the first line that is just "};"). */
export function literal(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const open = source.indexOf("{", start + marker.length - 1);
  const end = source.indexOf("\n};", open);
  const close = end >= 0 ? end + 2 : source.indexOf("};", open) + 1;
  return new Function(`return ${source.slice(open, close)}`)();
}

export function staticChecks(root, contract) {
  const out = [];
  const add = (check, what, detail = "") => out.push({ check, page: "source", what, detail });
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

  // English and German: the same keys.
  const i18n = read("src/i18n.ts");
  const en = literal(i18n, "const en: Translations = {");
  const de = literal(i18n, "const de: Translations = {");
  if (!en || !de) {
    add("i18n", "src/i18n.ts", "the en and de tables were not found");
    return out;
  }
  for (const key of Object.keys(en)) if (!(key in de)) add("i18n", key, "no German text");
  for (const key of Object.keys(de)) if (!(key in en)) add("i18n", key, "no English text");
  for (const key of Object.keys(en)) if (key in de && (!en[key].trim() || !de[key].trim())) add("i18n", key, "an empty text");

  // No dash in a text the redesign wrote; contract.dashKeys are the texts of 0.16.0 that have one.
  const oldDash = new Set(contract.dashKeys ?? []);
  for (const key of Object.keys(en)) {
    if (!oldDash.has(key) && (DASH.test(en[key]) || DASH.test(de[key] ?? ""))) add("dash", key, "write the sentence without the dash");
  }

  // Keys the pages and the code use.
  const used = new Map();
  const use = (key, where) => used.has(key) || used.set(key, where);
  for (const file of ["index.html", "soundboard.html"]) {
    for (const m of read(file).matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g)) use(m[1], file);
  }
  for (const file of filesUnder(path.join(root, "src"), ".ts")) {
    const text = fs.readFileSync(file, "utf8");
    const name = path.relative(root, file).replace(/\\/g, "/");
    for (const m of text.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"\s*\)/g)) use(m[1], name);
    for (const m of text.matchAll(/"data-i18n(?:-title|-placeholder|-aria-label)?",\s*"([A-Za-z0-9_]+)"/g)) use(m[1], name);
  }
  for (const [key, where] of used) if (!(key in en)) add("i18n", key, `used in ${where}, in no language table`);

  // The pill has its own small table.
  const pill = literal(read("src/overlay.html"), "const NOTICE_TEXT = {");
  if (!pill?.en || !pill?.de) add("i18n", "src/overlay.html", "NOTICE_TEXT.en / .de were not found");
  else {
    for (const key of Object.keys(pill.en)) if (!(key in pill.de)) add("i18n", `pill: ${key}`, "no German text");
    for (const key of Object.keys(pill.de)) if (!(key in pill.en)) add("i18n", `pill: ${key}`, "no English text");
    for (const key of Object.keys(pill.en)) {
      if (DASH.test(pill.en[key]) || DASH.test(pill.de[key] ?? "")) add("dash", `pill: ${key}`, "write the sentence without the dash");
    }
  }

  // The shared standard in the styles (the clean-ups of Task 8 stay done).
  // The page rules draw no focus ring of their own and take none away
  // (components.css has the one ring), and write no colour past the tokens;
  // what stays are shadows and a dialog's backdrop, which have no token. No
  // style sheet has a font size that is not on the scale (12 / 14 / 16 / 22).
  const PAGE_RULES = ["src/style.css", "src/styles/shell.css", "src/styles/home.css", "src/styles/settings.css"];
  for (const file of filesUnder(path.join(root, "src"), ".css").map((f) => path.relative(root, f).replace(/\\/g, "/"))) {
    let rule = "";
    read(file)
      .split(/\r?\n/)
      .forEach((line, i) => {
        const at = `${file}:${i + 1}`;
        const text = line.trim();
        if (text.endsWith("{")) rule = text;
        const size = text.match(/font-size:\s*([\d.]+)px/);
        if (size && ![12, 14, 16, 22].includes(Number(size[1]))) add("standard", at, `font-size ${size[1]} px is not on the type scale (12 / 14 / 16 / 22)`);
        if (!PAGE_RULES.includes(file)) return;
        if (/:focus/.test(text) && text !== ".export-list button:focus-visible {") add("standard", at, "a focus rule of a page's own; components.css draws the one ring");
        if (/outline:\s*(none|0)\b/.test(text)) add("standard", at, "an outline is taken away; the one focus ring must show");
        const declaration = /^[a-z-]+:.*;$/.test(text);
        if (declaration && /rgba?\(|hsla?\(|#[0-9a-fA-F]{3,8}\b/.test(text) && !text.startsWith("box-shadow:") && !rule.includes("::backdrop")) add("standard", at, "a colour written past the tokens");
      });
  }

  // Every command the frontend called before is still called: an invoke("…")
  // of it, not the word in quotes (a text key can have a command's name).
  const called = new Set(commandsCalled(root));
  for (const cmd of contract.commands) {
    if (!called.has(cmd)) add("contract", `command ${cmd}`, "the frontend no longer calls it");
  }
  return out;
}

/** The commands the frontend calls now: every invoke("name", …) in src/ and in the pill. */
export function commandsCalled(root) {
  const names = new Set();
  const texts = filesUnder(path.join(root, "src"), ".ts").map((f) => fs.readFileSync(f, "utf8"));
  texts.push(fs.readFileSync(path.join(root, "src/overlay.html"), "utf8"));
  for (const text of texts) for (const m of text.matchAll(/invoke(?:<[^(]*>)?\(\s*"([a-z_]+)"/g)) names.add(m[1]);
  return [...names].sort();
}
