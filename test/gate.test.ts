import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseManifest,
  classify,
  decide,
  InMemoryApprovalStore,
  type Manifest,
  type ApprovalStore,
} from '../src/index.js';

const MANIFEST_SRC = `
default_tier = "external"
[tiers]
"Read" = "read"
"Write" = "internal"
"Bash" = "external"
"mcp__messaging__*" = "external"
[bash]
"\\brm\\s+-rf?\\b" = "irreversible"
"\\bgit\\s+push\\b" = "external"
[guard]
files = [".claude/policy/capabilities.toml"]
`;

let m: Manifest;
let store: ApprovalStore;
beforeEach(() => {
  m = parseManifest(MANIFEST_SRC);
  store = new InMemoryApprovalStore();
});

describe('classify', () => {
  it('auto tiers pass, prefix globs and bash elevation work', () => {
    expect(classify(m, 'Read', {})).toBe('read');
    expect(classify(m, 'Write', { file_path: 'note.md' })).toBe('internal');
    expect(classify(m, 'mcp__messaging__send', {})).toBe('external');
    expect(classify(m, 'Bash', { command: 'rm -rf /tmp/x' })).toBe('irreversible');
    // Bash fails closed: an unmatched command stays at the external base.
    expect(classify(m, 'Bash', { command: 'ls -la' })).toBe('external');
  });
});

describe('decide — one-shot approval state machine', () => {
  const ext = { toolName: 'mcp__messaging__send', toolInput: { to: 'someone' }, toolUseId: 'tu_1' };

  it('auto-tier tools allow without any pending record', async () => {
    const d = await decide(m, { toolName: 'Read', toolInput: {}, toolUseId: 'tu_r' }, { store });
    expect(d.permission).toBe('allow');
  });

  it('an external call defers and stages an approval, then allows once after approval', async () => {
    const first = await decide(m, ext, { store });
    expect(first.permission).toBe('defer');

    await store.setDecisionByToolUseId('tu_1', 'approved', 'tester');

    const allow = await decide(m, ext, { store });
    expect(allow.permission).toBe('allow');

    const again = await decide(m, ext, { store });
    expect(again.permission).toBe('deny');
  });

  it('fails closed when an external call has no tool_use_id', async () => {
    const d = await decide(m, { toolName: 'mcp__messaging__send', toolInput: {} }, { store });
    expect(d.permission).toBe('deny');
  });

  it('deny-wins: a broad allowlist glob cannot permit git push', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    const allowFile = join(dir, 'bash-allowlist.jsonl');
    writeFileSync(allowFile, `${JSON.stringify({ command_glob: 'git *', expires_at: '2999-01-01T00:00:00.000Z' })}\n`);

    const push = await decide(m, {
      toolName: 'Bash', toolInput: { command: 'git push origin main' },
      toolUseId: 'tu_push', cwd: dir, bashAllowlistPath: allowFile,
    }, { store });
    expect(push.permission).toBe('defer');

    const status = await decide(m, {
      toolName: 'Bash', toolInput: { command: 'git status' },
      toolUseId: 'tu_status', cwd: dir, bashAllowlistPath: allowFile,
    }, { store });
    expect(status.permission).toBe('allow');
  });
});

describe('classify — edge cases', () => {
  it('editing a guarded file is irreversible; an ordinary edit is not', () => {
    expect(classify(m, 'Write', { file_path: '.claude/policy/capabilities.toml' })).toBe('irreversible');
    expect(classify(m, 'Write', { file_path: 'src/app.ts' })).toBe('internal');
  });
  it('an entry ending in / guards everything below that directory', () => {
    const g = parseManifest(`
[tiers]
"Write" = "internal"
"Edit" = "internal"
"NotebookEdit" = "internal"
[guard]
files = ["node_modules/", "./.gate/", ".env", "/"]
`);
    const root = '/proj';
    expect(classify(g, 'Write', { file_path: 'node_modules/@justfortytwo/gate/dist/gate-hook.js' }, root)).toBe('irreversible');
    expect(classify(g, 'Edit', { file_path: '/proj/node_modules/x/index.js' }, root)).toBe('irreversible');
    expect(classify(g, 'Write', { file_path: 'notes/../.gate/approvals.jsonl' }, root)).toBe('irreversible');
    expect(classify(g, 'Write', { file_path: '.env' }, root)).toBe('irreversible');
    expect(classify(g, 'NotebookEdit', { notebook_path: 'node_modules/a.ipynb' }, root)).toBe('irreversible');
    // Not below a guarded directory: a look-alike name, and (without outside_project) other roots.
    expect(classify(g, 'Write', { file_path: 'node_modules_notes/a.md' }, root)).toBe('internal');
    expect(classify(g, 'Write', { file_path: 'notes/a.md' }, root)).toBe('internal');
    expect(classify(g, 'Write', { file_path: '/elsewhere/a.md' }, root)).toBe('internal');
  });
  it('outside_project = true holds edits outside the project root', () => {
    const g = parseManifest(`
[tiers]
"Write" = "internal"
"Read" = "read"
[guard]
files = []
outside_project = true
`);
    const root = '/proj';
    expect(classify(g, 'Write', { file_path: '/home/me/.claude/settings.json' }, root)).toBe('irreversible');
    expect(classify(g, 'Write', { file_path: '../other/a.md' }, root)).toBe('irreversible');
    expect(classify(g, 'Write', { file_path: '/proj-sibling/a.md' }, root)).toBe('irreversible');
    expect(classify(g, 'Write', { file_path: '/proj/notes/a.md' }, root)).toBe('internal');
    expect(classify(g, 'Write', { file_path: 'notes/a.md' }, root)).toBe('internal');
    expect(classify(g, 'Read', { file_path: '/etc/hosts' }, root)).toBe('read'); // reading is not editing
  });
  describe('guard hardening', () => {
    const g = parseManifest(`
[tiers]
"Write" = "internal"
"NotebookEdit" = "internal"
[guard]
files = [".env", ".gate/"]
outside_project = true
`);
    it('ignores letter case', () => {
      expect(classify(g, 'Write', { file_path: '.ENV' }, '/proj')).toBe('irreversible');
      expect(classify(g, 'Write', { file_path: '.Gate/approvals.jsonl' }, '/proj')).toBe('irreversible');
    });
    it('checks every path field, not only the first', () => {
      expect(classify(g, 'NotebookEdit', { file_path: 'notes/a.md', notebook_path: '.env' }, '/proj')).toBe('irreversible');
      expect(classify(g, 'Write', { file_path: 'notes/a.md', notebook_path: '/elsewhere/x' }, '/proj')).toBe('irreversible');
    });
    it('resolves a relative path from the directory the tool runs in', () => {
      expect(classify(g, 'Write', { file_path: '../.env' }, '/proj', '/proj/sub')).toBe('irreversible');
      expect(classify(g, 'Write', { file_path: '.env' }, '/proj', '/proj/sub')).toBe('internal'); // sub/.env
      expect(classify(g, 'Write', { file_path: '../../x' }, '/proj', '/proj/sub')).toBe('irreversible'); // outside
    });
    it('follows symbolic links to a guarded path or out of the project', () => {
      const base = mkdtempSync(join(tmpdir(), 'gate-guard-'));
      try {
        const root = join(base, 'proj');
        mkdirSync(join(root, '.gate'), { recursive: true });
        mkdirSync(join(base, 'outside'));
        symlinkSync(join(root, '.gate'), join(root, 'innocent'));
        symlinkSync(join(base, 'outside'), join(root, 'exit'));
        expect(classify(g, 'Write', { file_path: 'innocent/approvals.jsonl' }, root)).toBe('irreversible');
        expect(classify(g, 'Write', { file_path: join(root, 'exit', 'new', 'a.md') }, root)).toBe('irreversible');
        expect(classify(g, 'Write', { file_path: 'notes/new/a.md' }, root)).toBe('internal');
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });
  it('unknown tools fall back to the default tier', () => {
    expect(classify(m, 'SomeUnknownTool', {})).toBe('external'); // default_tier
  });
});

describe('decide — additional paths', () => {
  const ext = { toolName: 'mcp__messaging__send', toolInput: { to: 'x' }, toolUseId: 'tu_d' };

  it('a manifest without default_tier defers an unlisted tool', async () => {
    const g = parseManifest(`
[tiers]
"Read" = "read"
`);
    expect(g.defaultTier).toBe('external');
    const d = await decide(g, { toolName: 'mcp__unlisted__run', toolInput: {}, toolUseId: 'tu_nd' }, { store });
    expect(d.permission).toBe('defer');
  });

  it('an invalid default_tier defers an unlisted tool', async () => {
    const g = parseManifest(`
default_tier = "trusted"
[tiers]
"Read" = "read"
`);
    expect(g.defaultTier).toBe('external');
    const d = await decide(g, { toolName: 'mcp__unlisted__run', toolInput: {}, toolUseId: 'tu_inv' }, { store });
    expect(d.permission).toBe('defer');
  });

  it('a denied record denies on re-fire', async () => {
    expect((await decide(m, ext, { store })).permission).toBe('defer');
    await store.setDecisionByToolUseId('tu_d', 'denied');
    expect((await decide(m, ext, { store })).permission).toBe('deny');
  });

  it('a benign bash command matching the allowlist is allowed without approval', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    const allow = join(dir, 'bash-allowlist.jsonl');
    writeFileSync(allow, `${JSON.stringify({ command_glob: 'ls -la', expires_at: '2999-01-01T00:00:00.000Z' })}\n`);
    const d = await decide(m, {
      toolName: 'Bash', toolInput: { command: 'ls -la' },
      toolUseId: 'tu_ls', cwd: dir, bashAllowlistPath: allow,
    }, { store });
    expect(d.permission).toBe('allow');
  });
});
