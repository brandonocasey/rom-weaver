import assert from "node:assert/strict";
import test from "node:test";

import { compilerArguments, normalizeCompilerArgs } from "./wasm32-wasip1-threads.mjs";

test("normalizes legacy WASI target spellings", () => {
  assert.deepEqual(normalizeCompilerArgs(["-target", "wasm32-wasi"]), { base: [], normalized: ["-target", "wasm32-wasip1-threads"] });
  assert.deepEqual(normalizeCompilerArgs(["--target=wasm32-wasi-threads"]), { base: [], normalized: ["--target=wasm32-wasip1-threads"] });
  assert.deepEqual(normalizeCompilerArgs(["-O2"]).base, ["--target=wasm32-wasip1-threads"]);
});

test("adds the sysroot and liblzma threading shim only to C builds", () => {
  assert.deepEqual(compilerArguments(["liblzma-sys", "-O2"], { sysroot: "/sdk/sysroot", threadingHeader: "/shim.h", forceThreadHeader: true }), ["--sysroot=/sdk/sysroot", "--target=wasm32-wasip1-threads", "-D_WASI_EMULATED_SIGNAL", "-include", "/shim.h", "liblzma-sys", "-O2"]);
  assert.deepEqual(compilerArguments(["liblzma-sys"], { threadingHeader: "/shim.h", forceThreadHeader: false }), ["--target=wasm32-wasip1-threads", "liblzma-sys"]);
});
