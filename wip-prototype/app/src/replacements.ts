// Replacements (Settings > Dictionary): say a short phrase, get longer text.
// The rows on the page are the list: `readReplacements` reads every row, so
// the search only hides rows and never removes one.
import { t } from "./i18n";
import { deleteButton, forgetDelete } from "./confirm-delete";
import { matches } from "./search.ts";

export interface Replacement {
  from: string;
  to: string;
}

export interface ReplacementsHost {
  replacements(): Replacement[];
  /** Save the settings (they read the rows through `readReplacements`). */
  save(): Promise<void>;
}

const list = document.getElementById("replacement-list")!;
const empty = document.getElementById("replacement-empty")!;
const noMatch = document.getElementById("replacement-no-match")!;
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

  const actions = document.createElement("div");
  actions.className = "list-actions";
  actions.append(
    deleteButton(id, async () => {
      forgetDelete(id);
      row.remove();
      filter();
      await host.save();
    }),
  );

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
  search.addEventListener("input", filter);
  addButton.addEventListener("click", () => {
    const row = addRow({ from: "", to: "" });
    filter();
    (row.querySelector(".replacement-from") as HTMLInputElement).focus();
  });
}
