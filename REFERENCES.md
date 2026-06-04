# REFERENCES

This file collects patch/container/compression references used by `rom-weaver`.

It is intentionally a living document. Some patch families do not have stable formal specs; in those cases, canonical behavior is documented through widely used implementations.

## Patch Format Specs

- IPS: <https://zerosoft.zophar.net/ips.php>
- BPS (Beat Patching System): <https://floating.muncher.se/byuu/bps/bps_spec.html>
- VCDIFF: RFC 3284 <https://www.rfc-editor.org/rfc/rfc3284.html>
- DLDI (Dynamically Linked Device Interface): <https://www.chishm.com/DLDI/>
- BSDIFF family background paper: <https://www.daemonology.net/papers/bsdiff.pdf>

## Patch Reference Implementations

### Upstream / External

- RomPatcher.js format modules (many ROM patch families):
  - <https://github.com/marcrobledo/RomPatcher.js/tree/master/rom-patcher-js/modules>
  - BPS: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.bps.js>
  - IPS/IPS32/EBP: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.ips.js>
  - UPS: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.ups.js>
  - VCDIFF/xdelta: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.vcdiff.js>
  - APS (N64): <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.aps_n64.js>
  - APSGBA: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.aps_gba.js>
  - RUP: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.rup.js>
  - PPF: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.ppf.js>
  - PMSR/MOD: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.pmsr.js>
  - BDF/BSDIFF40: <https://github.com/marcrobledo/RomPatcher.js/blob/master/rom-patcher-js/modules/RomPatcher.format.bdf.js>
- Floating IPS / Flips (IPS/BPS creation quality reference):
  - <https://github.com/Alcaro/Flips>
  - IPS delta creator: <https://github.com/Alcaro/Flips/blob/master/libips.cpp>
  - BPS suffix-array delta creator: <https://github.com/Alcaro/Flips/blob/master/libbps-suf.cpp>
- MultiPatch (macOS reference app; PPF routes through ApplyPPF/MakePPF):
  - <https://github.com/Sappharad/MultiPatch>
  - PPF adapter: <https://github.com/Sappharad/MultiPatch/blob/master/adapters/PPFAdapter.m>
  - PPF apply implementation: <https://github.com/Sappharad/MultiPatch/blob/master/ppfdev/applyppf3_linux.c>
  - PPF create implementation: <https://github.com/Sappharad/MultiPatch/blob/master/ppfdev/makeppf3_linux.c>
- xdelta3 (VCDIFF-compatible toolchain): <https://github.com/jmacd/xdelta>
- open-vcdiff (RFC 3284 implementation): <https://github.com/google/open-vcdiff>

### In-Repo (`rom-weaver`) Implementations

- Patch registry: [`crates/rom-weaver-patches/src/lib.rs`](crates/rom-weaver-patches/src/lib.rs)
- Handlers directory: [`crates/rom-weaver-patches/src/`](crates/rom-weaver-patches/src/)

## Container / Compression Specs

- ZIP APPNOTE (PKWARE): <https://support.pkware.com/pkzip/appnote>
- zlib format: RFC 1950 <https://www.rfc-editor.org/rfc/rfc1950>
- DEFLATE format: RFC 1951 <https://www.rfc-editor.org/rfc/rfc1951>
- gzip format: RFC 1952 <https://www.rfc-editor.org/rfc/rfc1952.html>
- XZ format specification: <https://tukaani.org/xz/format.html>
- Zstandard format: RFC 8878 <https://datatracker.ietf.org/doc/html/rfc8878>
- CHD tooling/docs (`chdman`): <https://docs.mamedev.org/tools/chdman.html>

## Quick Mapping For `rom-weaver` Patch Families

| `rom-weaver` format   | Primary reference(s)                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| `IPS`, `IPS32`, `EBP` | IPS spec, Flips IPS delta creator, RomPatcher.js IPS implementation       |
| `BPS`                 | byuu BPS spec, Flips BPS delta creator, RomPatcher.js BPS implementation  |
| `UPS`                 | RomPatcher.js UPS implementation                                          |
| `VCDIFF`, `xdelta`    | RFC 3284, xdelta3, open-vcdiff, RomPatcher.js VCDIFF implementation       |
| `GDIFF`               | `rom-weaver` handler implementation (no single canonical spec linked yet) |
| `APS`, `APSGBA`       | RomPatcher.js APS/APSGBA implementations                                  |
| `RUP`                 | RomPatcher.js RUP implementation                                          |
| `PPF`                 | RomPatcher.js PPF implementation, MultiPatch/ApplyPPF                     |
| `PAT` / `FFP`         | `rom-weaver` handler implementation (public spec is scarce)               |
| `BDF/BSDIFF40`        | BSDIFF paper, RomPatcher.js BDF implementation                            |
| `BSP`                 | `rom-weaver` BSP implementation                                           |
| `MOD` / `PMSR`        | RomPatcher.js PMSR implementation                                         |
| `DLDI`                | Chishm DLDI page, `rom-weaver` DLDI implementation                        |
| `DPS`                 | `rom-weaver` DPS implementation                                           |
| `SOLID`               | `rom-weaver` SOLID implementation                                         |

## PPF Comparison: MultiPatch / ApplyPPF

Comparison target: MultiPatch `master`, whose PPF path wraps Icarus/Paradox
`ApplyPPF3.c` and `MakePPF3.c`.

| Area | MultiPatch / ApplyPPF | `rom-weaver` |
| ---- | --------------------- | ------------ |
| Apply mode | GUI apply calls `applyPPF`, which always uses APPLY mode. PPF3 undo data is skipped unless the separate command-line undo mode is used. | Normal apply always writes forward patch bytes. PPF3 undo data is parsed and reported, but not auto-applied. |
| Validation | PPF2 validates original size and the block at `0x9320`; PPF3 validates `0x9320` for BIN and `0x80A0` for GI when blockcheck is enabled. | Uses the same validation offsets under strict checksum validation; the shared ignore mode can skip blockcheck bytes. |
| File IDs | Supports PPF2/PPF3 `file_id.diz` trailers when the footer magic/length marker is present. | Skips PPF2 and PPF3 trailers during file parsing, including the 2-byte PPF3 trailer and padded 4-byte variant. |
| Create | Creates PPF3 with BIN image type, blockcheck enabled by default, no undo by default, and optional CLI switches for undo, validation, image type, description, and file ID. | Creates PPF3 forward patches with BIN-style blockcheck when the source is large enough; no explicit undo/file-id/image-type options yet. |

## Notes

- If you add a new patch format, append at least one spec link (if available) and one implementation link.
- For formats without a reliable formal spec, capture behavior with cross-implementation tests and cite those implementation sources here.
