// Replacements (Settings > Dictionary): say a short phrase, get longer text.
// The rows on the page are the list: `readReplacements` reads every row, so
// the search only hides rows and never removes one.
import { t } from "./i18n";
import { deleteButton, forgetDelete, nameDelete } from "./confirm-delete";
import { matches } from "./search.ts";
import { sayFound } from "./dictionary";

export interface Replacement {
  from: string;
  to: string;
}

export interface ReplacementsHost {
  replacements(): Replacement[];
  /** Save the settings (they read the rows through `readReplacements`). A
   *  save the backend refuses is said in the page and the rows go back to
   *  what is saved (src/main.ts); false then. */
  save(): Promise<boolean>;
  /** The same save for a caller that says the failure itself (a row's Delete): it throws. */
  saveStrict(): Promise<void>;
  /** The settings were read from the backend: the rows on the page are the saved ones. */
  loaded(): boolean;
}

const list = document.getElementById("replacement-list")!;
const empty = document.getElementById("replacement-empty")!;
const noMatch = document.getElementById("replacement-no-match")!;
const live = document.getElementById("replacement-live")!;
const cols = document.getElementById("replacement-cols")!;
const search = document.getElementById("replacement-search") as HTMLInputElement;
const addButton = document.getElementById("replacement-add") as HTMLButtonElement;

let host: ReplacementsHost;
/** Numbers the rows, so each has its own Delete. */
let rows = 0;

function rowElements(): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(".replacement-row"));
}

/** Every replacement on the page, hidden by the search or not. */
export function readReplacements(): Replacement[] {
  return rowElements().map((row) => ({
    from: (row.querySelector(".replacement-from") as HTMLInputElement).value,
    to: (row.querySelector(".replacement-to") as HTMLTextAreaElement).value,
  }));
}

/** Show the rows the search finds; the others stay on the page, hidden. */
function filter() {
  let shown = 0;
  for (const row of rowElements()) {
    const from = (row.querySelector(".replacement-from") as HTMLInputElement).value;
    const to = (row.querySelector(".replacement-to") as HTMLTextAreaElement).value;
    // A row that is being typed into (still empty) stays.
    const keep = matches([from, to], search.value) || (!from && !to);
    row.classList.toggle("hidden", !keep);
    if (keep) shown++;
  }
  const any = rowElements().length > 0;
  empty.classList.toggle("hidden", any);
  cols.classList.toggle("hidden", shown === 0);
  search.classList.toggle("hidden", !any);
  noMatch.classList.toggle("hidden", !any || shown > 0);
}

function addRow(r: Replacement): HTMLElement {
  const id = `replacement-${++rows}`;
  const row = document.createElement("div");
  row.className = "list-row replacement-row";
  row.setAttribute("role", "listitem");

  const fields = document.createElement("div");
  fields.className = "replacement-fields";
  const from = document.createElement("input");
  from.type = "text";
  from.className = "replacement-from";
  from.value = r.from;
  from.placeholder = t("replacement_from_placeholder");
  from.setAttribute("aria-label", t("replacement_from_label"));
  from.spellcheck = false;
  const arrow = document.createElement("span");
  arrow.className = "replacement-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "→";
  const to = document.createElement("textarea");
  to.className = "replacement-to";
  to.rows = 1;
  to.value = r.to;
  to.placeholder = t("replacement_to_placeholder");
  to.setAttribute("aria-label", t("replacement_to_label"));
  to.spellcheck = false;
  fields.append(from, arrow, to);
  from.addEventListener("change", () => host.save());
  to.addEventListener("change", () => host.save());

  // The rows on the page are what is saved, so the row goes first. A save
  // that fails puts it back and throws: the button says so (src/confirm-delete.ts).
  const del = deleteButton(
    id,
    async () => {
      const next = row.nextSibling;
      row.remove();
      filter();
      try {
        await host.saveStrict();
        forgetDelete(id);
      } catch (err) {
        list.insertBefore(row, next);
        filter();
        // The settings in memory hold the row again (a save reads the page).
        void host.saveStrict().catch(() => {});
        throw err;
      }
    },
    // After the last row "Add replacement" takes the focus.
    { name: r.from.trim(), after: () => addButton },
  );
  // Delete is named after what the row replaces, as it reads now.
  from.addEventListener("input", () => nameDelete(del, from.value.trim()));
  const actions = document.createElement("div");
  actions.className = "list-actions";
  actions.append(del);

  row.append(fields, actions);
  list.appendChild(row);
  return row;
}

/** Draw the rows from the settings (after loading them or a language change). */
export function renderReplacements() {
  list.replaceChildren();
  for (const r of host.replacements() ?? []) addRow(r);
  filter();
}

export function initReplacements(h: ReplacementsHost) {
  host = h;
  search.addEventListener("input", () => {
    filter();
    const all = rowElements();
    const found = all.filter((row) => !row.classList.contains("hidden")).length;
    sayFound(live, search.value.trim() === "" ? "" : found === 0 ? t("replacement_no_match") : t("replacement_found").replace("{found}", () => String(found)).replace("{n}", () => String(all.length)));
  });
  addButton.addEventListener("click", () => {
    // The rows on the page are what is saved: none is added before the saved ones are drawn.
    if (!host.loaded()) return;
    // A search that is on would hide the new row once it has its text (at
    // the next delete or add, which look at every row again): the search ends.
    if (search.value !== "") {
      search.value = "";
      sayFound(live, "");
    }
    const row = addRow({ from: "", to: "" });
    filter();
    (row.querySelector(".replacement-from") as HTMLInputElement).focus();
  });
}
