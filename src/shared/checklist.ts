import type { ChecklistReviewDecision, PreOpChecklist } from './types.ts';

export const CHECKLIST_DECISION_LABELS: Record<ChecklistReviewDecision, string> = {
  apto: 'Apto',
  apto_con_restriccion: 'Apto con restricción',
  no_apto: 'No apto',
};

export interface ReviewChecklistPayload {
  decision: ChecklistReviewDecision;
  note: string;
  /** Create the corrective work order now (only when there are failures and none was generated). */
  createWorkOrder: boolean;
}

/** Returns true when the review was saved. */
export type ReviewChecklistHandler = (checklistId: string, payload: ReviewChecklistPayload) => Promise<boolean>;

/** A checklist with at least one failed item. */
export const checklistHasFailures = (c: Pick<PreOpChecklist, 'items'>) => c.items.some((i) => i.status === 'falla');

/** Checklists with failures that no supervisor has reviewed yet ("Por atender"). */
export const checklistNeedsReview = (c: PreOpChecklist) => checklistHasFailures(c) && !c.review;
