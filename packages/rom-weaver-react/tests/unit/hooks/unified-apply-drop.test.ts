// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useUnifiedApplyDrop } from "../../../src/public/react/use-unified-apply-drop.ts";

const file = (name: string) => new File([new Uint8Array([0])], name);

const makeController = () => ({
  providePatchInputFiles: vi.fn(),
  provideRomInputFiles: vi.fn(),
});

describe("useUnifiedApplyDrop", () => {
  it("stages a dropped archive to the ROM bucket with no probe or placeholder", async () => {
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("bundle.zip")]));

    // No pre-extract probe and no placeholder — Rust's nested extract drives, and reclassification
    // to the patch bucket (if the archive turns out to be patch-only) happens later in the session.
    expect(result.current.pendingDrops).toHaveLength(0);
    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledTimes(1));
    expect(controller.provideRomInputFiles.mock.calls[0]?.[0].map((entry: File) => entry.name)).toEqual(["bundle.zip"]);
    expect(controller.providePatchInputFiles).not.toHaveBeenCalled();
  });

  it("stages a patch-only-looking archive to the ROM bucket too (session reclassifies on identify)", async () => {
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("patches.zip")]));

    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledTimes(1));
    expect(controller.provideRomInputFiles.mock.calls[0]?.[0].map((entry: File) => entry.name)).toEqual([
      "patches.zip",
    ]);
    expect(controller.providePatchInputFiles).not.toHaveBeenCalled();
  });

  it("routes bare ROMs to the ROM bucket and bare patches to the patch bucket", async () => {
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("game.nes"), file("hack.ips")]));

    expect(result.current.pendingDrops).toHaveLength(0);
    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledTimes(1));
    expect(controller.provideRomInputFiles.mock.calls[0]?.[0].map((entry: File) => entry.name)).toEqual(["game.nes"]);
    expect(controller.providePatchInputFiles).toHaveBeenCalledTimes(1);
    expect(controller.providePatchInputFiles.mock.calls[0]?.[0].map((entry: File) => entry.name)).toEqual(["hack.ips"]);
  });

  it("does not stage anything when the drop is cancelled", async () => {
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("bundle.zip")], () => true));

    await waitFor(() => expect(result.current.pendingDrops).toHaveLength(0));
    expect(controller.provideRomInputFiles).not.toHaveBeenCalled();
    expect(controller.providePatchInputFiles).not.toHaveBeenCalled();
  });
});
