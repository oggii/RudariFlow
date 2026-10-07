// A second control for a setting that lives in Settings (Home's quick
// switches, the setup's microphone): it shows the same value and choices,
// and a change goes through the Settings control's own handler. So both
// places always agree, and one place saves.
//
// A handler here cannot see a value that code sets on the source
// (`select.value = …` fires no event): the function each mirror returns
// reads the source again, and src/home.ts calls them after every render.

export function mirrorSelect(source: HTMLSelectElement, copy: HTMLSelectElement): () => void {
  const sync = () => {
    const same =
      copy.options.length === source.options.length &&
      [...copy.options].every((o, i) => o.value === source.options[i].value && o.textContent === source.options[i].textContent);
    if (!same) copy.replaceChildren(...[...source.options].map((o) => new Option(o.textContent ?? "", o.value)));
    copy.value = source.value;
    copy.disabled = source.disabled;
  };
  copy.addEventListener("change", () => {
    source.value = copy.value;
    source.dispatchEvent(new Event("change", { bubbles: true }));
    // The source's handler may refuse the choice (a download that fails).
    sync();
  });
  source.addEventListener("change", sync);
  // The choices are filled in again after a language change.
  new MutationObserver(sync).observe(source, { childList: true, attributes: true, attributeFilter: ["disabled"] });
  sync();
  return sync;
}

/** A second place for the notes under a Settings control (why "Write in"
 *  does nothing at the moment): the text of every note that shows. With none
 *  the copy is hidden and empty, so a control it describes has nothing read out. */
export function mirrorHint(sources: HTMLElement[], copy: HTMLElement): () => void {
  const sync = () => {
    const text = sources
      .filter((source) => !source.classList.contains("hidden"))
      .map((source) => (source.textContent ?? "").trim())
      .filter(Boolean)
      .join(" ");
    if (copy.textContent !== text) copy.textContent = text;
    copy.classList.toggle("hidden", text === "");
  };
  // A note is written and shown by its own page, with no event to hear.
  for (const source of sources) {
    new MutationObserver(sync).observe(source, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }
  sync();
  return sync;
}

export function mirrorSwitch(source: HTMLInputElement, copy: HTMLInputElement): () => void {
  const sync = () => {
    copy.checked = source.checked;
    copy.disabled = source.disabled;
  };
  copy.addEventListener("change", () => {
    source.checked = copy.checked;
    source.dispatchEvent(new Event("change", { bubbles: true }));
  });
  source.addEventListener("change", sync);
  sync();
  return sync;
}
