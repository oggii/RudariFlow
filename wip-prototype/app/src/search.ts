// The search fields over the lists (recent dictations, dictionary words,
// replacements): every word of the query has to occur, in any order, upper
// or lower case, with or without accents. Pure (tests/unit/search.test.ts).

/** Lower case without accents: "Zürich" → "zurich". */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Whether `query` is found in the `texts` of one row; an empty query finds every row. */
export function matches(texts: (string | null | undefined)[], query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const row = fold(texts.filter(Boolean).join("\n"));
  return words.every((word) => row.includes(word));
}

/** The recent dictations on Home show this many until "Show all". */
export const RECENT = 8;
/** "Show all" and "Show more" add this many. */
export const PAGE = 50;

export interface Shown<T> {
  rows: T[];
  /** Rows the query finds (all rows without a query). */
  found: number;
  /** Rows the next "Show more" adds; 0: everything found is shown. */
  more: number;
  /** The short list is shown and there is more: offer "Show all". */
  canExpand: boolean;
}

/**
 * The rows of a long list to show. Collapsed and without a query: the first
 * RECENT. Expanded, or while searching (a search looks through everything):
 * `pages` chunks of PAGE.
 */
export function shown<T>(all: T[], texts: (row: T) => (string | null | undefined)[], query: string, expanded: boolean, pages: number): Shown<T> {
  const found = all.filter((row) => matches(texts(row), query));
  const searching = query.trim() !== "";
  if (!expanded && !searching) {
    return { rows: found.slice(0, RECENT), found: found.length, more: 0, canExpand: found.length > RECENT };
  }
  const rows = found.slice(0, Math.max(1, pages) * PAGE);
  return { rows, found: found.length, more: Math.min(PAGE, found.length - rows.length), canExpand: false };
}
