// Checks that read the source instead of a rendered page: every string in
// English and German, every key that is used exists, the frontend still
// calls every backend command it called before the redesign, and every style
// sheet keeps the shared standard (one focus ring, colours and type sizes
// from the tokens, motion only where the standard has it).
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

/**
 * The declarations of a style sheet: [{ selector, context, prop, value,
 * line }]. `selector` is the rule the declaration stands in (white space as
 * single blanks), `context` the rules around that one (an @media, an
 * @keyframes), `line` where the declaration starts. A declaration may take
 * several lines and need no ";" before its "}"; comments are no code, and a
 * ";" or a brace inside a string or a url(…) is none.
 */
export function declarations(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const out = [];
  const open = [];
  let part = "";
  let line = 1;
  let startsAt = 1;
  let quote = "";
  let depth = 0;
  const end = () => {
    const declaration = part.trim();
    const colon = declaration.indexOf(":");
    if (declaration && open.length && colon > 0) {
      out.push({ selector: open.at(-1), context: open.slice(0, -1), prop: declaration.slice(0, colon).trim().toLowerCase(), value: declaration.slice(colon + 1).trim().replace(/\s+/g, " "), line: startsAt });
    }
    part = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") line++;
    if (quote) {
      part += c;
      if (c === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && c === "{") {
      open.push(part.trim().replace(/\s+/g, " "));
      part = "";
      continue;
    } else if (depth === 0 && (c === ";" || c === "}")) {
      end();
      if (c === "}") open.pop();
      continue;
    }
    if (!part.trim()) startsAt = line;
    part += c;
  }
  return out;
}

/** The parts of a selector list or of a value, split at its commas (not at one inside brackets). */
function commaParts(text) {
  const parts = [];
  let depth = 0;
  let part = "";
  for (const c of text) {
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) {
      parts.push(part.trim());
      part = "";
    } else part += c;
  }
  parts.push(part.trim());
  return parts;
}

/** The style sheets the standard is read from: every .css under src/, and the pill's own <style> (with the line it starts on). */
export function styleSheets(root) {
  const sheets = filesUnder(path.join(root, "src"), ".css").map((file) => ({ file: path.relative(root, file).replace(/\\/g, "/"), css: fs.readFileSync(file, "utf8"), firstLine: 1 }));
  const pill = fs.readFileSync(path.join(root, "src/overlay.html"), "utf8");
  const style = /<style>([\s\S]*?)<\/style>/.exec(pill);
  if (style) sheets.push({ file: "src/overlay.html", css: style[1], firstLine: pill.slice(0, style.index).split("\n").length });
  return sheets;
}

// ── The shared standard in the styles ─────────────────
// Every style sheet is read. A new one is checked from its first line: what
// is not checked stands here, with the reason.

/** The type scale (src/styles/tokens.css: --fs-s, --fs, --fs-l, --fs-xl). */
const TYPE_SCALE = [12, 14, 16, 22];

/** Files a rule does not apply to: { file: { rule: why } }. */
const EXEMPT = {
  "src/styles/tokens.css": { colour: "the tokens are written here" },
  "src/styles/components.css": { focus: "it draws the one focus ring", outline: "a switch and a key box show the ring on the part that is seen, not on the input or the button around it" },
  "src/overlay.html": { colour: "the pill floats over any desktop: its see-through ground, its edge and its resting bars are whites and blacks of its own; what has a token uses it" },
};

/** Single declarations a rule lets pass: [file, selector, prop, why]. An entry that matches nothing is a finding. */
const PASSES = {
  focus: [
    ["src/style.css", ".export-list button:focus-visible", "", "a menu item shows the focus as its ground, like the hover; no ring is drawn or taken away"],
    [
      "src/styles/home.css",
      '.history-item:not(:hover, :focus-within) .history-more > :not(.armed, [data-on], [aria-disabled="true"])',
      "opacity",
      "a dictation's actions show while the focus is in their row; the rule asks where the focus is and draws no ring of its own",
    ],
    [
      "src/styles/home.css",
      '.history-item:is(:hover, :focus-within, :has(.history-more > :is(.armed, [data-on], [aria-disabled="true"]))) .history-parts',
      "opacity",
      "in a narrow list a dictation's second line gives its place to the row's actions while they show; the rule asks where the focus is and draws no ring of its own",
    ],
  ],
  colour: [["src/styles/components.css", ".switch-slider::before", "background", "a switch's knob is white on both of its tracks"]],
};

/** A colour written out. Not a token, not `transparent`, not `currentColor`. */
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/;
const NAMED_COLOUR = /(?:^|[\s,(])(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|gold|navy|teal|aqua|maroon|olive|lime|fuchsia)(?=$|[\s,)!])/i;
const COLOUR_PROPS = /^(?:color|background|background-color|border(?:-[a-z]+)*|outline(?:-color)?|fill|stroke|caret-color|accent-color|text-decoration(?:-color)?|column-rule(?:-color)?|scrollbar-color)$/;

/** What a font size is written as when it is not on the scale: "" when it is. */
function offScale(prop, value) {
  const plain = value.replace(/!important/, "").trim();
  if (prop === "font-size") {
    if (/^var\(--fs(-[a-z]+)?\)$/.test(plain) || plain === "inherit") return "";
    const px = /^([\d.]+)px$/.exec(plain);
    return px && TYPE_SCALE.includes(Number(px[1])) ? "" : plain;
  }
  // The shorthand: [style] [weight] size[/line-height] family. Its size is the first length in it.
  if (plain === "inherit" || /var\(--fs(-[a-z]+)?\)/.test(plain)) return "";
  const size = /(?:^|\s)([\d.]+)(px|em|rem|pt|%)(?=$|[\s/])/.exec(plain);
  if (!size) return plain;
  return size[2] === "px" && TYPE_SCALE.includes(Number(size[1])) ? "" : `${size[1]}${size[2]}`;
}

// ── Motion ────────────────────────────────────────────
// The in-page check reads computed styles, so it only sees a transition or
// an animation on an element that is in the state its rule is written for:
// one on :hover, on .dragging or on [open] passes there unseen. This reads
// the declarations themselves. Each is one of: `none`; the token that is no
// time (var(--transition), 0 s: hover and focus change at once); the token
// of the standard's motion (var(--ease), 120 to 180 ms ease-out) on the two
// places that move, a page that comes and a fold that opens, and on the
// pill's two fades; or a state that shows itself, by name in this list.

/** [file, selector, prop, value, what it is]. */
const MOVES = [
  ["src/styles/shell.css", ".content-section.active", "animation", "page-in var(--ease)", "a page that comes"],
  ["src/styles/components.css", ".fold[open] > .fold-body", "animation", "fold-in var(--ease)", "a fold that opens"],
  ["src/overlay.html", ".transcript", "transition", "opacity var(--ease)", "the pill's text comes and goes"],
  ["src/overlay.html", ".notice", "transition", "opacity var(--ease)", "the pill's notice comes and goes"],
];
const SHOWS_STATE = [
  ["src/styles/components.css", '.status-pill:is([data-tone="rec"], [data-tone="busy"]) .status-dot', "animation", "pulse 1.4s ease-in-out infinite", "the status records or works"],
  ["src/styles/components.css", ".progress-fill, #progress-fill", "transition", "width 0.3s ease", "a download's bar follows its percent"],
  ["src/styles/home.css", ".setup-level .progress-fill", "transition", "width 80ms linear", "the microphone's level follows the voice"],
  ["src/style.css", ".sb-progress-fill", "transition", "width 100ms linear", "a playing sound's bar follows its place"],
  ["src/style.css", ".mt-bar-dot", "animation", "pulse 1.6s ease-in-out infinite", "a meeting records"],
  ["src/style.css", '.mt-finishing-line::before, .mt-hint-row[data-tone="busy"] .mt-hint-text::before', "animation", "pulse 1.5s ease-in-out infinite", "a meeting's end steps run"],
  ["src/overlay.html", ".bar", "transition", "height 80ms ease-out, background 200ms ease", "the pill's bars follow the voice"],
  ["src/overlay.html", 'body[data-state="transcribing"] .bar', "animation", "shimmer 1.2s ease-in-out infinite", "the pill transcribes"],
  ["src/overlay.html", 'body[data-state="polishing"] .transcript', "animation", "polish 1.4s ease-in-out infinite", "the pill polishes"],
];

/** Findings for the style sheets of `root`: the standard's rules and the motion that is written down. */
export function styleChecks(root) {
  const out = [];
  const add = (check, what, detail = "") => out.push({ check, page: "source", what, detail });
  const used = new Set();
  const listed = (list, file, d, withValue) => {
    const hit = list.find((e) => e[0] === file && e[1] === d.selector && (!e[2] || e[2] === d.prop) && (!withValue || e[3] === d.value.replace(/\s*!important$/, "")));
    if (hit) used.add(hit);
    return !!hit;
  };
  const eases = [];
  for (const sheet of styleSheets(root)) {
    const exempt = EXEMPT[sheet.file] ?? {};
    for (const d of declarations(sheet.css)) {
      const at = `${sheet.file}:${d.line + sheet.firstLine - 1}`;
      const value = d.value.replace(/url\([^)]*\)/g, "url()");
      if (d.prop === "--ease") eases.push([sheet.file, d.value]);

      // The type scale, in every file.
      if (d.prop === "font-size" || d.prop === "font") {
        const off = offScale(d.prop, value);
        if (off) add("standard", at, `${d.prop === "font" ? "font: " : "font-size "}${off.replace(/^([\d.]+)px$/, "$1 px")} is not on the type scale (${TYPE_SCALE.join(" / ")})`);
      }

      // One focus ring: no rule of a page's own for :focus, and none takes an outline away.
      if (!exempt.focus) {
        for (const selector of commaParts(d.selector)) {
          if (/:focus/.test(selector) && !listed(PASSES.focus, sheet.file, { ...d, selector })) {
            add("standard", at, "a focus rule of a page's own; components.css draws the one ring");
            break;
          }
        }
      }
      if (!exempt.outline && /^outline(-style|-width)?$/.test(d.prop) && /^(none|0)\b/.test(value)) add("standard", at, "an outline is taken away; the one focus ring must show");

      // Colours come from the tokens; shadows and a dialog's backdrop have none.
      if (!exempt.colour && !d.prop.startsWith("box-shadow") && !d.selector.includes("::backdrop")) {
        if ((COLOUR.test(value) || (COLOUR_PROPS.test(d.prop) && NAMED_COLOUR.test(value))) && !listed(PASSES.colour, sheet.file, d)) add("standard", at, "a colour written past the tokens");
      }

      // Motion.
      if (/^(transition|animation)(-|$)/.test(d.prop)) {
        const plain = value.replace(/\s*!important$/, "");
        const still = plain === "none" || (d.prop === "transition" && commaParts(plain).every((p) => /^[a-z-]+ var\(--transition\)$/.test(p)));
        if (still) continue;
        if (!listed(MOVES, sheet.file, d, true) && !listed(SHOWS_STATE, sheet.file, d, true)) {
          add("motion", at, `"${d.prop}: ${plain}" on "${d.selector}": only a page that comes and a fold that opens move (var(--ease)), a state may show itself (the list in static.mjs), everything else is var(--transition) or none`);
        }
      }
    }
  }
  // The lists hold nothing that is gone.
  for (const [name, list] of [["PASSES.focus", PASSES.focus], ["PASSES.colour", PASSES.colour], ["MOVES", MOVES], ["SHOWS_STATE", SHOWS_STATE]]) {
    for (const entry of list) if (!used.has(entry)) add("standard", `${entry[0]}: ${entry[1]}`, `static.mjs lists it in ${name}, and no such declaration is there any more; remove the entry`);
  }
  // The standard's motion is one time, in the window and in the pill.
  if (!eases.some(([file]) => file === "src/styles/tokens.css")) add("motion", "--ease", "src/styles/tokens.css does not set it");
  for (const [file, value] of eases) {
    const ms = /^(\d+)ms ease-out$/.exec(value);
    if (!ms || Number(ms[1]) < 120 || Number(ms[1]) > 180) add("motion", `${file}: --ease`, `"${value}"; the standard is 120 to 180 ms ease-out`);
    else if (value !== eases[0][1]) add("motion", `${file}: --ease`, `"${value}" is not the "${eases[0][1]}" of ${eases[0][0]}`);
  }
  return out;
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

  // The shared standard in the styles, and the motion they write down.
  out.push(...styleChecks(root));

  // Every command the frontend called before is still called: an invoke("…")
  // of it, not the word in quotes (a text key can have a command's name).
  const called = new Set(commandsCalled(root));
  for (const cmd of contract.commands) {
    if (!called.has(cmd)) add("contract", `command ${cmd}`, "the frontend no longer calls it");
  }
  return out;
}

/**
 * The commands the frontend calls now: every invoke("name", …) in src/ and in the pill, and every question
 * of the start that is asked once for several parts of the window (src/start.ts: askOnce("name"),
 * stateOnce("name", "event"), which invoke the name they are given).
 */
export function commandsCalled(root) {
  const names = new Set();
  const texts = filesUnder(path.join(root, "src"), ".ts").map((f) => fs.readFileSync(f, "utf8"));
  texts.push(fs.readFileSync(path.join(root, "src/overlay.html"), "utf8"));
  for (const text of texts) for (const m of text.matchAll(/(?:invoke|askOnce|stateOnce)(?:<[^(]*>)?\(\s*"([a-z_]+)"/g)) names.add(m[1]);
  return [...names].sort();
}
