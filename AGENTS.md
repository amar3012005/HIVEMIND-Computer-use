# Agent instructions

This repository is the standalone E2B computer-use service. It is independent of AgentScope and the HIVE-MIND application runtime.

- Read `README.md`, `docs/SETUP.md`, and `docs/API.md` before changing runtime behavior.
- Keep changes local to this repository. Do not deploy or alter Singulance servers from here.
- Never commit API keys, control tokens, desktop URLs, screenshots containing account data, or runtime `pool-state/` and `receipts/`.
- Browser read/navigation can run automatically. Login, MFA, CAPTCHA, credential entry, sending, publishing, deleting, and payments require human authority. Do not weaken `src/operator/authority-policy.mjs` to make a canary pass.
- Use the existing `ComputerPoolClient` and bounded `browser_plan` contract. Do not claim arbitrary natural-language planning exists.
- Run `npm test` after changes. For E2B lifecycle changes, run an isolated read-only canary and record run ID, source SHA, and verification result without secrets.
- Default local bind is `127.0.0.1:8789`. Do not expose the shared-token API publicly; it lacks production-grade service authentication and multi-node storage.
