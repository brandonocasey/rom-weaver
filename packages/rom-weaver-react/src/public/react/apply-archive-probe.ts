import { archiveContainsRomEntry } from "../../lib/input/input-preparation-archive.ts";
import type { ArchiveRomProbe } from "./unified-drop-routing.ts";

/**
 * Probe used by the Apply unified drop surface to tell a ROM archive from a
 * patch container, giving the drop true `--rom-filter` + `--patch-filter`
 * behavior: an archive holding a ROM routes to the ROM bucket (embedded patches
 * are auto-discovered), one without a ROM routes to the patch bucket. Uses the
 * default input-preparation runtime/options — listing entries does not depend on
 * the active workflow settings.
 */
const probeApplyArchiveHasRom: ArchiveRomProbe = (archive) => archiveContainsRomEntry(archive as never, undefined);

export { probeApplyArchiveHasRom };
