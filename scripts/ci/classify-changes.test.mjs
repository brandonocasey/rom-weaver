import assert from "node:assert/strict";
import test from "node:test";

import { classifyChanges } from "./classify-changes.mjs";

const classify = (...paths) => Object.fromEntries(Object.entries(classifyChanges(paths)).map(([key, value]) => [key, String(value)]));

test("documentation changes skip compiled stacks", () => assert.deepEqual(classify("README.md", "docs/ci.md"), { rust: "false", webapp: "false", security: "false", docker_cli: "false", docker_webapp: "false", repo_lint: "false", full: "false" }));
test("webapp changes reuse wasm and skip Rust", () => assert.equal(classify("packages/rom-weaver-webapp/src/index.tsx").webapp, "true"));
test("Docker changes select only the affected images", () => {
  assert.equal(classify("Dockerfile").docker_cli, "true");
  assert.equal(classify("packages/rom-weaver-webapp/Dockerfile").docker_webapp, "true");
  assert.equal(classify(".dockerignore").docker_cli, "true");
});
test("Rust test-only changes select Rust alone", () => assert.equal(classify("crates/rom-weaver-cli/tests/cli_smoke/apply.rs").webapp, "false"));
test("native package and Node script changes select the release stacks", () => {
  assert.equal(classify("packages/rom-weaver-cli-platforms/linux-arm64-musl/package.json").rust, "true");
  assert.equal(classify("scripts/ci/classify-changes.mjs").full, "true");
});
test("dependency and workflow changes select their broader checks", () => {
  assert.equal(classify("Cargo.lock").security, "true");
  assert.equal(classify(".github/workflows/ci.yml").full, "true");
});
