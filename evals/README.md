# Evals

Ten Chinese trip briefs and a structure check. The default runner does not call a model or the network.

```bash
pnpm eval
pnpm eval:live   # needs LLM_API_KEY; still checks the same structure
```

Each planning case must come back with two plans, enough days, a budget note, sources, an AI-generated flag, weather on each day (a stub says the forecast is unavailable), and the planning / searching / awaiting-confirm timeline. Cost and step counters must stay inside the env limits. A case with `"expect": "clarify"` must stop at questions and must not default an unclear clock to arrival. Confirmed briefs still have to plan.

Fixtures live in `fixtures/`. Add a JSON file; the runner picks up every `*.json` in that folder.
