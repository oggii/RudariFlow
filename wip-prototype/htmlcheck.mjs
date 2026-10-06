// Sanity checks for a generated index.html: contract ids, duplicate ids, tag balance.
import fs from "node:fs";
const [file, contractFile] = process.argv.slice(2);
const html = fs.readFileSync(file, "utf8");
const c = JSON.parse(fs.readFileSync(contractFile, "utf8"));
const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const ids = new Set(all);
console.log("ids:", all.length, "missing from the contract:", c.ids.filter((i) => !ids.has(i) && !(i in c.removedIds)));
console.log("duplicate ids:", all.filter((x, i) => all.indexOf(x) !== i));
for (const t of ["div", "section", "p", "span", "button", "select", "label", "nav", "aside", "main", "h2", "h3", "details", "summary", "form", "textarea", "a", "kbd", "option", "ul", "li"]) {
  const open = (html.match(new RegExp("<" + t + "[\\s>]", "g")) || []).length;
  const close = (html.match(new RegExp("</" + t + ">", "g")) || []).length;
  if (open !== close) console.log("UNBALANCED", t, open, close);
}
