import type { SelectionCandidate } from "./selection.ts";
import type { WorkflowWarning } from "./workflow-controller.ts";

type CreateWorkflowSourceStatus = "empty" | "failed" | "loading" | "needsSelection" | "ready";

type CreateWorkflowSourceState = {
  id: string;
  fileName?: string;
  status: CreateWorkflowSourceStatus;
  candidates: SelectionCandidate[];
  selectedCandidateId?: string;
  size?: number;
  sourceSize?: number;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
  warnings: WorkflowWarning[];
};

export type { CreateWorkflowSourceState, CreateWorkflowSourceStatus };
