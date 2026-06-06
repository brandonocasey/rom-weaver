import { expect, test } from "vitest";
import {
  getDiscExtractedFileName,
  resolveAutomaticCompressionFormat,
} from "../../src/lib/compression/container-format-registry.ts";
import OutputCompressionManager from "../../src/lib/compression/output-compression-manager.ts";

test("automatic output format uses the innermost parent compression after nested extraction", () => {
  expect(
    resolveAutomaticCompressionFormat({
      parentCompressions: [{ kind: "7z" }, { kind: "rvz" }],
      sourceFileName: "game.iso",
    }),
  ).toBe("rvz");
});

test("automatic output format falls back to outer known parent compression when inner kind is unknown", () => {
  expect(
    resolveAutomaticCompressionFormat({
      parentCompressions: [{ kind: "7z" }, { kind: "unknown-format" }],
      sourceFileName: "game.iso",
    }),
  ).toBe("7z");
});

test("automatic output format uses unambiguous special compression input extensions", () => {
  expect(resolveAutomaticCompressionFormat({ fallback: "zip", sourceFileName: "game.gcm" })).toBe("rvz");
  expect(resolveAutomaticCompressionFormat({ fallback: "zip", sourceFileName: "game.wbfs" })).toBe("rvz");
  expect(resolveAutomaticCompressionFormat({ fallback: "zip", sourceFileName: "disc.cue" })).toBe("chd");
  expect(resolveAutomaticCompressionFormat({ fallback: "zip", sourceFileName: "game.cci" })).toBe("z3ds");
});

test("z3ds browser extraction names preserve subtype extensions", () => {
  expect(getDiscExtractedFileName("z3ds", { fileName: "game.zcci" })).toBe("game.cci");
  expect(getDiscExtractedFileName("z3ds", { fileName: "game.zcia" })).toBe("game.cia");
  expect(getDiscExtractedFileName("z3ds", { fileName: "game.zcxi" })).toBe("game.cxi");
  expect(getDiscExtractedFileName("z3ds", { fileName: "game.z3dsx" })).toBe("game.3dsx");
  expect(getDiscExtractedFileName("z3ds", { _z3dsUnderlyingMagic: "NCSD", fileName: "game.z3ds" })).toBe("game.cci");
  expect(getDiscExtractedFileName("z3ds", { _z3dsUnderlyingMagic: "NCCH", fileName: "game.z3ds" })).toBe("game.cxi");
  expect(getDiscExtractedFileName("z3ds", { _z3dsUnderlyingMagic: "CIA\u0000", fileName: "game.z3ds" })).toBe(
    "game.cia",
  );
  expect(getDiscExtractedFileName("z3ds", { _z3dsUnderlyingMagic: "3DSX", fileName: "game.z3ds" })).toBe("game.3dsx");
  expect(getDiscExtractedFileName("z3ds", { fileName: "game.z3ds" })).toBe("game.3ds");
});

test("automatic output format does not guess for iso without compression context", () => {
  expect(resolveAutomaticCompressionFormat({ fallback: "zip", sourceFileName: "game.iso" })).toBe("zip");
  expect(
    OutputCompressionManager.resolveOutputCompression(
      { fileName: "game.iso" },
      {
        compressionFormat: "auto",
      },
    ),
  ).toBe("7z");
});
