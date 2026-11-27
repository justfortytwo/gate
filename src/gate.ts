// The safety gate: a pure capability classifier plus a defer/allow/deny state
// machine. Auto tiers (read/internal/draft) pass; external/irreversible calls are
// deferred on first sight, staged as a one-shot approval, and only run after an
// out-of-band approval is recorded. It is agent-agnostic: it talks to a pluggable
// ApprovalStore for the durable one-shot record and an optional AuditLogger for
// the trail, so it carries no database or host-specific code itself.
//
//   TODO(wire): the original host backed ApprovalStore/AuditLogger with its own
//   transactional store (a memory/DB package). That binding belongs to a host
//   integration package — @justfortytwo/memory exports an ApprovalStore
//   implementation (see its gate-approval-store.ts) and wires it in. The gate
//   ships only the in-memory + JSONL stores below so it stands alone.

import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { bashAllowlistPath, findBashAllowlistMatch } from './bash-allowlist.js';
import {
  type ApprovalStore,
  type AuditLogger,
  InMemoryApprovalStore,
  NullAuditLogger,
} from './approval-store.js';

export type Tier = 'read' | 'internal' | 'draft' | 'external' | 'irreversible';
const AUTO: ReadonlySet<Tier> = new Set(['read', 'internal', 'draft']);
const RANK: Record<Tier, number> = { read: 0, internal: 1, draft: 2, external: 3, irreversible: 4 };
const ACTOR = process.env.GATE_ACTOR ?? 'agent';

export interface Manifest {
  defaultTier: Tier;
  tiers: Map<string, Tier>;             // exact tool name -> tier
  prefixes: Array<{ prefix: string; tier: Tier }>; // trailing-"*" globs, e.g. mcp__messaging__*
  bash: Array<{ re: RegExp; tier: Tier }>;
  guardFiles: Set<string>;              // repo-relative paths whose edit = irreversible
  /** Repo-relative directory prefixes (each ends in "/"); editing anything below one = irreversible. */
  guardDirs?: string[];
  /** Editing any path outside the project root = irreversible. */
  guardOutside?: boolean;
}

export interface GateContext {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string;
  sessionId?: string;
  cwd?: string;                         // project root, for guard-file rel normalization
  /** Directory the tool itself resolves relative paths from (the session's cwd), when it differs from the root. */
  toolCwd?: string;
  bashAllowlistPath?: string;
}

export interface Decision {
  permission: 'allow' | 'defer' | 'deny';
  tier: Tier;
  reason: string;
}

// --- minimal TOML parser (schema: default_tier, [tiers], [bash], [guard].files) ---

function findUnquotedHash(line: string): number {
  let inS: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inS) { if (c === inS) inS = null; }
    else if (c === '"' || c === "'") inS = c;
    else if (c === '#') return i;
  }
  return -1;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseValue(v: string): unknown {
  v = v.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => stripQuotes(s.trim()));
  }
  return stripQuotes(v);
}

function startsCollection(v: string): boolean {
  return v.startsWith('[') || v.startsWith('{');
}

/** Brackets/braces balanced (ignoring quoted regions)? Drives multi-line arrays. */
function balanced(v: string): boolean {
  let depth = 0;
  let inS: string | null = null;
  for (const c of v) {
    if (inS) { if (c === inS) inS = null; }
    else if (c === '"' || c === "'") inS = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0 && inS === null;
}

export function parseToml(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let cur: Record<string, unknown> = out;
  let pendingKey: string | null = null;
  let pendingVal = '';
  for (const raw of src.split('\n')) {
    let line = raw;
    const h = findUnquotedHash(line);
    if (h >= 0) line = line.slice(0, h);
    line = line.trim();
    if (!line) continue;

    // Continue a multi-line array/table value until brackets balance.
    if (pendingKey !== null) {
      pendingVal += ' ' + line;
      if (balanced(pendingVal)) {
        cur[pendingKey] = parseValue(pendingVal.trim());
        pendingKey = null;
        pendingVal = '';
      }
      continue;
    }

    if (line.startsWith('[') && line.endsWith(']')) {
      const sec = line.slice(1, -1).trim();
      cur = (out[sec] as Record<string, unknown>) ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = stripQuotes(line.slice(0, eq).trim());
    const val = line.slice(eq + 1).trim();
    if (startsCollection(val) && !balanced(val)) {
      pendingKey = key;
      pendingVal = val;
      continue;
    }
    cur[key] = parseValue(val);
  }
  return out;
}

const VALID: Tier[] = ['read', 'internal', 'draft', 'external', 'irreversible'];
function asTier(v: unknown, fallback: Tier): Tier {
  return typeof v === 'string' && (VALID as string[]).includes(v) ? (v as Tier) : fallback;
}

export function parseManifest(src: string): Manifest {
  const o = parseToml(src);
  // Fail closed: a missing or invalid default_tier holds unlisted tools for approval.
  const defaultTier = asTier(o['default_tier'], 'external');
  const tiers = new Map<string, Tier>();
  const prefixes: Array<{ prefix: string; tier: Tier }> = [];
  const tiersSection = (o['tiers'] ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(tiersSection)) {
    // A misspelled tier value is held, even when default_tier is an auto tier.
    const tier = asTier(v, 'external');
    if (k.endsWith('*')) prefixes.push({ prefix: k.slice(0, -1), tier });
    else tiers.set(k, tier);
  }
  const bashSection = (o['bash'] ?? {}) as Record<string, unknown>;
  const bash = Object.entries(bashSection).map(([k, v]) => ({ re: new RegExp(k), tier: asTier(v, 'external') }));
  const guardSection = (o['guard'] ?? {}) as Record<string, unknown>;
  const entries = (Array.isArray(guardSection['files']) ? (guardSection['files'] as string[]) : [])
    .map((f) => f.replace(/^\.\//, '')).filter((f) => f.length > 0);
  // An entry ending in "/" guards the whole directory; "/" alone would guard nothing useful.
  const guardDirs = entries.filter((f) => f.endsWith('/') && f.length > 1);
  const guardFiles = new Set(entries.filter((f) => !f.endsWith('/')));
  const guardOutside = guardSection['outside_project'] === 'true' || guardSection['outside_project'] === true;
  return { defaultTier, tiers, prefixes, bash, guardFiles, guardDirs, guardOutside };
}

export function loadManifest(path: string): Manifest {
  return parseManifest(readFileSync(path, 'utf8'));
}

// --- classification ---

const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/** Every path an edit tool names (NotebookEdit uses `notebook_path`); all of them are checked. */
function editTargets(toolInput: Record<string, unknown>): string[] {
  return ['file_path', 'notebook_path', 'path']
    .map((k) => toolInput[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * `abs` with symbolic links resolved: realpath of its deepest existing ancestor
 * plus the part that does not exist yet (a file about to be created).
 */
function realish(abs: string): string {
  let dir = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(dir), ...tail);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return abs;
      tail.unshift(basename(dir));
      dir = parent;
    }
  }
}

/** `abs` relative to `root` with forward slashes, or null when it is outside. */
function inside(root: string, abs: string): string | null {
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split('\\').join('/');
}

/**
 * Is writing `target` guarded? Checked on the path as written AND with symbolic
 * links resolved, case-insensitively (a guard on ".env" must hold ".ENV" on
 * macOS/Windows; on a case-sensitive filesystem this only over-guards).
 */
function guarded(m: Manifest, target: string, root: string, toolCwd: string): boolean {
  const abs = isAbsolute(target) ? resolve(target) : resolve(toolCwd, target);
  for (const rel of [inside(root, abs), inside(realish(root), realish(abs))]) {
    if (rel === null) {
      if (m.guardOutside) return true;
      continue;
    }
    const lower = rel.toLowerCase();
    for (const f of m.guardFiles) if (f.toLowerCase() === lower) return true;
    if (m.guardDirs?.some((dir) => lower.startsWith(dir.toLowerCase()))) return true;
  }
  return false;
}

export function classify(
  m: Manifest,
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd?: string,
  toolCwd?: string,
): Tier {
  // 1. Protect the guard: editing a guarded path is irreversible. A relative
  //    path is resolved the way the tool resolves it (toolCwd), then placed
  //    against the project root.
  if (EDIT_TOOLS.has(toolName)) {
    const root = resolve(cwd ?? '.');
    const base = toolCwd ? resolve(toolCwd) : root;
    if (editTargets(toolInput).some((t) => guarded(m, t, root, base))) return 'irreversible';
  }
  // 2. Bash: the base tier is the FLOOR; [bash] patterns only ever elevate.
  //    Bash fails closed — an unmatched command stays at the base tier (external,
  //    deferred) rather than auto-running, and a benign segment can never
  //    de-escalate a chained command (`git commit && node -e "..."`). Known-safe
  //    commands are permitted via the allowlist in decide(), not by lowering here.
  if (toolName === 'Bash' && typeof toolInput['command'] === 'string') {
    let bashTier: Tier = m.tiers.get('Bash') ?? m.defaultTier;
    for (const { re, tier } of m.bash) {
      if (re.test(toolInput['command']) && RANK[tier] > RANK[bashTier]) bashTier = tier;
    }
    return bashTier;
  }
  // 3. Exact tool tier.
  const exact = m.tiers.get(toolName);
  if (exact) return exact;
  // 4. Prefix glob (e.g. mcp__messaging__*).
  for (const { prefix, tier } of m.prefixes) if (toolName.startsWith(prefix)) return tier;
  // 5. Default.
  return m.defaultTier;
}

function describeTarget(toolInput: Record<string, unknown>): string {
  for (const k of ['target', 'to', 'chat_id', 'email', 'url']) {
    const v = toolInput[k];
    if (typeof v === 'string' && v.length) return `${k}=${v.slice(0, 80)}`;
  }
  if (typeof toolInput['command'] === 'string') return `cmd=${(toolInput['command'] as string).slice(0, 80)}`;
  return JSON.stringify(toolInput).slice(0, 80);
}

export interface DecideOptions {
  /** Durable one-shot approval record store. Defaults to a process-local store. */
  store?: ApprovalStore;
  /** Optional audit trail. Defaults to a no-op logger. */
  audit?: AuditLogger;
}

/**
 * The defer/allow/deny state machine. Auto tiers pass. External/irreversible:
 * the first call defers + stages a pending approval; a re-fire after the approval
 * is recorded consumes the one-shot and allows; denied/already-executed calls are
 * denied.
 */
export async function decide(
  m: Manifest,
  ctx: GateContext,
  opts: DecideOptions = {},
): Promise<Decision> {
  const store = opts.store ?? defaultStore;
  const audit = opts.audit ?? new NullAuditLogger();

  const tier = classify(m, ctx.toolName, ctx.toolInput, ctx.cwd, ctx.toolCwd);
  const target = describeTarget(ctx.toolInput);

  if (AUTO.has(tier)) {
    return { permission: 'allow', tier, reason: `[${tier}] auto` };
  }

  // Existing deferred calls are authoritative: consume explicit approvals before
  // consulting durable allowlists, so a pending/denied one-shot cannot be bypassed.
  let existing;
  if (ctx.toolUseId) existing = await store.getByToolUseId(ctx.toolUseId);

  if (existing) {
    if (existing.status === 'pending') {
      return { permission: 'defer', tier, reason: `[${tier}] Still awaiting approval #${existing.id}.` };
    }
    if (existing.status === 'approved') {
      const consumed = await store.markExecutedByToolUseId(ctx.toolUseId!);
      if (consumed) {
        await audit.log({
          actor: ACTOR, kind: 'approval_decision',
          content: `${ctx.toolName} -> ${target} (executed one-shot)`, approval_status: 'executed',
          meta: { pending_id: existing.id, tier },
        });
        return { permission: 'allow', tier, reason: `[${tier}] One-shot approval consumed for #${existing.id}.` };
      }
      return { permission: 'deny', tier, reason: `[${tier}] Approval #${existing.id} already consumed.` };
    }
    // denied | executed | expired
    return {
      permission: 'deny', tier,
      reason: `[${tier}] ${ctx.toolName} -> ${target} is ${existing.status} (#${existing.id}). Re-request approval if still needed.`,
    };
  }

  // Deny-always-wins: a command flagged by ANY [bash] elevation pattern (external
  // exfil like `curl --data`, `git push`, OR irreversible like `rm -rf`) can never
  // be satisfied by the allowlist — a broad glob (`git *`) must not launder
  // `git push` past the gate. The allowlist only fast-paths commands sitting at
  // the neutral base tier; flagged commands always need explicit one-shot approval.
  const flaggedBash = ctx.toolName === 'Bash' && typeof ctx.toolInput['command'] === 'string'
    && m.bash.some(({ re }) => re.test(ctx.toolInput['command'] as string));
  if (ctx.toolName === 'Bash' && !flaggedBash && typeof ctx.toolInput['command'] === 'string') {
    const cwd = ctx.cwd ? resolve(ctx.cwd) : resolve('.');
    const allowPath = ctx.bashAllowlistPath ?? bashAllowlistPath(cwd);
    const match = findBashAllowlistMatch(allowPath, ctx.toolInput['command'], cwd);
    if (match) {
      await audit.log({
        actor: ACTOR, kind: 'approval_decision',
        content: `Bash allowlist matched: ${ctx.toolInput['command']}`,
        approval_status: 'approved',
        meta: { tier, command_glob: match.command_glob, cwd_glob: match.cwd_glob, expires_at: match.expires_at ?? null },
      });
      return { permission: 'allow', tier, reason: `[${tier}] Bash allowlist matched ${match.command_glob}` };
    }
  }

  // No prior record -> stage the approval and defer.
  if (!ctx.toolUseId) {
    // Cannot key a one-shot without a tool_use_id; fail closed.
    return { permission: 'deny', tier, reason: `[${tier}] ${ctx.toolName} requires approval but no tool_use_id was provided.` };
  }

  const id = await store.addPending({
    tool: ctx.toolName, target, payload: ctx.toolInput,
    tier, tool_use_id: ctx.toolUseId, session_id: ctx.sessionId ?? null,
  });
  await audit.log({
    actor: ACTOR, kind: 'approval_request',
    content: `${ctx.toolName} -> ${target}`, approval_status: 'pending',
    meta: { pending_id: id, tier },
  });
  return {
    permission: 'defer', tier,
    reason: `APPROVAL - [${tier}]\n${ctx.toolName} -> ${target}\nApprove once, allow by policy, or deny. Pending #${id}.`,
  };
}

// The default durable store for standalone use. The hook persists one-shot
// approvals to a JSONL file (see ./approval-store.ts); this in-memory default is a
// safe library fallback when no store is supplied to decide().
const defaultStore: ApprovalStore = new InMemoryApprovalStore();

export { InMemoryApprovalStore, NullAuditLogger };
export type { ApprovalStore, AuditLogger };
