// A file size in words, the same wherever one is shown: a model in a
// dropdown, a download's numbers, the unused models. Pure
// (tests/unit/size.test.ts).

/** "870 MB", "5.0 GB": megabytes as a whole number, gigabytes with one
 *  decimal. What would round to "1000 MB" is "1.0 GB", and nothing is less
 *  than "1 MB". */
export function sizeText(bytes: number): string {
  const mb = Math.max(1, Math.round(bytes / 1e6));
  return mb >= 1000 ? `${(bytes / 1e9).toFixed(1)} GB` : `${mb} MB`;
}
