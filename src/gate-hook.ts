#!/usr/bin/env node
// PreToolUse hook entry for the standalone safety gate. Claude Code pipes the tool
// event as JSON on stdin; we emit a permissionDecision on stdout. Fail-closed: any
// internal error denies the call (a broken gate stops the agent, never leaks).
//
// Wired as a Claude Code plugin hook (hooks/hooks.json): PreToolUse matcher "*" ->
// this command. It can also be wired directly from .claude/settings.json.
//
// The project root is CLAUDE_PROJECT_DIR (set by Claude Code for every hook), so the
// policy, the allowlist and the approvals stay the same files after the session
// changes directory; without it, the event's cwd.
//
// Configuration (all optional, resolved relative to the project root):
//   GATE_MANIFEST          path to the capability manifest TOML
//                          (default: .claude/policy/capabilities.toml)
//   GATE_BASH_ALLOWLIST    path to the bash allowlist JSONL
//                          (default: rules/bash-allowlist.jsonl)
//   GATE_APPROVALS         path to the durable one-shot approval store JSONL
//                          (default: .gate/approvals.jsonl)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadManifest, decide, type Decision } from './gate.js';
import { JsonlApprovalStore, approvalsPath } from './approval-store.js';

type Permission = Decision['permission'];

function emit(permission: Permission, reason: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: permission,
      permissionDecisionReason: reason,
    },
  }));
}

async function main(): Promise<void> {
  // Empty/garbage stdin (e.g. a non-gating event) -> allow.
  let evt: any = null;
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw.trim()) evt = JSON.parse(raw);
  } catch {
    emit('allow', 'gate: no/invalid stdin event');
    return;
  }
  if (!evt || evt.hook_event_name !== 'PreToolUse') {
    emit('allow', 'gate: not a PreToolUse event');
    return;
  }

  try {
    const root = resolve(process.env.CLAUDE_PROJECT_DIR || evt.cwd || process.cwd());
    const manifestPath = process.env.GATE_MANIFEST
      ? resolve(root, process.env.GATE_MANIFEST)
      : resolve(root, '.claude', 'policy', 'capabilities.toml');
    const bashAllowlistPath = process.env.GATE_BASH_ALLOWLIST
      ? resolve(root, process.env.GATE_BASH_ALLOWLIST)
      : undefined; // undefined -> gate uses its default (<root>/rules/bash-allowlist.jsonl)

    const m = loadManifest(manifestPath);
    const store = new JsonlApprovalStore(approvalsPath(root));

    const d = await decide(m, {
      toolName: evt.tool_name,
      toolInput: evt.tool_input ?? {},
      toolUseId: evt.tool_use_id,
      sessionId: evt.session_id,
      cwd: root,
      bashAllowlistPath,
    }, { store });

    emit(d.permission, d.reason);
  } catch (e: any) {
    emit('deny', `gate error (fail-closed): ${e?.message ?? String(e)}`);
  }
}

main();
