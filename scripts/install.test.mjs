import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { detectPlatform, install } from "../install.mjs";

test("installs the checksummed binary for the host platform", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-install-"));
  try {
    const installDirectory = join(directory, "install");
    const binary = Buffer.from("binary\n");
    const checksum = `${createHash("sha256").update(binary).digest("hex")}  rom-weaver-darwin-arm64\n`;
    const urls = [];
    const fetchImpl = async (url) => ({ ok: true, status: 200, arrayBuffer: async () => url.endsWith(".sha256") ? Buffer.from(checksum) : binary });
    await install({
      fetchImpl,
      system: "darwin",
      machine: "arm64",
      env: { HOME: directory, PATH: "/usr/bin:/bin", ROM_WEAVER_INSTALL_DIR: installDirectory, SHELL: "/bin/zsh", ZDOTDIR: directory },
    });
    assert.equal(readFileSync(join(installDirectory, "rom-weaver"), "utf8"), "binary\n");
    assert.deepEqual(urls, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("selects Linux musl assets by architecture", () => {
  assert.equal(detectPlatform({ system: "linux", machine: "arm64" }), "linux-arm64-musl");
  assert.equal(detectPlatform({ system: "linux", machine: "ia32" }), "linux-ia32-musl");
  assert.equal(detectPlatform({ system: "linux", machine: "x64" }), "linux-x64-musl");
  assert.equal(detectPlatform({ system: "linux", machine: "x64", glibc: "2.39" }), "linux-x64-gnu");
});
