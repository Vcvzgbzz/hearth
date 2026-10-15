# Contributing to hearth

Bug reports, fixes and new backends are welcome. This page is the short version;
[`AGENTS.md`](AGENTS.md) holds the full rules, and they apply to people as much
as to AI agents.

## Getting set up

```bash
git clone https://github.com/Vcvzgbzz/hearth.git
cd hearth
npm install
npm run demo        # a node with one of everything at http://127.0.0.1:4300/ui, no GPU needed
```

```bash
npm run typecheck
npm test            # every test/*.test.ts, one after another
npx tsx test/<name>.test.ts   # one area; run `npm run build:console` first for anything that serves the page
```

[`docs/development.md`](docs/development.md) covers embedding hearth as a
library and what the larger tests prove.

## Issues

- **A bug:** use the bug report form. The hearth version (`hearth --version`),
  the backend kind and the relevant part of `hearth.yaml` with secrets taken
  out make most reports answerable on the first read.
- **An idea:** say what you are trying to do before how. A change to a
  config key, a route or the `/v1` wire format is breaking, so it needs an
  issue agreed before a PR.
- **A vulnerability:** not in an issue. See [`SECURITY.md`](SECURITY.md).

## Pull requests

- Branch from `main`, one concern per PR.
- `npm run typecheck && npm test` pass. CI runs both on Node 20, 22 and 24.
- A behaviour change comes with a test that fails without it.
- Every doc your change makes wrong is updated in the same PR: the README,
  the page under `docs/`, and a setting's `desc` in `src/fields.ts`.
- No new dependency without an issue agreeing to it first.
- Written with an AI agent? Say so in the description. Whoever opens the PR
  answers for it.

The PR template carries the same checklist.

## Releases

Releases, the `version` in `package.json` and `.github/workflows/` are the
maintainer's.
