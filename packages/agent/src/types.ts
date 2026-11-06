import type { SearchResponse, WeatherReport } from "@lushu/tools";

export type Theme =
  | "food"
  | "family"
  | "rain"
  | "slow"
  | "budget"
  | "classic"
  | "outbound"
  | "business";

export type PartyKind = "solo" | "couple" | "family" | "friends" | "business" | "unknown";

export type Party = {
  summary: string;
  count: number | null;
  kind: PartyKind;
};

export type TripSpec = {
  destinations: string[];
  origin: string | null;
  days: number;
  daysAssumed: boolean;
  party: Party;
  budgetText: string | null;
  budgetAmountCny: number | null;
  budgetTight: boolean;
  themes: Theme[];
  constraints: string[];
  whenLabel: string | null;
  rawBrief: string;
};

export type ItineraryItem = {
  time: string;
  title: string;
  detail: string;
  area?: string;
  estCost?: string;
};

export type DayWeather = {
  city: string;
  date: string | null;
  condition: string;
  tempMinC: number | null;
  tempMaxC: number | null;
  precipProbability: number | null;
  available: boolean;
  note: string;
};

export type ItineraryDay = {
  day: number;
  title: string;
  city: string;
  theme: string;
  items: ItineraryItem[];
  meals: string[];
  stayNote: string;
  rainPlanB: string;
  weather?: DayWeather;
};

export type PlanSupplement = {
  id: string;
  title: string;
  body: string;
  kind: "hotel" | "taxi" | "revise" | "note";
};

export type SourceKind = "search" | "weather" | "stub" | "model" | "local";

export type Source = {
  title: string;
  url?: string;
  kind: SourceKind;
  note?: string;
};

export type PlanVariant = {
  id: string;
  title: string;
  style: string;
  summary: string;
  pace: string;
  budgetNote: string;
  suitability: string;
  days: ItineraryDay[];
  sources: Source[];
  assumptions: string[];
  warnings: string[];
  supplements?: PlanSupplement[];
  aiGenerated: true;
};

export type AgentPhase = "planning" | "searching" | "synthesizing" | "awaiting_confirm";

export type AgentStep = {
  id: string;
  phase: AgentPhase;
  title: string;
  detail: string;
  status: "running" | "done" | "skipped" | "error";
  startedAt: string;
  finishedAt?: string;
};

export type AgentUsage = {
  steps: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  estimatedUsd: number;
  maxSteps: number;
  maxToolCalls: number;
  maxCostUsd: number;
  limitReached?: string;
};

export type AgentMode = "llm" | "fallback";

export type ToolBundle = {
  searches: SearchResponse[];
  weather: WeatherReport[];
};

export type AgentResult = {
  spec: TripSpec;
  variants: PlanVariant[];
  contrast: string;
  steps: AgentStep[];
  usage: AgentUsage;
  mode: AgentMode;
  modeNote: string;
  aiGenerated: true;
};

export type AgentLimits = {
  maxSteps: number;
  maxToolCalls: number;
  maxCostUsd: number;
};
