# Repository Guidelines

## Project Structure & Module Organization

`@justfortytwo/gate` is a standalone, agent-agnostic PreToolUse safety gate. TypeScript sources live in `src/`: `gate.ts` handles capability decisions, `policy.ts` handles content trust, and `approval-store.ts` manages one-shot approvals. `bash-allowlist.ts` validates command permissions; `gate-hook.ts`, `cli.ts`, and `cli-bin.ts` provide executable entry points. Public exports belong in `src/index.ts`.

Tests live in `test/`. Example TOML policies and JSONL allowlists live in `examples/`; plugin wiring lives in `hooks/` and `.claude-plugin/`. Generated JavaScript, declarations, and source maps go into ignored `dist/`.

## Build, Test, and Development Commands

Use Node.js 18 or newer and npm.

- `npm ci`: install dependencies from the lockfile.
- `npm run build`: compile strict TypeScript to `dist/`.
- `npm test`: run the Vitest suite once; hook integration tests also compile current sources.
- `npm run test:watch`: rerun tests during development.
- `npx vitest run test/policy.test.ts`: run a focused test file.
- `node dist/cli-bin.js list`: inspect approvals after building; paths resolve from the current working directory.

## Coding Style & Naming Conventions

Follow existing two-space indentation, single quotes, semicolons, and trailing commas. Use camelCase for functions and variables, PascalCase for types and classes, and kebab-case module filenames. Preserve existing snake_case fields in serialized contracts. This is an ESM package using NodeNext resolution: relative TypeScript imports use `.js` suffixes. No dedicated formatter or lint script is configured.

## Testing Guidelines

Use Vitest with `test/<module>.test.ts`, descriptive `describe` groups, and behavior-focused `it` cases. Add regressions for denial precedence, malformed input, approval consumption, and error paths. Use temporary directories for file-backed tests. Run `npm run build` and `npm test` before submitting. No numeric coverage threshold is configured.

## Commit & Pull Request Guidelines

History commonly uses `feat:`, `fix:`, `docs:`, and `ci:` prefixes, sometimes with scopes; follow that convention with concise, imperative subjects. In pull requests, explain the behavior change, link relevant issues, and report validation commands and results. Update examples or README documentation when public behavior changes.

## Security & Compatibility

Preserve fail-closed decisions, deny precedence, and single-use approvals. Changes to policy contract meaning require both `POLICY_SCHEMA_VERSION` and package major-version bumps. Keep credentials and local approval data out of commits.

## fortytwo project context

This repository is part of **fortytwo**, a local-first personal-assistant spine built around existing agent runtimes and tool ecosystems.

The umbrella project is **fortytwo**. It is not intended to replace Claude Code, Codex, MCP servers, plugins, skills, or other agent runtimes. The project provides the durable personal-assistant infrastructure around them: memory, lifecycle, scheduling, channels, optional policy enforcement, and related supporting components.

Claude Code is currently the primary/reference runtime, but the architecture should avoid unnecessary coupling to a specific model provider. In particular, components should remain usable when Claude Code itself is configured against alternative compatible model providers.

The main bootstrap and lifecycle entry point is the **installer** repository (`justfortytwo/installer`).

### Canonical project locations

- Website: `forty-two.it`
- GitHub organization: `github.com/justfortytwo`
- Architecture/design documentation: `justfortytwo/docs`

### Repositories

The fortytwo project is intentionally split into small, focused repositories.

- **`justfortytwo/installer`**
  Main installer and lifecycle CLI (`create-fortytwo` / `fortytwo`). This is the primary bootstrap entry point for assembling a fortytwo installation.

- **`justfortytwo/runner`**
  Thin Claude Code process/session runtime. Owns process lifecycle and stream transport, including one-shot runs and persistent interactive sessions. It must not become an agent framework.

- **`justfortytwo/memory`**
  Durable semantic-memory MCP server backed by local storage and retrieval infrastructure.

- **`justfortytwo/scheduler`**
  Durable scheduling and proactive job execution. Owns *when* work should happen, not how the agent reasons about or performs that work.

- **`justfortytwo/telegram`**
  Telegram transport/channel adapter. Owns Telegram identity, pairing, message transport, attachment handling, and mapping chats to live agent sessions. It should delegate agent process lifecycle to `runner`.

- **`justfortytwo/persona`**
  Persona and context templates rendered by the installer into an individual fortytwo installation.

- **`justfortytwo/gate`**
  Optional external safety/policy enforcement layer for tool execution and approvals. Keep this separate from the agent runtime's own reasoning and permissions.

- **`justfortytwo/salience`**
  Optional model-driven salience extraction used to enrich durable memory.

- **`justfortytwo/marketplace`**
  Claude Code plugin marketplace and umbrella plugin used as a distribution surface for fortytwo components.

- **`justfortytwo/docs`**
  Cross-repository architecture, design, contracts, and project documentation.

- **`justfortytwo/website`**
  Public website for the project, served as `forty-two.it`.

- **`justfortytwo/.github`**
  GitHub organization metadata and shared organization-level project information.

### Cross-repository architecture

When changing one repository, treat the sibling repositories as parts of the same system.

The intended high-level ownership is:

```text
channels / scheduler
        |
        v
      runner
        |
        v
   agent runtime
  (Claude Code today)
        |
        +---- MCPs / plugins / skills / tools
        |
        +---- fortytwo memory

optional surrounding components:
- gate
- salience

bootstrap / distribution / documentation:
- installer
- persona
- marketplace
- docs
- website
```

A useful rule when deciding where code belongs:

> fortytwo should add continuity and infrastructure around an existing agent, not reimplement capabilities already owned by the agent runtime or its MCP/plugin ecosystem.

Examples:

- agent reasoning, planning, subagents, tools, MCP orchestration, and plugins belong to the agent runtime;
- Claude process/session lifecycle belongs to `runner`;
- durable memory belongs to `memory`;
- durable time and scheduled execution belong to `scheduler`;
- Telegram transport and Telegram identity belong to `telegram`;
- installation and lifecycle management belong to `installer`;
- browser automation should normally come from an existing MCP/plugin rather than a fortytwo-specific browser implementation.

Before introducing a new abstraction, check the relevant sibling repositories and the agent runtime's existing capabilities to avoid duplicating functionality elsewhere in the fortytwo stack.
