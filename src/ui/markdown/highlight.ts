/**
 * Code-block syntax highlighting via cli-highlight (stage 24).
 *
 * cli-highlight is CommonJS; we wrap it so the rest of the (ESM) UI imports
 * a single `highlightCode` helper and never has to think about interop or
 * about a missing/unknown language throwing. An unknown or absent language
 * degrades to auto-detection, and any failure degrades to the raw code —
 * highlighting is a nicety, never a correctness requirement.
 */

import { highlight } from "cli-highlight";

/**
 * Return `code` with ANSI syntax-highlighting applied. `lang` is the fence
 * info-string (e.g. ```ts → "ts"); empty/unknown languages auto-detect.
 */
export function highlightCode(code: string, lang?: string): string {
  const language = (lang ?? "").trim();
  try {
    return highlight(code, {
      language: language || undefined,
      ignoreIllegals: true,
    });
  } catch {
    return code;
  }
}
