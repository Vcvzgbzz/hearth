## What

<!-- What this changes, in a sentence or two. -->

## Why

<!-- The problem, or the issue this closes. -->

## How

<!-- Where to start reading, and anything a reviewer would not guess. -->

## Tests

<!-- The exact commands you ran, and what a new test proves. -->

```
npm run typecheck
npm test
```

## Checklist

- [ ] `npm run typecheck && npm test` pass
- [ ] A behaviour change comes with a test that fails without it
- [ ] Docs this makes wrong are updated (README, `docs/`, the setting's `desc` in `src/fields.ts`)
- [ ] No new dependency, or an issue agreed to it
- [ ] Breaking (a config key, a route or the `/v1` wire format)? It says so in the title
- [ ] Written with an AI agent? Said so here
