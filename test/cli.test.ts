import { describe, it, expect } from 'vitest';
import { InMemoryApprovalStore, type ApprovalStore } from '../src/index.js';
import { runCli } from '../src/cli.js';

async function staged(): Promise<ApprovalStore> {
  const store = new InMemoryApprovalStore();
  await store.addPending({ tool: 'mcp__messaging__send', target: 'to=x', payload: {}, tier: 'external', tool_use_id: 'tu_1' });
  return store;
}

function sink() {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), text: () => lines.join('\n') };
}

describe('runCli', () => {
  it('approve flips a pending approval to approved and exits 0', async () => {
    const store = await staged();
    const out = sink();
    const code = await runCli(['approve', 'tu_1'], { store, out: out.write });
    expect(code).toBe(0);
    expect((await store.getByToolUseId('tu_1'))!.status).toBe('approved');
  });

  it('deny flips a pending approval to denied and exits 0', async () => {
    const store = await staged();
    const code = await runCli(['deny', 'tu_1'], { store, out: sink().write });
    expect(code).toBe(0);
    expect((await store.getByToolUseId('tu_1'))!.status).toBe('denied');
  });

  it('approve of an unknown tool_use_id exits non-zero and changes nothing', async () => {
    const store = await staged();
    const err = sink();
    const code = await runCli(['approve', 'tu_nope'], { store, out: sink().write, err: err.write });
    expect(code).toBe(1);
    expect(err.text()).toMatch(/tu_nope/);
    expect((await store.getByToolUseId('tu_1'))!.status).toBe('pending');
  });

  it('list prints each staged approval and exits 0', async () => {
    const store = await staged();
    const out = sink();
    const code = await runCli(['list'], { store, out: out.write });
    expect(code).toBe(0);
    expect(out.text()).toMatch(/tu_1/);
    expect(out.text()).toMatch(/mcp__messaging__send/);
  });

  it('no command prints usage and exits 2', async () => {
    const err = sink();
    const code = await runCli([], { store: await staged(), out: sink().write, err: err.write });
    expect(code).toBe(2);
    expect(err.text()).toMatch(/usage/i);
  });
});
