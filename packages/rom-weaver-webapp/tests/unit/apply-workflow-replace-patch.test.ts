import { describe, expect, it, vi } from "vitest";

import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";

type ProbeStage = {
  source: { name: string };
  state: {
    id: string;
    fileName: string;
    role: "patch";
    status: "ready";
    candidates: never[];
    warnings: never[];
    patchValidation?: { status: string; validationKey: string };
  };
};

// A staged patch shaped just enough for replacePatchAt's slot bookkeeping (no runtime staging).
const stage = (id: string, name: string): ProbeStage => ({
  source: { name },
  state: {
    candidates: [],
    fileName: name,
    id,
    patchValidation: { status: "valid", validationKey: `key:${name}` },
    role: "patch",
    status: "ready",
    warnings: [],
  },
});

describe("ApplyWorkflowController.replacePatchAt", () => {
  it("swaps one slot in place, preserving every other patch's stage and cached verdict", async () => {
    const releaseOwnedSources = vi.fn(async () => undefined);
    const controller = new ApplyWorkflowController<{ name: string }, unknown>(
      { workerIo: { releaseOwnedSources } } as never,
      {},
    ) as never as {
      replacePatchAt: (index: number, patch: { name: string }) => Promise<void>;
      patches: ProbeStage[];
      stageSource: unknown;
      resolvePatchSelectionChoice: unknown;
      maybeResolveBlockingPatchSelection: unknown;
      evaluatePatchReadiness: unknown;
      emitPatchAwaitingInputProgress: unknown;
      releaseRuntimeSources: unknown;
      releaseOwnedSources: unknown;
      retainOwnedSources: unknown;
      recomputeOutputState: unknown;
    };
    // Isolate replacePatchAt's slot bookkeeping from the heavy staging/release machinery.
    controller.stageSource = vi.fn(async (staged: unknown) => staged);
    controller.resolvePatchSelectionChoice = vi.fn(async () => undefined);
    controller.maybeResolveBlockingPatchSelection = vi.fn(async () => undefined);
    controller.evaluatePatchReadiness = vi.fn(async () => undefined);
    controller.emitPatchAwaitingInputProgress = vi.fn();
    controller.releaseRuntimeSources = vi.fn(async () => undefined);
    controller.releaseOwnedSources = vi.fn(async () => undefined);
    controller.retainOwnedSources = vi.fn();
    controller.recomputeOutputState = vi.fn();

    const original = stage("patch-original", "change.ips");
    const sibling = stage("patch-sibling", "extra.ips");
    controller.patches = [original, sibling];

    await controller.replacePatchAt(0, { name: "change2.ips" });

    // The untouched sibling keeps its exact stage object AND its cached deep-validation verdict.
    expect(controller.patches[1]).toBe(sibling);
    expect(controller.patches[1]?.state.patchValidation).toEqual({ status: "valid", validationKey: "key:extra.ips" });
    // The swapped slot is a fresh stage for the new file, reusing the replaced slot's id so the target
    // chain's validation fingerprint (its ordered member ids) is unchanged - the sibling's cached
    // verdict still matches and is not re-validated.
    expect(controller.patches[0]).not.toBe(original);
    expect(controller.patches[0]?.source).toEqual({ name: "change2.ips" });
    expect(controller.patches[0]?.state.id).toBe("patch-original");
    // The replaced patch is a fresh stage with no stale verdict; it re-validates on its own.
    expect(controller.patches[0]?.state.patchValidation).toBeUndefined();
    // The replaced slot's owned source reference is released; the sibling's is not.
    expect(controller.releaseOwnedSources).toHaveBeenCalledWith([original.source]);
    expect(controller.releaseOwnedSources).not.toHaveBeenCalledWith([sibling.source]);
  });

  it("rejects an out-of-range index without disturbing the stack", async () => {
    const controller = new ApplyWorkflowController<{ name: string }, unknown>(
      { workerIo: { releaseOwnedSources: vi.fn(async () => undefined) } } as never,
      {},
    ) as never as {
      replacePatchAt: (index: number, patch: { name: string }) => Promise<void>;
      patches: ProbeStage[];
    };
    const only = stage("patch-only", "only.ips");
    controller.patches = [only];

    await expect(controller.replacePatchAt(3, { name: "nope.ips" })).rejects.toThrow();
    expect(controller.patches).toEqual([only]);
  });
});
