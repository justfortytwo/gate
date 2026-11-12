#!/usr/bin/env node
// Bin shim for the `gate` CLI. Resolves the durable approval store from the same
// env/defaults the PreToolUse hook uses, then dispatches to runCli. Kept tiny so
// the testable logic lives in cli.ts.
import { JsonlApprovalStore, approvalsPath } from './approval-store.js';
import { runCli } from './cli.js';

const storePath = approvalsPath(process.cwd());

runCli(process.argv.slice(2), {
  store: new JsonlApprovalStore(storePath),
  storeLabel: storePath,
})
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    process.stderr.write(`gate error (fail-closed): ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
