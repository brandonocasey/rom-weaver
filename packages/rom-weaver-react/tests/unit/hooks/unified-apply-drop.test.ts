// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const probeApplyArchiveHasRom = vi.fn<(archive: File) => Promise<boolean>>();
vi.mock("../../../src/public/react/apply-archive-probe.ts", () => ({
  probeApplyArchiveHasRom: (archive: File) => probeApplyArchiveHasRom(archive),
}));

import { useUnifiedApplyDrop } from "../../../src/public/react/use-unified-apply-drop.ts";

const file = (name: string) => new File([new Uint8Array([0])], name);

const makeController = () => ({
  providePatchInputFiles: vi.fn(),
  provideRomInputFiles: vi.fn(),
});

describe("useUnifiedApplyDrop", () => {
  beforeEach(() => {
    probeApplyArchiveHasRom.mockReset();
  });

  it("shows an instant placeholder for a dropped archive, then routes it to the ROM bucket", async () => {
    probeApplyArchiveHasRom.mockResolvedValue(true);
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("bundle.zip")]));
    // Placeholder appears synchronously, before the probe resolves.
    expect(result.current.pendingDrops).toHaveLength(1);
    expect(result.current.pendingDrops[0]?.name).toBe("bundle.zip");
    expect(controller.provideRomInputFiles).not.toHaveBeenCalled();

    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledTimes(1));
    // The placeholder fades out on its own timeline after staging, so removal is async.
    await waitFor(() => expect(result.current.pendingDrops).toHaveLength(0));
    expect(controller.providePatchInputFiles).not.toHaveBeenCalled();
  });

  it("routes a patch-only archive to the patch bucket after classification", async () => {
    probeApplyArchiveHasRom.mockResolvedValue(false);
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("patches.zip")]));
    expect(result.current.pendingDrops).toHaveLength(1);

    await waitFor(() => expect(controller.providePatchInputFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.pendingDrops).toHaveLength(0));
    expect(controller.provideRomInputFiles).not.toHaveBeenCalled();
  });

  it("stages bare ROMs and patches without any placeholder", async () => {
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("game.nes"), file("hack.ips")]));
    // No archive → no placeholder and no listing probe.
    expect(result.current.pendingDrops).toHaveLength(0);
    expect(probeApplyArchiveHasRom).not.toHaveBeenCalled();

    await waitFor(() => expect(controller.provideRomInputFiles).toHaveBeenCalledTimes(1));
    expect(controller.providePatchInputFiles).toHaveBeenCalledTimes(1);
  });

  it("drops the placeholder without staging when the drop is cancelled", async () => {
    probeApplyArchiveHasRom.mockResolvedValue(true);
    const controller = makeController();
    const { result } = renderHook(() => useUnifiedApplyDrop(controller));

    act(() => result.current.onDrop([file("bundle.zip")], () => true));
    expect(result.current.pendingDrops).toHaveLength(1);

    await waitFor(() => expect(result.current.pendingDrops).toHaveLength(0));
    expect(controller.provideRomInputFiles).not.toHaveBeenCalled();
    expect(controller.providePatchInputFiles).not.toHaveBeenCalled();
  });
});
