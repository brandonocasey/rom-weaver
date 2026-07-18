// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SelectionCheckList, type SelectionItem } from "../../../src/public/react/components/ds/selection.tsx";

const items: SelectionItem[] = [
  { id: "patch-a", name: "patch-a.ips", selectable: true },
  { id: "patch-b", name: "patch-b.ips", selectable: true },
];

describe("SelectionCheckList", () => {
  it("selects all patches by default and can clear or restore them", () => {
    const onSubmit = vi.fn();
    const { getAllByRole, getByRole } = render(
      <SelectionCheckList items={items} onSubmit={onSubmit} submitLabel={(count) => `Add ${count} patches`} />,
    );

    expect(getAllByRole("checkbox").every((checkbox) => (checkbox as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(getByRole("button", { name: "Clear all" }));
    expect(getAllByRole("checkbox").every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);

    fireEvent.click(getByRole("button", { name: "Select all" }));
    fireEvent.click(getByRole("button", { name: "Add 2 patches" }));
    expect(onSubmit).toHaveBeenCalledWith(["patch-a", "patch-b"]);
  });
});
