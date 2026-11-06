export type SearchResult = {
  title: string;
  url: string | null;
  snippet: string;
};

export type SearchResponse = {
  query: string;
  provider: "tavily" | "brave" | "stub";
  stub: boolean;
  note?: string;
  results: SearchResult[];
};

export type WeatherDay = {
  date: string;
  summary: string;
  tempMaxC: number | null;
  tempMinC: number | null;
  precipProbability: number | null;
};

export type WeatherReport = {
  query: string;
  resolvedName: string | null;
  timezone: string | null;
  days: WeatherDay[];
  stub: boolean;
  sourceUrl: string | null;
  note?: string;
};

export type ToolMode = "auto" | "stub";
