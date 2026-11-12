# Architecture

The homepage is a structured roadbook, not the older two-plan picker.

```
apps/web                         Next.js UI, roadbook files, password gate, PWA
packages/agent/src/roadbook      draft, patch validation, undo, three rearrange rules
packages/agent                   legacy plan → tools → synthesize loop, still used by evals
packages/llm                     OpenAI-compatible chat client
packages/tools                   web search, Open-Meteo, place names (西湖 → 杭州)
evals                            fixtures plus the roadbook protocol checks
```

## Roadbook

1. One sentence becomes a draft immediately. Missing facts are assumption tags. At most one question, and only when the city cannot be read.
2. Later edits are patches: `add` / `update` / `remove` / `reorder`. The server rejects edits to locked items and rejects unparseable times. Overlaps of unlocked items are pushed later.
3. About the last 20 patches can be undone. The stack lives on the document, oldest first. A file that still has one `undo` snapshot loads as a single step and is written back as a stack on the next save.
4. 「晚了 1 小时」 is a pure function in `planLate`. The browser runs it offline, then syncs the same patch. 「下雨了」 and 「累了」 call the server, which refreshes Open-Meteo first.
5. Documents are JSON files in `data/roadbooks/`. Each file has an access key. `ACCESS_PASSWORD` is an optional single-user gate. The model key arrives on `X-Lushu-LLM-Key` and is not written to the file.
6. On a wide window the roadbook page is a conversation column plus the document. The phone layout stays a single full-screen column. The latest patch highlights changed items and assumption tags, and records removed titles on the patch.

## Legacy loop

1. **Clarify.** If the brief leaves the clock direction, trip length, party size, or a hard stop such as 体检 open, the session stops at `needs_clarify` and asks at most three questions. Defaults are shown. An unclear train time defaults to departure, not arrival. Confirming writes those choices back onto the same session and only then plans.
2. **Planning.** A local parser reads destination, days, party, and budget. If `LLM_API_KEY` is set, the model may refine queries. The parser stays in charge of facts the brief already states.
3. **Searching.** Up to a few web searches, then weather for the first cities. Missing keys or network errors become labeled stubs. The forecast is copied onto each day. Nothing is booked.
4. **Synthesizing.** The model writes two JSON itineraries. If the JSON is unusable, or no key is set, a local planner writes the same shape from a small city notebook.
5. **Awaiting confirm.** The person picks one plan. That choice is the shareable page. A follow-up on that page appends a comparison or rewrites the selected days in the same file.

`awaiting_confirm` is shown on the timeline but does not consume a step. Model calls and tool calls do.

## Limits

`AGENT_MAX_STEPS`, `AGENT_MAX_TOOL_CALLS`, and `AGENT_MAX_COST_USD` are hard stops for one session. Cost is estimated from token usage and `LLM_PRICE_*` rates. It is a ceiling, not a bill. One in-flight request can finish slightly over the ceiling; the loop then stops.

## Sessions

JSON files in `data/sessions/` (gitignored). The id is the share link. 我的路书 lists those files. Email login is optional: a 6-digit code, then an httpOnly cookie. There is no phone login and no database. See the root README for `AUTH_SECRET` and `SMTP_*`.

## Swapping the model

Any OpenAI-compatible `POST /chat/completions` endpoint works. Change `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY`. The client retries once without `response_format` and `reasoning_effort` if the provider rejects them. When `LLM_REASONING_EFFORT` is unset, DeepSeek (the model or base URL contains `deepseek`) omits `reasoning_effort`; `low` can make DeepSeek return empty patches. Other providers still default to `low`. An explicit nonempty value is sent as written.
