// vogon CLI: clear deferred approvals from the durable store, standalone — so the
// gate can complete its own approve->allow loop without a host. Pure and testable:
// the store + output sinks are injected; the bin shim (cli-bin.ts) wires them.
//
//   list                    list staged approvals
//   approve <tool_use_id>   approve a deferred call (consumed once on re-fire)
//   deny <tool_use_id>      deny a deferred call

import type { ApprovalStore, PendingApproval } from './approval-store.js';

export interface CliOptions {
  store: ApprovalStore;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const USAGE = `usage: vogon <command>
  list                    list staged approvals
  approve <tool_use_id>   approve a deferred call (one-shot)
  deny <tool_use_id>      deny a deferred call`;

function fmt(r: PendingApproval): string {
  return `${r.status.padEnd(8)} ${r.tier.padEnd(12)} ${r.tool_use_id}  ${r.tool} -> ${r.target}`;
}

export async function runCli(argv: string[], opts: CliOptions): Promise<number> {
  const out = opts.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = opts.err ?? ((s) => process.stderr.write(`${s}\n`));
  const [cmd, id] = argv;

  if (!cmd) {
    err(USAGE);
    return 2;
  }

  if (cmd === 'list') {
    const rows = await opts.store.list();
    if (rows.length === 0) out('(no staged approvals)');
    for (const r of rows) out(fmt(r));
    return 0;
  }

  if (cmd === 'approve' || cmd === 'deny') {
    if (!id) {
      err(`${cmd}: missing <tool_use_id>`);
      return 2;
    }
    const status = cmd === 'approve' ? 'approved' : 'denied';
    const ok = await opts.store.setDecisionByToolUseId(id, status, 'cli');
    if (!ok) {
      err(`${cmd}: no staged approval for ${id}`);
      return 1;
    }
    out(`${id} ${status}`);
    return 0;
  }

  err(`unknown command: ${cmd}\n${USAGE}`);
  return 2;
}
