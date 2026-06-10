import { type ReactNode, useState } from "react";

/**
 * Candidate-selection tree. Presentational list of files found inside an
 * archive; selectable rows invoke `onSelect`, non-selectable rows render dimmed
 * with an explanatory note. Used inside the selection modal.
 */

const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

type SelectionItem = {
  id: string;
  name: ReactNode;
  sizeLabel?: ReactNode;
  note?: ReactNode;
  /** Archive-nesting path of the entry (e.g. "B_disc1.zip"), rendered as a sub-line for context. */
  breadcrumb?: string;
  matches?: boolean;
  selectable: boolean;
};

const SelectionRowBody = ({ item }: { item: SelectionItem }) => (
  <div className="selmain">
    <span className="selname">
      <span className="fnm">{item.name}</span>
      {item.breadcrumb ? <span className="selpath">{item.breadcrumb}</span> : null}
    </span>
    <span className="selmeta">
      {item.matches ? <span className="matches">matches patch</span> : null}
      {item.note ? <span className="seldim">{item.note}</span> : null}
      {item.sizeLabel ? <span className="selsize">{item.sizeLabel}</span> : null}
    </span>
  </div>
);

const SelectionTree = ({ items, onSelect }: { items: SelectionItem[]; onSelect: (id: string) => void }) => (
  // Selectable entries are real buttons (native keyboard + focus); the rest are
  // inert dimmed rows.
  <div className="seltree">
    {items.map((item) =>
      item.selectable ? (
        <button className={join("selnode", "selrow")} key={item.id} onClick={() => onSelect(item.id)} type="button">
          <SelectionRowBody item={item} />
        </button>
      ) : (
        <div className={join("selnode", "selrow", "off")} key={item.id}>
          <SelectionRowBody item={item} />
        </div>
      ),
    )}
  </div>
);

/**
 * Multi-select candidate list: selectable rows are checkboxes (selection order is preserved) and a
 * confirm button submits the chosen ids. Used when a source exposes several patches that may each be
 * added to the patch stack.
 */
const SelectionCheckList = ({
  items,
  onSubmit,
  submitLabel,
}: {
  items: SelectionItem[];
  onSubmit: (ids: string[]) => void;
  submitLabel?: (count: number) => string;
}) => {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectableItems = items.filter((item) => item.selectable);
  const allSelected = selectableItems.length > 0 && selectableItems.every((item) => selectedIds.includes(item.id));
  const toggle = (id: string) =>
    setSelectedIds((previous) =>
      previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id],
    );
  const toggleAll = () => setSelectedIds(allSelected ? [] : selectableItems.map((item) => item.id));
  return (
    <div className="selcheckwrap">
      {selectableItems.length > 1 ? (
        <div className="seltoolbar">
          <button className="btn ghost selall" onClick={toggleAll} type="button">
            {allSelected ? "Clear all" : "Select all"}
          </button>
          <span className="selcount">
            {selectedIds.length} of {selectableItems.length} selected
          </span>
        </div>
      ) : null}
      <div className="seltree">
        {items.map((item) =>
          item.selectable ? (
            <label className={join("selnode", "selrow", "selcheck")} key={item.id}>
              <input checked={selectedIds.includes(item.id)} onChange={() => toggle(item.id)} type="checkbox" />
              <SelectionRowBody item={item} />
            </label>
          ) : (
            <div className={join("selnode", "selrow", "off")} key={item.id}>
              <SelectionRowBody item={item} />
            </div>
          ),
        )}
      </div>
      <div className="selfoot">
        <button
          className="btn primary selconfirm"
          disabled={!selectedIds.length}
          onClick={() => onSubmit(selectedIds)}
          type="button"
        >
          {submitLabel ? submitLabel(selectedIds.length) : `Add ${selectedIds.length} selected`}
        </button>
      </div>
    </div>
  );
};

export { SelectionCheckList, type SelectionItem, SelectionTree };
