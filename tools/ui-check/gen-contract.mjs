// Writes contract.json from the frontend as it is NOW: the backend commands
// it calls, the ids of index.html and the texts that carry a dash. Run once,
// on the untouched 0.16.0 frontend (Task 1 of the UI redesign); never
// again: the file is the record of what the redesign has to keep.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DASH, commandsCalled, literal } from "./static.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const i18n = fs.readFileSync(path.join(root, "src/i18n.ts"), "utf8");
const en = literal(i18n, "const en: Translations = {");
const de = literal(i18n, "const de: Translations = {");
const dashKeys = Object.keys(en).filter((key) => DASH.test(en[key]) || DASH.test(de[key] ?? ""));
const commands = commandsCalled(root);
fs.writeFileSync(path.join(here, "contract.json"), JSON.stringify({ commands, ids, removedIds: {}, dashKeys }, null, 1) + "\n");
console.log(`${commands.length} commands, ${ids.length} ids, ${dashKeys.length} texts with a dash`);
