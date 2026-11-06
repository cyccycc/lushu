import type { AgentResult, AgentStep, AgentUsage, ClarifyQuestion } from "@lushu/agent";

export type SessionStatus =
  | "draft"
  | "needs_clarify"
  | "running"
  | "awaiting_confirm"
  | "ready"
  | "error";

export type ClarificationState = {
  questions: ClarifyQuestion[];
  assumptions: string[];
  answers: Record<string, string> | null;
  confirmed: boolean;
};

export type FollowUpNote = {
  at: string;
  prompt: string;
  summary: string;
};

export type SessionRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  brief: string;
  planningBrief: string | null;
  status: SessionStatus;
  steps: AgentStep[];
  usage: AgentUsage | null;
  result: AgentResult | null;
  selectedVariantId: string | null;
  errorMessage: string | null;
  clarification: ClarificationState | null;
  followUps: FollowUpNote[];
  ownerEmail: string | null;
};

export type SessionSummary = {
  id: string;
  createdAt: string;
  updatedAt: string;
  brief: string;
  status: SessionStatus;
  title: string | null;
  selectedVariantId: string | null;
  ownerEmail: string | null;
};

export function normalizeSession(raw: SessionRecord): SessionRecord {
  return {
    ...raw,
    planningBrief: raw.planningBrief ?? null,
    clarification: raw.clarification ?? null,
    followUps: raw.followUps ?? [],
    ownerEmail: raw.ownerEmail ?? null,
  };
}
