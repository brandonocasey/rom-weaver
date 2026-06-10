import { expect, test } from "vitest";
import {
  collectRomDropFiles,
  routeByOrder,
  routeByTypeProbed,
  routeSingleRom,
} from "../../src/public/react/unified-drop-routing.ts";

const file = (name) => new File([], name);
const names = (files) => files.map((entry) => (entry ? entry.name : null));

test("routeByTypeProbed sorts roms to inputs and patches to patches", async () => {
  const routed = await routeByTypeProbed([file("game.sfc"), file("hack.ips")], () => true);
  expect(names(routed.inputs)).toEqual(["game.sfc"]);
  expect(names(routed.patches)).toEqual(["hack.ips"]);
});

test("routeByTypeProbed routes an archive by its probed ROM contents", async () => {
  const asRom = await routeByTypeProbed([file("bundle.zip")], () => true);
  expect(names(asRom.inputs)).toEqual(["bundle.zip"]);
  expect(names(asRom.patches)).toEqual([]);

  const asPatch = await routeByTypeProbed([file("bundle.zip")], () => false);
  expect(names(asPatch.inputs)).toEqual([]);
  expect(names(asPatch.patches)).toEqual(["bundle.zip"]);
});

test("routeByTypeProbed defaults a failed archive probe to the rom bucket", async () => {
  const routed = await routeByTypeProbed([file("bundle.zip")], () => {
    throw new Error("probe failed");
  });
  expect(names(routed.inputs)).toEqual(["bundle.zip"]);
  expect(names(routed.patches)).toEqual([]);
});

test("collectRomDropFiles keeps roms and archives but drops patches", () => {
  const roms = collectRomDropFiles([file("game.sfc"), file("hack.ips"), file("bundle.zip")]);
  expect(names(roms)).toEqual(["game.sfc", "bundle.zip"]);
});

test("routeByOrder fills empty slots in drop order", () => {
  expect(names(routeByOrder([file("a.sfc"), file("b.sfc")], [false, false]))).toEqual(["a.sfc", "b.sfc"]);
  expect(names(routeByOrder([file("a.sfc")], [true, false]))).toEqual([null, "a.sfc"]);
});

test("routeByOrder overflows the last dropped rom into the final slot", () => {
  // both slots full -> last dropped wins the final slot
  expect(names(routeByOrder([file("a.sfc")], [true, true]))).toEqual([null, "a.sfc"]);
  // more roms than empty slots -> last overflows
  expect(names(routeByOrder([file("a.sfc"), file("b.sfc"), file("c.sfc")], [false, false]))).toEqual([
    "a.sfc",
    "c.sfc",
  ]);
});

test("routeByOrder ignores patches in the dropped set", () => {
  expect(names(routeByOrder([file("hack.ips"), file("game.sfc")], [false, false]))).toEqual(["game.sfc", null]);
});

test("routeSingleRom returns the first non-patch rom, or null", () => {
  expect(routeSingleRom([file("game.sfc")])?.name).toBe("game.sfc");
  expect(routeSingleRom([file("hack.ips"), file("game.sfc")])?.name).toBe("game.sfc");
  expect(routeSingleRom([file("hack.ips")])).toBeNull();
  expect(routeSingleRom([])).toBeNull();
});
