import { describe, expect, it } from "vitest";
import { detectOutputLikeExtension, requireOutputName } from "../../src/lib/output/output-name-validation.ts";

describe("detectOutputLikeExtension", () => {
  it("flags archive output extensions", () => {
    expect(detectOutputLikeExtension("game.zip")).toBe("zip");
    expect(detectOutputLikeExtension("game.7z")).toBe("7z");
  });

  it("flags rom-specific container output extensions", () => {
    expect(detectOutputLikeExtension("disc.chd")).toBe("chd");
    expect(detectOutputLikeExtension("disc.rvz")).toBe("rvz");
    expect(detectOutputLikeExtension("cart.z3ds")).toBe("z3ds");
  });

  it("flags z3ds subtype extensions", () => {
    expect(detectOutputLikeExtension("cart.zcia")).toBe("zcia");
  });

  it("is case-insensitive", () => {
    expect(detectOutputLikeExtension("Game.ZIP")).toBe("zip");
  });

  it("ignores non-output extensions and bare names", () => {
    expect(detectOutputLikeExtension("game.sfc")).toBeNull();
    expect(detectOutputLikeExtension("game")).toBeNull();
    expect(detectOutputLikeExtension("")).toBeNull();
    expect(detectOutputLikeExtension(null)).toBeNull();
    expect(detectOutputLikeExtension(undefined)).toBeNull();
  });
});

describe("requireOutputName", () => {
  it("returns the trimmed name", () => {
    expect(requireOutputName("  game  ")).toBe("game");
  });

  it("throws when empty", () => {
    expect(() => requireOutputName("   ")).toThrow("output.outputName is required");
  });
});
