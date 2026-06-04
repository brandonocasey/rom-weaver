import type { CandidateSelectionRequest } from "../../types/selection.ts";
import { toRomWeaverError } from "../errors.ts";

const canRecoverWithCandidateSelection = (error: unknown, requests: CandidateSelectionRequest[]) => {
  if (!requests.length) return false;
  const normalized = toRomWeaverError(error);
  return normalized.code === "AMBIGUOUS_SELECTION";
};

export { canRecoverWithCandidateSelection };
