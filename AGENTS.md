# AI PM Desktop

The v2 local client for the AI PM platform: Electron + TypeScript, Mac and Windows.
The design doc is the source of truth for behaviour. Read it before changing the state machine.

- **One state machine.** Tasks have a stage and a status (queued, running, needs_you, waiting, done, closed).
  - Do not add an "unknown outcome" status.
  - Every needs_you reason must have a command that resolves it.
- **Platform writes go through the outbox.** The request_id is fixed at enqueue time.
  - Uncertain results are resent unchanged.
  - Business rejections become needs_you:platform_rejected.
- **Agents never connect to the AI PM platform.**
  - The client writes context into the worktree's `.ai-pm/`.
  - Do not give agent sessions platform MCP tools or credentials.
- **Isolate every per-task error.** One task's failure must never stop other tasks or intake.
- **Runtime data stays out of this repository.** That includes the database, run logs, worktrees, tokens and settings.
- **Testing:**
  - Use the fake platform and fake Codex in `test/`.
  - Never create test tasks in the production task pool.
  - Run `npm test` and `npm run typecheck` before committing; the full suite should stay under 5 minutes.
- No git push, merge, deployment or production write without separate explicit authorization.
