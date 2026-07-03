import { describe, expect, it } from "vitest";
import { discFormatToChdMode, getChdAutoCreateMode } from "../../src/lib/input/rom-specific-file-utils.ts";

describe("discFormatToChdMode", () => {
  it("maps the engine disc_format verdict to a CHD mode", () => {
    expect(discFormatToChdMode("DVD")).toBe("dvd");
    expect(discFormatToChdMode("CD")).toBe("cd");
    expect(discFormatToChdMode("GD-ROM")).toBe("cd");
    expect(discFormatToChdMode(undefined)).toBeUndefined();
    expect(discFormatToChdMode("")).toBeUndefined();
  });
});

describe("getChdAutoCreateMode", () => {
  it("prefers the explicit _chdMode verdict", () => {
    expect(getChdAutoCreateMode({ _chdMode: "dvd", fileName: "disc.cue" })).toBe("dvd");
    expect(getChdAutoCreateMode({ _chdMode: "cd", fileName: "game.iso" })).toBe("cd");
  });

  it("treats a cue path/text as a CD", () => {
    expect(getChdAutoCreateMode({ _chdCueText: 'FILE "x.bin" BINARY', fileName: "game.iso" })).toBe("cd");
  });

  it("uses the Rust _discFormat verdict over the filename", () => {
    // A `.iso` would otherwise fall to the regex and read as DVD; the engine verdict wins.
    expect(getChdAutoCreateMode({ _discFormat: "CD", fileName: "game.iso" })).toBe("cd");
    expect(getChdAutoCreateMode({ _discFormat: "GD-ROM", fileName: "game.iso" })).toBe("cd");
    expect(getChdAutoCreateMode({ _discFormat: "DVD", fileName: "track01.bin" })).toBe("dvd");
  });

  it("falls back to the filename only when no engine verdict exists", () => {
    expect(getChdAutoCreateMode({ fileName: "disc.cue" })).toBe("cd");
    expect(getChdAutoCreateMode({ fileName: "track01.bin" })).toBe("cd");
    expect(getChdAutoCreateMode({ fileName: "game.iso" })).toBe("dvd");
  });
});
