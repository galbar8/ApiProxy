# Phase 0 — Foundations

## Scope

- pnpm workspace, Node 22, TypeScript strict, ESLint flat config, Prettier.
- Four Vitest suites (unit, integration, e2e, chaos) and a load entry point.
- Every command listed in `CLAUDE.md` exists in `package.json` and runs.
- Documentation baseline: invariants, architecture, state machine, decisions, ADRs, phases.
- Skills relocated to `.claude/skills/` under their frontmatter names.
- Path-specific rules under `.claude/rules/`.
- Local topology definition (`docker-compose.local.yml`) and `.env.example`.

## Out of scope

Any application code, infrastructure or business logic.

## Acceptance criteria

- `pnpm install` exits 0.
- `pnpm lint`, `pnpm typecheck` and `pnpm test` all exit 0.
- `docs/PROGRESS.md` reflects the real state of the repository.
