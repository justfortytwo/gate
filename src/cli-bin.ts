#!/usr/bin/env node
// Bin shim for the `vogon` CLI. Resolves the durable approval store from the same
// env/defaults the PreToolUse hook uses, then dispatches to runCli. Kept tiny so
// the testable logic lives in cli.ts.
import { resolve } from 'node:path';
import { JsonlApprovalStore } from './approval-store.js';
import { runCli } from './cli.js';

const root = process.cwd();
const approvalsPath = process.env.GATE_APPROVALS
  ? resolve(root, process.env.GATE_APPROVALS)
  : resolve(root, '.gate', 'approvals.jsonl');

runCli(process.argv.slice(2), { store: new JsonlApprovalStore(approvalsPath) }).then(
  (code) => process.exit(code),
);
