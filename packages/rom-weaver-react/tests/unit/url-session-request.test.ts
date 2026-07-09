import { describe, expect, test } from "vitest";
import { readUrlSessionRequest } from "../../src/webapp/url-session/url-session-request.ts";

const BASE = "https://weaver.example/app/index.html";

describe("readUrlSessionRequest", () => {
  test("returns null without session params", () => {
    expect(readUrlSessionRequest("", BASE).request).toBeNull();
    expect(readUrlSessionRequest("?theme=dark", BASE).request).toBeNull();
  });

  test("parses a manifest request and resolves relative urls", () => {
    const { request, warnings } = readUrlSessionRequest("?manifest=packs/rw.json", BASE);
    expect(request).toEqual({
      kind: "manifest",
      manifestUrl: "https://weaver.example/app/packs/rw.json",
    });
    expect(warnings).toEqual([]);
  });

  test("manifest wins over rom/patch shortcuts with a warning", () => {
    const { request, warnings } = readUrlSessionRequest(
      "?manifest=https://host.example/rw.json&rom=https://host.example/game.bin&patch=a.ips",
      BASE,
    );
    expect(request).toEqual({
      kind: "manifest",
      manifestUrl: "https://host.example/rw.json",
    });
    expect(warnings).toHaveLength(1);
  });

  test("parses direct rom plus repeatable ordered patches", () => {
    const { request } = readUrlSessionRequest(
      "?rom=https://host.example/game.bin&patch=https://host.example/a.ips&patch=https://host.example/b.ips",
      BASE,
    );
    expect(request).toEqual({
      kind: "direct",
      patchUrls: ["https://host.example/a.ips", "https://host.example/b.ips"],
      romUrl: "https://host.example/game.bin",
    });
  });

  test("supports patch-only sessions (the user supplies the ROM)", () => {
    const { request } = readUrlSessionRequest("?patch=https://host.example/a.ips", BASE);
    expect(request).toEqual({
      kind: "direct",
      patchUrls: ["https://host.example/a.ips"],
      romUrl: null,
    });
  });

  test("rejects non-http(s) schemes with warnings", () => {
    const { request, warnings } = readUrlSessionRequest("?rom=file:///etc/passwd&patch=javascript:alert(1)", BASE);
    expect(request).toBeNull();
    expect(warnings).toHaveLength(2);
  });
});
