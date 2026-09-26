# Standalone IANA read-only canary — 2026-09-26

Source: extracted tracked package from `amar3012005/HIVEMIND` commit `d88be1d146ad0e1436f906d0d7426205cd7d4eb3`, plus standalone packaging/documentation changes in this repository. New repository commit SHA is recorded in Git history after publication.

Run command: `npm run pool-client-canary` against isolated local pool on loopback port 8792, with E2B credentials supplied from ignored local environment. No AgentScope or HIVE-MIND control plane ran.

- `computer_run_id`: `492af112-ab9e-4eed-9ea8-75f219006830`
- Status events: `starting` → `agent` → `completed` (event IDs 1, 2, 3).
- Browser-visible result: `h1` = `IANA-managed Reserved Domains` at `https://www.iana.org/domains/reserved`.
- Independent HTTPS fetch: status 200, expected heading matched.
- `decision_calls`: 0; deterministic DOM path, no Jev call.
- Exit code: 0. Dedicated pool process stopped after run.

No API key, control token, desktop URL, or screenshot stored in this record.
