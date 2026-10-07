// A download's bar and its numbers, the same wherever a model downloads
// (Home's steps, the two model rows in Settings). The bar is a progress bar
// to a screen reader too: it has the percent and the sizes, and nothing
// reads them out by itself. What is said aloud of a download is its start
// and its end, by the page that shows it.
import { t } from "./i18n";
import { failureWords, progressWords, type DownloadProgress } from "./setup.ts";

export type { DownloadProgress };

export interface ProgressParts {
  /** The track: `role="progressbar"`, named after its row's label. */
  bar: HTMLElement;
  fill: HTMLElement;
  /** The line under the bar: always percent and size. Not a live region. */
  numbers: HTMLElement;
}

/** The download as it stands now. Before its first report: 0 %. */
export const NOT_STARTED: DownloadProgress = { downloaded: 0, total: 0, percent: 0 };

/** Draw a download's progress; returns the whole percent it shows. */
export function showProgress(parts: ProgressParts, p: DownloadProgress): number {
  const words = progressWords(p, t("progress_numbers"), t("progress_said"));
  parts.fill.style.width = `${words.percent}%`;
  if (parts.numbers.textContent !== words.shown) parts.numbers.textContent = words.shown;
  parts.bar.setAttribute("aria-valuenow", String(words.percent));
  parts.bar.setAttribute("aria-valuetext", words.said);
  return words.percent;
}

/** "The download of Tiny · 75 MB did not finish. Check your internet
 *  connection and try again. Reason: …": the one sentence for a model's
 *  download that failed, wherever it is said (the model's row, Home's step,
 *  the AI's state line). `reason` is what the backend answered; "" for none. */
export function downloadFailure(model: string, reason: string): string {
  return failureWords(t("setup_download_failed"), t("download_reason"), model, reason);
}
