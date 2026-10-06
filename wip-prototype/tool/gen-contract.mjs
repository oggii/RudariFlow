import fs from "node:fs";
import { commandsCalled } from "./static.mjs";
const root = "E:/claude/RudariFlow";
const html = fs.readFileSync(root + "/index.html", "utf8");
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
fs.writeFileSync("contract.json", JSON.stringify({ commands: commandsCalled(root), ids, removedIds: {} }, null, 1) + "\n");
console.log(commandsCalled(root).length, "commands,", ids.length, "ids");
