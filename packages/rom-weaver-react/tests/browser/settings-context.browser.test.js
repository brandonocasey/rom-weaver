import { expect, test, vi } from "vitest";
import { toApplyWorkflowSettings, toCreateWorkflowSettings } from "../../src/public/react/settings-context.tsx";

test("apply settings provide a default logging sink when one is not configured", () => {
  const settings = toApplyWorkflowSettings({
    logging: {
      level: "trace",
    },
  });

  expect(settings.logging?.level).toBe("trace");
  expect(typeof settings.logging?.sink).toBe("function");
  expect(() =>
    settings.logging?.sink?.({
      level: "trace",
      message: "trace-check",
      namespace: "runtime:test",
      timestamp: new Date().toISOString(),
    }),
  ).not.toThrow();
});

test("create settings keep an explicit logging sink", () => {
  const sink = vi.fn();
  const settings = toCreateWorkflowSettings(
    {
      logging: {
        level: "debug",
        sink,
      },
    },
    "output.ips",
  );

  expect(settings.logging?.level).toBe("debug");
  expect(settings.logging?.sink).toBe(sink);
});
