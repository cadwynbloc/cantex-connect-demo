/**
 * Splitting a failure into what to read and what to keep.
 *
 * Registry and wallet rejections arrive as a readable sentence followed by up to
 * a thousand characters of Daml interpretation trace. The sentence is what a
 * person can act on; the trace is what makes a bug report possible. Showing both
 * at once buries the first in the second, and showing only the first throws away
 * the evidence — so they are split on the blank line the explanations already
 * insert, and the trace goes behind a fold.
 */

const SPLIT = '\n\n';

/** How much of an unsplit message to show before folding the rest away. */
const MAX_HEADLINE = 240;

export function headline(message: string): string {
  const at = message.indexOf(SPLIT);
  if (at !== -1) return message.slice(0, at);
  // No sentence to lead with — this is raw protocol text. Show a readable amount
  // and let the fold carry the whole thing.
  return message.length > MAX_HEADLINE
    ? `${message.slice(0, MAX_HEADLINE).trimEnd()}…`
    : message;
}

export function detail(message: string): string | null {
  const at = message.indexOf(SPLIT);
  // Trimmed to null rather than returned empty: an explanation that happens to
  // end in blank lines must not render an empty disclosure.
  if (at !== -1) return message.slice(at + SPLIT.length).trim() || null;
  return message.length > MAX_HEADLINE ? message : null;
}
