import logoSvg from "../../assets/app/root/logo.svg?raw";
import { ACCENTS, DEFAULT_ACCENT, useAccent } from "../accent.ts";

/**
 * The masthead logo, re-dyed to match the active accent.
 *
 * An `<img src="logo.svg">` is a separate document, so CSS could never reach
 * inside it and the mark stayed madder-orange in every dye lot. The file is
 * inlined at build time instead (`?raw`, no extra request), its two accent
 * colours swapped for the selected dye's, and the result handed back as a data
 * URI - still an `<img>`, so nothing is injected into the page.
 *
 * Only the accent hues move; the chassis darks, cream and green are the mark's
 * own palette and stay put in every accent.
 */

const ACCENT_SOURCE = "#d9690f";
const HIGHLIGHT_SOURCE = "#fccb90";

const dataUriCache = new Map<string, string>();

const toDataUri = (accentValue: string): string => {
  const cached = dataUriCache.get(accentValue);
  if (cached) return cached;
  const accent = ACCENTS.find((entry) => entry.value === accentValue) ?? ACCENTS[0];
  const tinted = logoSvg.replaceAll(ACCENT_SOURCE, accent.swatch).replaceAll(HIGHLIGHT_SOURCE, accent.highlight);
  if (tinted.includes(ACCENT_SOURCE) && accent.value !== DEFAULT_ACCENT) {
    throw new Error(`brand mark: ${ACCENT_SOURCE} survived the ${accent.value} tint - logo.svg palette changed?`);
  }
  // encodeURIComponent, not base64: the payload is text, and this keeps it
  // legible in devtools at a comparable size.
  const uri = `data:image/svg+xml,${encodeURIComponent(tinted)}`;
  dataUriCache.set(accentValue, uri);
  return uri;
};

/**
 * `alt=""`: the brand word beside the mark already reads "rom-weaver", so a
 * second announcement of the same name is noise.
 */
const BrandMark = () => <img alt="" className="brand-mark" height={44} src={toDataUri(useAccent())} width={44} />;

export { BrandMark };
