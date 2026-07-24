import assert from "node:assert/strict";
import test from "node:test";

import { assertJobs } from "./assert-jobs.mjs";

const status = (...args) => assertJobs(...args).failed ? 1 : 0;

test("passes when every dependency succeeded", () => assert.equal(status("success", "true", ["a=success", "b=success"]), 0));
test("a skip is only acceptable when the group was not selected", () => {
  assert.equal(status("success", "false", ["a=skipped", "b=skipped"]), 0);
  assert.equal(status("success", "true", ["a=skipped"]), 1);
});
test("fails on any non-success result", () => {
  for (const result of ["failure", "cancelled"]) assert.equal(status("success", "true", [`a=${result}`]), 1);
});
test("fails when the changes job itself did not succeed", () => assert.equal(status("failure", "", ["a=skipped"]), 1));
test("names the offending job", () => assert.match(assertJobs("success", "true", ["webapp-browser=failure"]).output.join("\n"), /webapp-browser/));
