import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { approvalsPath } from '../src/index.js';

describe('approvalsPath', () => {
  it('defaults to <root>/.gate/approvals.jsonl', () => {
    expect(approvalsPath('/proj', {})).toBe(resolve('/proj', '.gate', 'approvals.jsonl'));
  });

  it('resolves a relative GATE_APPROVALS against the root', () => {
    expect(approvalsPath('/proj', { GATE_APPROVALS: 'state/a.jsonl' })).toBe(resolve('/proj', 'state/a.jsonl'));
  });

  it('keeps an absolute GATE_APPROVALS as is', () => {
    expect(approvalsPath('/proj', { GATE_APPROVALS: '/var/gate/a.jsonl' })).toBe('/var/gate/a.jsonl');
  });

  it('treats an empty GATE_APPROVALS as unset', () => {
    expect(approvalsPath('/proj', { GATE_APPROVALS: '' })).toBe(resolve('/proj', '.gate', 'approvals.jsonl'));
  });
});
