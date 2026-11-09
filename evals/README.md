# Evals

Ten Chinese trip briefs and a structure check. The default runner does not call a model or the network.

```bash
pnpm eval
pnpm eval:live   # needs LLM_API_KEY; still checks the same structure
```

Each planning case must come back with two plans, enough days, a budget note, sources, an AI-generated flag, weather on each day (a stub says the forecast is unavailable), and the planning / searching / awaiting-confirm timeline. Cost and step counters must stay inside the env limits. A case with `"expect": "clarify"` must stop at questions and must not default an unclear clock to arrival. Confirmed briefs still have to plan.

Fixtures live in `fixtures/`. Add a JSON file; the runner picks up every `*.json` in that folder. Files under `fixtures/extract/` are not planning briefs. They are canned model extracts for the roadbook draft:

- `extract-jinan.json` — Shanghai to Jinan for a checkup. Destination stays Jinan, two days from 2026-11-06, outbound, return, and the checkup are locked, and the draft has no sightseeing and no trip from Shanghai to Shanghai.
- `extract-bad.json` — same city, dates outside the window, and broken JSON fall back to a question or the rule parser.
- `sentences.json` — offline stand-ins for the six live sentences.

`pnpm eval:live` also sends those six sentences through the real extractor (`extractBrief`) when `LLM_API_KEY` is set. The offline fixtures above cover the same assertions without calling a model. The rule parser, with no key, must read the Jinan sentence as Jinan or ask which city — never as a Shanghai trip.
