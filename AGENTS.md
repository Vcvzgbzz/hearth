# Working on hearth with an AI agent

This repo is public. Everything you commit, every PR description and every
comment is read by strangers. Write for them.

## Before you commit

- `npm run typecheck && npm test` both pass. CI runs the same on Node 20, 22 and 24.
- A behaviour change comes with a test in `test/*.test.ts` that fails without it.
  New files are picked up by the glob; there is no list to edit.
- Config fixtures in v1 shape go through `parseV1` from `test/v1.ts`.
- A new config key is declared in `src/fields.ts`, the one table the parser and
  the console editor both read, or the parser rejects it. If it applies without
  a restart, add it to `LIVE_KEYS` in `src/configfile.ts`.
- User-visible behaviour or config changes update `README.md` in the same PR.

## Commit messages

- Subject: `area: what changed`, present tense, about 72 characters or fewer.
  Areas in use: `Console`, `Console config`, `passthrough`, `models`, `config`,
  `peers`, `scheduler`. Example:
  `passthrough: forward multipart uploads as multipart`
- Body: what was wrong or missing and what changes, for someone who was not
  there. Bullets are fine. Name the test that covers it.
- An AI co-author trailer is welcome: `Co-Authored-By: <model> <noreply@...>`.
- **Never** put a session link, session ID, chat URL or `Claude-Session:` trailer
  in a commit, PR or comment, even if your tooling suggests one. Commit
  messages cannot be edited after a push.

## Pull requests

- Branch from `main`, one concern per PR, never push to `main` directly.
- Description: what it does, why, how, and how it was tested. Include a generic
  config example when it adds a setting.
- Pass long bodies with `gh pr create --body-file` / `gh pr edit --body-file`;
  apostrophes inside a `$(...)` heredoc break the shell.

## Comments

- Say what the code guarantees and why, in the present tense. Usually one line;
  three at most for an inline comment. A file's header may be a short paragraph.
- No history: not "this used to", "fixed after", "found on <date>", or the story
  of a debugging session. That belongs in the commit message, if anywhere.
- Do not explain what the next line plainly does.

## Keep it generic

Nothing from anyone's own setup goes in `src/`, `test/` or `README.md`:

- no hostnames, IPs, ports of a real box, people's names or handles
- no hardware model names (use `gpu0`, `gpu1`, `cpu`)
- no personal model or route names (use `my-model`, `chat`, `voice`)
- no numbers "measured on our box"; state the default and what it trades off

## Security

- No secrets in the repo or in examples. Config takes `env:NAME` for anything
  secret.
- Do not weaken a default: loopback-only binding, the operator login, the
  cross-origin write refusal, api-key scoping.
- hearth trusts callers by socket address. Never document or add a proxy in
  front of it; anything that rewrites the source address turns strangers into
  local callers.
