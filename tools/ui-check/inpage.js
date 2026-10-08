// The measurements the ui-check takes inside a page. Loaded into every page
// before the app's scripts (run.mjs, addInitScript); run.mjs calls
// window.__uic.collect(...) once the page is drawn. Plain browser JavaScript:
// no imports, nothing from the app.
(() => {
  /** What a keyboard or mouse user can operate. */
  const CONTROLS =
    "button, select, textarea, input:not([type=hidden]), summary, a[href], [role=button], [role=tab], [role=switch]";
  /**
   * Boxes that are drawn: a card, a sound's tile, a bar, a notice. What stands
   * in one stays in it. (A row of a list or of the settings is no such box:
   * its buttons may reach into the card's own padding.)
   */
  const BOXES = ".card, .sb-row, .sb-bar, .sb-col-settings, .sb-devices, .sb-hint, .mt-item, .mt-bar, .mt-hint-row, .mt-notes, .mt-modal-box, .file-drop, .file-summary, .ai-test-result, .notice, .pill";
  /** Hints that are status lines: they may be longer than one line. */
  const NOT_A_HINT = ".hint-long, .status-line, .ai-status, .sb-status, .ai-output-warn, #gpu-detected, #ai-model-note";
  /**
   * Running text: what is read line after line and keeps the measure (the list
   * at --measure in src/styles/tokens.css; .panel-lead and .hint-long keep the
   * same width as 72ch). A hint has the width of its row and is not in here.
   */
  const RUNNING = ".mt-para-text, .mt-notes-text, .mt-notes li, .file-summary-text, .file-text, .history-text, .ai-test-result p, .sb-hint p, .panel-lead, .hint-long";
  /** The most characters a line of running text may have. The measure gives 90 to 100; a line of narrow letters has a few more. */
  const LINE_MAX = 110;
  /** From this window width on a frame is wide enough to let a line run on: the measure is asked for there. */
  const MEASURED_FROM = 1920;

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    // False inside a closed <details> too, which still has a layout box.
    return el.checkVisibility({ visibilityProperty: true });
  };
  /** A control counts as shown when it or the label that stands for it is (a switch's input has no size). */
  const shown = (el) => visible(el) || (el.matches("input") && !!el.closest("label") && visible(el.closest("label")));
  const ownText = (el) =>
    [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(" ")
      .trim();
  const short = (s, n = 48) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  /** A name for a finding that stays the same in both languages where it can. */
  const desc = (el) => {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    const key = el.getAttribute("data-i18n") || el.getAttribute("data-key") || el.getAttribute("data-section") || el.getAttribute("data-tab");
    if (key) return `${tag}${cls}[${key}]`;
    // A button's label tells buttons apart; other text changes with the data.
    const text = el.matches("button, summary, a, [role=tab]") ? (el.innerText || el.getAttribute("aria-label") || el.title || "").trim().replace(/\s+/g, " ") : "";
    return text ? `${tag}${cls} "${short(text, 32)}"` : `${tag}${cls}`;
  };

  // ── Colours ───────────────────────────────────────────
  const parseColor = (s) => {
    if (!s || s === "transparent") return [0, 0, 0, 0];
    let m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    m = s.match(/^color\(srgb ([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
    }
    return null;
  };
  /** `top` painted over the opaque `bottom`. */
  const over = (top, bottom) => {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
  };
  const hex = (c) => "#" + [0, 1, 2].map((i) => Math.round(c[i]).toString(16).padStart(2, "0")).join("");
  const luminance = (c) => {
    const [r, g, b] = [0, 1, 2].map((i) => {
      const v = c[i] / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  /**
   * The colour behind `el`: every background from the page down to it, painted in order.
   * `unread(text, element)` hears of a background colour parseColor does not understand.
   */
  const backgroundOf = (el, unread = null) => {
    const chain = [];
    for (let n = el; n; n = n.parentElement) chain.unshift(n);
    let bg = [255, 255, 255, 1];
    for (const n of chain) {
      const text = getComputedStyle(n).backgroundColor;
      const c = parseColor(text);
      if (!c) unread?.(text, n);
      else if (c[3] > 0) bg = over(c, bg);
    }
    return bg;
  };
  const opacityOf = (el) => {
    let o = 1;
    for (let n = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity || "1");
    return o;
  };
  /** A colour token's value as the browser computes it: { text, colour }; colour is null when parseColor does not understand it. */
  const tokenColor = (name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.appendChild(probe);
    const text = getComputedStyle(probe).color;
    probe.remove();
    return { text, colour: parseColor(text) };
  };
  const rootTokens = () => {
    const names = new Set();
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.selectorText === ":root") {
          for (const prop of rule.style) if (prop.startsWith("--")) names.add(prop);
        } else if (rule.cssRules && !rule.selectorText) walk(rule.cssRules); // inside @media, @layer, @supports
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {
        continue; // a stylesheet from another origin
      }
    }
    return [...names];
  };

  // ── Text cut by a box around it ───────────────────────
  const pen = document.createElement("canvas").getContext("2d");
  /** Where the text nodes of `el` itself are drawn. */
  const textRects = (el) => {
    const rects = [];
    const range = document.createRange();
    for (const node of el.childNodes) {
      if (node.nodeType !== 3 || !node.textContent.trim()) continue;
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) rects.push(r);
    }
    return rects;
  };
  /**
   * How far the ink of `text` stays inside its line's rectangle, above and
   * below: the rectangle is as high as the font, the letters are not. Without
   * this a label in a tight pill counts as cut where only empty space is.
   */
  const inkInset = (cs, text, height) => {
    pen.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const drawn = cs.textTransform === "uppercase" ? text.toUpperCase() : cs.textTransform === "lowercase" ? text.toLowerCase() : text;
    const m = pen.measureText(drawn);
    const font = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
    if (!(font > 0) || Math.abs(font - height) > 2) return { top: 0, bottom: 0 }; // not the font the line is drawn in
    return { top: Math.max(0, m.fontBoundingBoxAscent - m.actualBoundingBoxAscent), bottom: Math.max(0, m.fontBoundingBoxDescent - m.actualBoundingBoxDescent) };
  };
  const CLIPS = /^(hidden|clip)$/;
  const SCROLLS = /^(auto|scroll)$/;
  /**
   * The box around `el` that cuts its text: an ancestor with overflow hidden
   * or clip that the text leaves by more than 1 px. { by, px, side } or null.
   * A box that scrolls (auto, scroll) cuts nothing, and neither does anything
   * further out in that direction: what lies outside is reached by scrolling.
   */
  const cutByBoxAround = (el, cs, text) => {
    const rects = textRects(el);
    if (!rects.length) return null;
    const inset = inkInset(cs, text, rects[0].height);
    const html = document.documentElement;
    const htmlCs = getComputedStyle(html);
    let position = cs.position;
    let x = cs.display === "inline" || !SCROLLS.test(cs.overflowX);
    let y = cs.display === "inline" || !SCROLLS.test(cs.overflowY);
    for (let box = el.parentElement; box && (x || y); box = box.parentElement) {
      const bs = getComputedStyle(box);
      // A positioned element is cut only by the boxes it is placed in.
      if (box !== html) {
        const holdsAll = bs.transform !== "none" || bs.perspective !== "none" || bs.filter !== "none" || /paint|layout|strict|content/.test(bs.contain);
        if (position === "fixed" && !holdsAll) continue;
        if (position === "absolute" && bs.position === "static" && !holdsAll) continue;
      }
      position = bs.position;
      let ox = bs.overflowX;
      let oy = bs.overflowY;
      let left = 0;
      let top = 0;
      let right = window.innerWidth;
      let bottom = window.innerHeight;
      if (box === html) {
        // The window: it takes <body>'s overflow when <html> has none, and "visible" means it scrolls.
        if (ox === "visible" && oy === "visible") ({ overflowX: ox, overflowY: oy } = getComputedStyle(document.body));
        if (ox === "visible") ox = "auto";
        if (oy === "visible") oy = "auto";
      } else {
        if (box === document.body && htmlCs.overflowX === "visible" && htmlCs.overflowY === "visible") continue; // its overflow is the window's
        if (bs.display === "inline" || bs.display === "contents") continue; // no box that cuts
        const r = box.getBoundingClientRect();
        left = r.left + box.clientLeft;
        top = r.top + box.clientTop;
        right = left + box.clientWidth;
        bottom = top + box.clientHeight;
        if (right - left <= 2 || bottom - top <= 2) return null; // read out and not shown, or folded away
      }
      const cutsX = x && CLIPS.test(ox);
      const cutsY = y && CLIPS.test(oy);
      let px = 0;
      let side = "";
      for (const r of rects) {
        const over = [];
        if (cutsX) over.push([r.right - right, "on the right"], [left - r.left, "on the left"]);
        if (cutsY) over.push([r.bottom - inset.bottom - bottom, "at the bottom"], [top - r.top - inset.top, "at the top"]);
        for (const [by, where] of over) if (by > px) [px, side] = [by, where];
      }
      if (px > 1) return { by: box, px: Math.round(px), side };
      if (SCROLLS.test(ox)) x = false;
      if (SCROLLS.test(oy)) y = false;
    }
    return null;
  };

  /**
   * The part of `el`'s box that the boxes around it leave to be seen,
   * sideways: { left, right }. A box that cuts sideways (overflow hidden or
   * clip) hides what lies beyond its edge: the pill's text, which keeps its
   * end in view and loses its beginning. A box that scrolls hides nothing
   * (what is beyond its edge is reached by scrolling, and "scrolls sideways"
   * is a finding of its own), and neither does the window: what leaves the
   * window is what is asked for.
   */
  const seenSideways = (el) => {
    const r = el.getBoundingClientRect();
    let left = r.left;
    let right = r.right;
    for (let box = el.parentElement; box && box !== document.body && box !== document.documentElement; box = box.parentElement) {
      const bs = getComputedStyle(box);
      if (!CLIPS.test(bs.overflowX) || bs.display === "inline" || bs.display === "contents") continue;
      const b = box.getBoundingClientRect();
      left = Math.max(left, b.left + box.clientLeft);
      right = Math.min(right, b.left + box.clientLeft + box.clientWidth);
    }
    return { left, right };
  };

  /**
   * The lines the text of `el` is drawn in: the number of characters of
   * each. A text box draws its text itself, so its lines are measured in a
   * copy of the text that is laid out as the box lays it out (its font, the
   * width its text has).
   */
  const lineLengths = (el) => {
    let root = el;
    let copy = null;
    if (el.matches("textarea")) {
      const cs = getComputedStyle(el);
      copy = document.createElement("div");
      copy.style.cssText = `position:absolute;left:-99999px;top:0;visibility:hidden;box-sizing:content-box;white-space:pre-wrap;overflow-wrap:break-word;width:${el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px;font:${cs.font};letter-spacing:${cs.letterSpacing};line-height:${cs.lineHeight}`;
      copy.textContent = el.value;
      document.body.appendChild(copy);
      root = copy;
    }
    // top of the line → [characters in its words, words]
    const lines = new Map();
    const range = document.createRange();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const word of node.textContent.matchAll(/\S+/g)) {
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        const rect = range.getClientRects()[0];
        if (!rect) continue;
        const top = Math.round(rect.top);
        const line = lines.get(top) ?? [0, 0];
        lines.set(top, [line[0] + word[0].length, line[1] + 1]);
      }
    }
    copy?.remove();
    // The words and the blanks between them.
    return [...lines.values()].map(([characters, words]) => characters + words - 1);
  };

  /** Name a screen reader announces: label, aria-label, aria-labelledby, a button's text, or a title. A placeholder is no name. */
  const accessibleName = (el) => {
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    const by = ids.map((id) => (document.getElementById(id)?.textContent ?? "").trim()).join(" ").trim();
    if (by) return by;
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    for (const label of el.labels ?? []) {
      const text = label.textContent.trim();
      if (text) return text;
    }
    if (el.matches("button, summary, a, [role=button], [role=tab]")) {
      const text = el.textContent.trim();
      if (text) return text;
      const alt = el.querySelector("img[alt]")?.getAttribute("alt")?.trim();
      if (alt) return alt;
    }
    return (el.title || "").trim();
  };

  /** A tab of a tab list with arrow keys: only the selected tab is a Tab stop. */
  const rovingTab = (el) =>
    el.matches("[role=tab]") && [...(el.closest("[role=tablist]")?.querySelectorAll("[role=tab]") ?? [])].some((t) => t.tabIndex >= 0);

  /**
   * The focus ring of the focused control: an outline of 2 px or more with
   * 3:1 against the page, on it or on the part that stands for it, in the
   * one colour of the token --focus (a page without the token, the pill, is
   * not asked for the colour). "" when it is there, or what is wrong with it.
   */
  const focusRing = (el) => {
    const parts = [el, ...el.children, el.nextElementSibling, el.closest("label")].filter(Boolean);
    const one = rootTokens().includes("--focus") ? tokenColor("--focus").colour : null;
    let other = "";
    for (const part of parts) {
      const cs = getComputedStyle(part);
      if (cs.outlineStyle === "none" || parseFloat(cs.outlineWidth) < 1.5) continue;
      const colour = parseColor(cs.outlineColor);
      if (!colour || colour[3] < 0.5) continue;
      const bg = backgroundOf(part.parentElement ?? part);
      if (ratio(over(colour, bg), bg) < 3) continue;
      if (!one || [0, 1, 2, 3].every((i) => Math.abs(colour[i] - one[i]) < (i === 3 ? 0.01 : 1))) return "";
      other = `its ring is ${hex(colour)}, not the one of --focus (${hex(one)})`;
    }
    return other || "has the keyboard focus and does not show it";
  };

  // ── Motion ────────────────────────────────────────────
  /** Where a state may show itself by pulsing (the element or its ::before). */
  const PULSES = ".status-dot, .mt-bar-dot, .mt-finishing-line, .mt-hint-text";
  /** Bars whose width follows a value. */
  const FILLS = ".progress-fill, #progress-fill, .sb-progress-fill";
  /** The pill (src/overlay.html): its bars follow the voice and shimmer while it transcribes, its text pulses while it polishes. */
  const PILL_SHOWS = { shimmer: ".waveform .bar", polish: ".transcript" };
  const PILL_FOLLOWS = { height: ".waveform .bar", background: ".waveform .bar" };
  /** The pill's text and its notice come and go like a page of the window. */
  const PILL_FADES = "body > .transcript, body > .notice";
  const seconds = (text) => text.split(",").map((s) => (s.trim().endsWith("ms") ? parseFloat(s) / 1000 : parseFloat(s)));
  /**
   * Everything in the document that has an animation or a transition with a
   * duration, shown or not: [{ el, pseudo, what, kind: "animation" |
   * "transition", name, duration, timing, count }].
   */
  const moving = () => {
    const out = [];
    for (const el of document.querySelectorAll("*")) {
      for (const pseudo of ["", "::before", "::after"]) {
        const cs = getComputedStyle(el, pseudo || undefined);
        if (pseudo && (cs.content === "none" || cs.content === "normal")) continue; // no such part
        const what = () => desc(el) + pseudo; // asked for only where something moves
        const names = cs.animationName.split(",").map((n) => n.trim());
        const lasts = seconds(cs.animationDuration);
        names.forEach((name, i) => {
          if (name !== "none") out.push({ el, pseudo, what: what(), kind: "animation", name, duration: lasts[i % lasts.length], timing: cs.animationTimingFunction, count: cs.animationIterationCount });
        });
        const props = cs.transitionProperty.split(",").map((n) => n.trim());
        const times = seconds(cs.transitionDuration);
        // The longer list rules: a duration without a property of its own belongs to the properties again.
        for (let i = 0; i < Math.max(props.length, times.length); i++) {
          const duration = times[i % times.length];
          if (duration > 0 && props[i % props.length] !== "none") out.push({ el, pseudo, what: what(), kind: "transition", name: props[i % props.length], duration, timing: cs.transitionTimingFunction, count: "1" });
        }
      }
    }
    return out;
  };
  /**
   * What moves against the standard: only a page that comes (page-in) and a
   * fold that opens (fold-in) move, once, for 120 to 180 ms, ease-out. A
   * state may show itself: a dot that pulses, a bar whose width follows its
   * value. Hover, focus and everything else change at once.
   */
  const motion = () => {
    const out = [];
    const ms = (m) => `${Math.round(m.duration * 1000)} ms`;
    for (const m of moving()) {
      if (m.kind === "animation") {
        if (m.name === "pulse" && m.el.matches(PULSES)) continue;
        if (PILL_SHOWS[m.name] && !m.pseudo && m.el.matches(PILL_SHOWS[m.name])) continue;
        const where = m.name === "page-in" ? ".content-section" : m.name === "fold-in" ? ".fold-body" : null;
        if (!where || m.pseudo || !m.el.matches(where)) out.push({ what: m.what, detail: `the animation "${m.name}" is none of the standard's (page-in, fold-in, a state's pulse) or runs in another place` });
        else if (m.duration < 0.12 - 1e-6 || m.duration > 0.18 + 1e-6 || m.timing !== "ease-out" || m.count !== "1") out.push({ what: m.what, detail: `"${m.name}" runs ${ms(m)} ${m.timing}, ${m.count} times; the standard is 120 to 180 ms, ease-out, once` });
      } else if (m.name === "opacity" && !m.pseudo && m.el.matches(PILL_FADES)) {
        if (m.duration < 0.12 - 1e-6 || m.duration > 0.18 + 1e-6 || m.timing !== "ease-out") out.push({ what: m.what, detail: `the pill's fade runs ${ms(m)} ${m.timing}; the standard is 120 to 180 ms, ease-out` });
      } else if (!(m.name === "width" && !m.pseudo && m.el.matches(FILLS)) && !(PILL_FOLLOWS[m.name] && !m.pseudo && m.el.matches(PILL_FOLLOWS[m.name]))) {
        out.push({ what: m.what, detail: `a transition of ${m.name} over ${ms(m)}; only a bar's width follows its value, everything else changes at once` });
      }
    }
    return out;
  };

  /**
   * Findings for the part of the page under `scope`.
   * `opts`: scope (CSS selector), sidebar (check that the sidebar fits the
   * window), tokens (check the colour tokens), ids (ids that must exist),
   * userText (selectors whose text is the user's and may be cut), skip
   * (check ids to leave out).
   */
  function collect(opts) {
    const out = [];
    const skip = new Set(opts.skip ?? []);
    const add = (check, what, detail = "") => {
      if (!skip.has(check)) out.push({ check, what, detail });
    };
    const root = document.querySelector(opts.scope);
    if (!root) {
      add("page-error", `nothing matches ${opts.scope}`);
      return out;
    }
    const all = [root, ...root.querySelectorAll("*")].filter(visible);
    const userText = opts.userText?.length ? opts.userText.join(", ") : null;

    // 1. Horizontal overflow.
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) add("overflow", "the window scrolls sideways", `${doc.scrollWidth} px in ${doc.clientWidth} px`);
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && !el.matches("textarea, pre, input, select")) {
        add("overflow", `${desc(el)} scrolls sideways`, `${el.scrollWidth} px in ${el.clientWidth} px`);
      }
    }
    for (const el of all) {
      if (!el.matches("button, select, input, textarea, kbd, span, p, label, a, h1, h2, h3, h4")) continue;
      if (el.getBoundingClientRect().width <= 2) continue; // read out, not shown
      // What a box around it cuts off sideways is not seen, and leaves nothing ("clipped" asks whether it may be cut).
      const r = seenSideways(el);
      if (r.right > window.innerWidth + 1 || r.left < -1) add("overflow", `${desc(el)} leaves the window`, `x ${Math.round(r.left)}–${Math.round(r.right)} of ${window.innerWidth}`);
    }

    // 1b. What stands in a drawn box stays in it: a control or a text that
    // reaches past its card or its tile lies on the page or on the neighbour.
    // Not what is laid over the page on purpose (a menu, a button that floats)
    // and not what a box in between scrolls or cuts (that is "clipped").
    for (const box of all) {
      if (!box.matches(BOXES)) continue;
      const bs = getComputedStyle(box);
      if (!/^visible$/.test(bs.overflowX) || !/^visible$/.test(bs.overflowY)) continue;
      const b = box.getBoundingClientRect();
      for (const el of box.querySelectorAll("*")) {
        if (!(el.matches(`${CONTROLS}, kbd`) || ownText(el)) || !shown(el)) continue;
        // A switch's input covers its switch: the switch is what is seen.
        const seen = el.matches(".switch input") ? el.closest(".switch") : el;
        let held = true;
        for (let n = seen; n && n !== box; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if (/^(absolute|fixed)$/.test(cs.position) || (n !== seen && (cs.overflowX !== "visible" || cs.overflowY !== "visible"))) held = false;
        }
        if (!held) continue;
        const r = seen.getBoundingClientRect();
        if (r.width <= 2 || r.height <= 2) continue; // read out, not shown
        const by = Math.max(r.right - b.right, b.left - r.left, r.bottom - b.bottom, b.top - r.top);
        if (by > 1) add("overflow", `${desc(el)} leaves ${desc(box)}`, `by ${Math.round(by)} px`);
      }
    }

    // 2. Clipped text: cut by its own box or by a box around it (a card, a
    // button whose label sits in a <span>), and a select whose chosen option
    // does not fit. Each element once.
    for (const el of all) {
      const text = ownText(el);
      if (!text || el.matches("option, textarea, input, select") || (userText && el.matches(userText))) continue;
      const cs = getComputedStyle(el);
      const inline = cs.display === "inline"; // in a line of text: no box of its own that could cut
      if (!inline && el.clientWidth <= 2) continue; // read out, not shown
      const cutX = !inline && el.scrollWidth > el.clientWidth + 1 && /(hidden|clip)/.test(cs.overflowX);
      const cutY = !inline && el.scrollHeight > el.clientHeight + 1 && /(hidden|clip)/.test(cs.overflowY);
      if (cutX) add("clipped", desc(el), `"${short(text)}" needs ${el.scrollWidth} px, has ${el.clientWidth} px`);
      else if (cutY) add("clipped", desc(el), `"${short(text)}" needs ${el.scrollHeight} px of height, has ${el.clientHeight} px`);
      if (cutX || cutY || (userText && el.closest(userText))) continue; // said once; or inside the user's own text
      const cut = cutByBoxAround(el, cs, text);
      if (cut) add("clipped", desc(el), `"${short(text)}" is cut by ${cut.by === document.documentElement ? "the window, which does not scroll" : desc(cut.by)}, ${cut.px} px ${cut.side}`);
    }
    for (const el of all) {
      if (!el.matches("select")) continue;
      const cs = getComputedStyle(el);
      pen.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const text = el.selectedOptions[0]?.textContent ?? "";
      const need = pen.measureText(text).width;
      const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (need > room + 1) add("clipped", desc(el), `"${short(text)}" needs ${Math.round(need)} px, has ${Math.round(room)} px`);
    }

    // 3. A setting row's text running under its control.
    for (const row of all) {
      if (!row.matches(".setting-row")) continue;
      const control = row.querySelector(".setting-control");
      const kids = control ? [...control.children].filter(visible) : [];
      if (!kids.length) continue;
      const rects = kids.map((k) => k.getBoundingClientRect());
      const left = Math.min(...rects.map((r) => r.left));
      const top = Math.min(...rects.map((r) => r.top));
      const bottom = Math.max(...rects.map((r) => r.bottom));
      for (const span of row.querySelectorAll(".setting-label *")) {
        if (!visible(span) || !ownText(span)) continue;
        const range = document.createRange();
        range.selectNodeContents(span);
        if ([...range.getClientRects()].some((r) => r.right > left + 1 && r.bottom > top + 1 && r.top < bottom - 1)) {
          add("overlap", desc(span), `the text runs under the control of "${short(row.querySelector(".label-text")?.textContent.trim() ?? "", 40)}"`);
        }
      }
    }

    // 4. Contrast of the text as drawn: 4.5:1, or 3:1 for large text.
    const pairs = new Map();
    /** `placeholder`: the placeholder's own opacity when it is the placeholder that is judged. */
    const unread = new Map();
    const notUnderstood = (text, el) => unread.has(text) || unread.set(text, `e.g. ${desc(el)}`);
    const judge = (el, colourText, placeholder = null) => {
      const colour = parseColor(colourText);
      const cs = getComputedStyle(el);
      const bg = backgroundOf(el, notUnderstood);
      if (!colour) {
        notUnderstood(colourText, el);
        return;
      }
      const fg = over([colour[0], colour[1], colour[2], colour[3] * opacityOf(el) * (placeholder ?? 1)], bg);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
      const value = ratio(fg, bg);
      if (value >= (large ? 3 : 4.5) - 0.005) return;
      const key = `${hex(fg)} on ${hex(bg)}${placeholder === null ? "" : " (placeholder)"}`;
      if (!pairs.has(key)) pairs.set(key, `${value.toFixed(2)}:1, e.g. ${desc(el)}`);
    };
    for (const el of all) {
      if (el.closest(":disabled, [aria-disabled='true'], [aria-hidden='true']") || el.matches("option")) continue;
      // Not drawn at the moment: a dictation's actions that show with the pointer on their row or the
      // focus in it (Home). They are buttons of the same kind as the one that always shows, which is judged.
      if (opacityOf(el) === 0) continue;
      if (el.matches("input, textarea, select")) {
        if (el.matches("input[type=checkbox], input[type=radio], input[type=range]")) continue;
        if (el.matches("select") || el.value) judge(el, getComputedStyle(el).color);
        else if (el.placeholder) judge(el, getComputedStyle(el, "::placeholder").color, parseFloat(getComputedStyle(el, "::placeholder").opacity || "1"));
        continue;
      }
      if (ownText(el)) judge(el, getComputedStyle(el).color);
    }
    for (const [key, detail] of pairs) add("contrast", key, detail);
    // A notation parseColor does not know (oklch, lab, another colour space) is a finding, not a pass.
    for (const [text, detail] of unread) add("contrast", `colour not understood: ${text}`, detail);

    // 5. Contrast of the tokens: every --text* on every --bg / --surface* / --sidebar*.
    if (opts.tokens) {
      const tokens = rootTokens();
      const texts = tokens.filter((n) => /^--text(-|$)/.test(n));
      const surfaces = tokens.filter((n) => /^--(bg|surface|sidebar)(-|$)/.test(n));
      if (!texts.length) add("contrast-token", "no --text* token on :root", "the check found nothing to measure");
      if (!surfaces.length) add("contrast-token", "no --bg, --surface* or --sidebar* token on :root", "the check found nothing to measure");
      const value = new Map();
      for (const name of [...texts, ...surfaces]) {
        const { text, colour } = tokenColor(name);
        if (colour) value.set(name, colour);
        else add("contrast-token", name, `colour not understood: ${text}`);
      }
      for (const s of surfaces) {
        if (!value.has(s)) continue;
        const bg = over(value.get(s), [255, 255, 255, 1]);
        for (const t of texts) {
          if (!value.has(t)) continue;
          const got = ratio(over(value.get(t), bg), bg);
          if (got < 4.495) add("contrast-token", `${t} on ${s}`, `${got.toFixed(2)}:1`);
        }
      }
    }

    // 6. Names, 7. Tab stops, 8. target size.
    const controls = [...root.querySelectorAll(CONTROLS)].filter(shown);
    for (const el of controls) {
      if (!accessibleName(el)) add("name", desc(el), el.placeholder ? "only a placeholder" : "no label, aria-label or title");
      if (el.matches(":disabled, [aria-disabled='true']")) continue;
      if (el.tabIndex < 0 && !rovingTab(el)) add("tab", desc(el), "not a Tab stop");
      if (el.matches("input[type=range]")) continue; // the browser's own control
      // A link inside a sentence is as high as its line. Only what flows in
      // the line (display: inline): an inline-block control beside a text has
      // a size of its own and must have 24 px. A <button> is never inline
      // (the browser computes inline-block), so "More" after a hint needs them.
      const parent = el.parentElement;
      if (getComputedStyle(el).display === "inline" && parent && parent.textContent.trim() !== el.textContent.trim()) continue;
      const box = el.matches("input[type=checkbox], input[type=radio]") && el.closest("label") ? el.closest("label") : el;
      const r = box.getBoundingClientRect();
      if (Math.min(r.width, r.height) < 23.5) add("target", desc(el), `${Math.round(r.width)}×${Math.round(r.height)} px`);
    }
    // Something that looks clickable and is no control.
    for (const el of all) {
      if (getComputedStyle(el).cursor !== "pointer") continue;
      if (el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer") continue;
      if (el.closest(`${CONTROLS}, label`)) continue;
      add("tab", desc(el), "clickable, but not a button or link the keyboard reaches");
    }

    // 9. Hints: one line where the room is there, which is a row of 760 px or
    // more in a window of 1600 px or more; two in a narrower row (a column of
    // a page in two columns, the Soundboard's settings panel, Files' side
    // column) and in a smaller window.
    for (const el of all) {
      if (!el.matches(".setting-label .label-hint") || el.matches(NOT_A_HINT) || !(el.innerText || "").trim()) continue;
      const row = el.closest(".setting-row");
      const allowed = window.innerWidth >= 1600 && !el.closest(".sb-col-settings") && (!row || row.getBoundingClientRect().width >= 760) ? 1 : 2;
      const cs = getComputedStyle(el);
      const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
      const lines = Math.round(el.getBoundingClientRect().height / lineHeight);
      if (lines > allowed) add("hint-lines", desc(el), `${lines} lines, ${(el.innerText || "").trim().length} characters`);
    }

    // 10. The sidebar fits the window (asked for at 900×600).
    if (opts.sidebar) {
      let items = 0;
      for (const el of document.querySelectorAll("#sidebar .app-logo, #sidebar #status-indicator, #sidebar .nav-item, #sidebar .sidebar-footer > *")) {
        const r = el.getBoundingClientRect();
        if (r.height <= 0) continue;
        if (el.matches(".nav-item")) items++;
        if (r.bottom > window.innerHeight + 0.5 || r.top < -0.5) add("sidebar", desc(el), `y ${Math.round(r.top)}–${Math.round(r.bottom)}, the window is ${window.innerHeight} px high`);
      }
      if (!items) add("sidebar", "no #sidebar .nav-item", "the check found no sidebar to measure");
    }

    // 11. Ids other code relies on.
    for (const id of opts.ids ?? []) if (!document.getElementById(id)) add("contract", `#${id}`, "this id is gone from the page");

    // 12. Motion, in the whole document (a rule that is wrong is wrong whether its page shows or not).
    const moved = new Map();
    for (const m of motion()) moved.has(m.what) || moved.set(m.what, m.detail);
    for (const [what, detail] of moved) add("motion", what, detail);

    // 13. Running text keeps its measure, in a window wide enough to let a line run on.
    if (window.innerWidth >= MEASURED_FROM) {
      for (const el of all) {
        if (!el.matches(RUNNING)) continue;
        const longest = Math.max(0, ...lineLengths(el));
        if (longest > LINE_MAX) add("measure", desc(el), `a line of ${longest} characters; running text keeps to about 100 a line (--measure), at most ${LINE_MAX}`);
      }
    }
    return out;
  }

  /** The running text that shows under `scope`: how many pieces of it, and the characters of its longest line. */
  function runningText(scope) {
    const found = [...document.querySelectorAll(scope)].flatMap((root) => [...root.querySelectorAll(RUNNING)]).filter(visible);
    return { pieces: found.length, longest: Math.max(0, ...found.flatMap(lineLengths)), most: LINE_MAX };
  }

  let stops = 0;
  /** Number every control under `scope` that Tab must reach; returns their names. */
  function markControls(scope) {
    for (const el of document.querySelectorAll("[data-uic], [data-uic-stop]")) {
      el.removeAttribute("data-uic");
      el.removeAttribute("data-uic-stop");
    }
    stops = 0;
    const root = document.querySelector(scope);
    if (!root) return [];
    const list = [...root.querySelectorAll(CONTROLS)].filter((el) => shown(el) && !el.matches(":disabled, [aria-disabled='true']") && !(el.tabIndex < 0 && rovingTab(el)));
    list.forEach((el, i) => el.setAttribute("data-uic", String(i)));
    return list.map((el, i) => ({ n: String(i), what: desc(el) }));
  }

  /** After a Tab press: which control has the focus, and does it show it? */
  function focusStop() {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    if (!el.hasAttribute("data-uic-stop")) el.setAttribute("data-uic-stop", String(++stops));
    return { stop: el.getAttribute("data-uic-stop"), n: el.getAttribute("data-uic"), what: desc(el), ring: focusRing(el) };
  }

  /** With "prefers-reduced-motion: reduce" nothing may move: what still has an animation or a transition with a duration, or runs one right now. */
  function stillMoving() {
    const out = moving().map((m) => `${m.what}: ${m.kind} ${m.name}`);
    for (const a of document.getAnimations()) out.push(`running: ${a.animationName ?? a.transitionProperty ?? "an animation"}`);
    return [...new Set(out)];
  }

  window.__uic = { collect, markControls, focusStop, stillMoving, runningText };
})();
