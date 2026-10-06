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
  const sources = filesUnder(path.join(root, "src"), ".ts");
  let code = "";
  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    code += text + "\n";
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

  // Every command the frontend called before is still called.
  code += read("src/overlay.html");
  for (const cmd of contract.commands) {
    if (!code.includes(`"${cmd}"`)) add("contract", `command ${cmd}`, "the frontend no longer calls it");
  }
  return out;
}

/** The commands the frontend calls now (used once, to write contract.json). */
export function commandsCalled(root) {
  const names = new Set();
  const texts = filesUnder(path.join(root, "src"), ".ts").map((f) => fs.readFileSync(f, "utf8"));
  texts.push(fs.readFileSync(path.join(root, "src/overlay.html"), "utf8"));
  for (const text of texts) for (const m of text.matchAll(/invoke(?:<[^(]*>)?\(\s*"([a-z_]+)"/g)) names.add(m[1]);
  return [...names].sort();
}
