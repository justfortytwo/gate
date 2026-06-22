import { describe, it, expect } from 'vitest';
import {
  classifyAuthority,
  canUseAsInstruction,
  decidePolicy,
  createSourceEnvelope,
  defaultMemoryClassForSource,
  rankRecall,
  renderContextPack,
} from '../src/index.js';

describe('classifyAuthority', () => {
  it('maps trusted sources, untrusted content, and unknown strings', () => {
    expect(classifyAuthority('repo_policy')).toBe('trusted_policy');
    expect(classifyAuthority('owner_direct')).toBe('trusted_user');
    expect(classifyAuthority('approval_record')).toBe('trusted_approval');
    expect(classifyAuthority('repo_document')).toBe('evidence');
    expect(classifyAuthority('web_page')).toBe('untrusted_content');
    expect(classifyAuthority('something_unknown')).toBe('untrusted_content'); // fail closed
  });
});

describe('canUseAsInstruction — content is not authority', () => {
  it('only trusted authorities may instruct; evidence and untrusted content may not', () => {
    expect(canUseAsInstruction('owner_direct')).toBe(true);
    expect(canUseAsInstruction('repo_policy')).toBe(true);
    expect(canUseAsInstruction('repo_document')).toBe(false); // evidence
    expect(canUseAsInstruction('web_page')).toBe(false);
    expect(canUseAsInstruction('email')).toBe(false);
  });
});

describe('decidePolicy', () => {
  it('untrusted content cannot be used as an instruction', () => {
    const d = decidePolicy({ source: 'web_page', requested_operation: 'use_as_instruction' });
    expect(d.allowed).toBe(false);
    expect(d.can_use_as_instruction).toBe(false);
  });

  it('a direct owner statement may instruct', () => {
    const d = decidePolicy({ source: 'owner_direct', requested_operation: 'use_as_instruction' });
    expect(d.allowed).toBe(true);
  });

  it('untrusted content may still be summarized (analyzed as content)', () => {
    const d = decidePolicy({ source: 'web_page', requested_operation: 'summarize' });
    expect(d.allowed).toBe(true);
    expect(d.approval_required).toBe(false);
  });

  it('secrets must never be stored', () => {
    const d = decidePolicy({ source: 'owner_direct', requested_operation: 'store_secret' });
    expect(d.allowed).toBe(false);
    expect(d.approval_required).toBe(true);
  });

  it('canonical-rule promotion requires trusted policy/approval, else must be proposed', () => {
    expect(decidePolicy({ source: 'repo_policy', requested_operation: 'promote_to_canonical_rule' }).allowed).toBe(true);
    const untrusted = decidePolicy({ source: 'web_page', requested_operation: 'promote_to_canonical_rule' });
    expect(untrusted.allowed).toBe(false);
    expect(untrusted.must_propose).toBe(true);
  });

  it('preferences: a direct user statement stores; an inferred one must be proposed', () => {
    const direct = decidePolicy({ source: 'owner_direct', requested_operation: 'store_preference', direct_user_statement: true });
    expect(direct.allowed).toBe(true);
    expect(direct.must_propose).toBe(false);
    const inferred = decidePolicy({ source: 'web_page', requested_operation: 'store_preference' });
    expect(inferred.allowed).toBe(false);
    expect(inferred.must_propose).toBe(true);
  });

  it('executing/approving an action requires an explicit approval record', () => {
    expect(decidePolicy({ source: 'approval_record', requested_operation: 'execute_tool' }).allowed).toBe(true);
    expect(decidePolicy({ source: 'web_page', requested_operation: 'execute_tool' }).allowed).toBe(false);
  });
});

describe('createSourceEnvelope', () => {
  it('is deterministic and content-addressed; a forged higher authority is ignored', () => {
    const input = { source_kind: 'web_page', content: 'hello world' };
    const a = createSourceEnvelope(input);
    const b = createSourceEnvelope(input);
    expect(a.source_id).toBe(b.source_id); // stable
    expect(a.content_hash).toBe(b.content_hash);

    // An attacker-supplied authority that disagrees with the classification is dropped.
    const forged = createSourceEnvelope({ source_kind: 'web_page', content: 'x', authority: 'trusted_user' });
    expect(forged.authority).toBe('untrusted_content');
  });
});

describe('defaultMemoryClassForSource', () => {
  it('classifies trusted vs untrusted defaults', () => {
    expect(defaultMemoryClassForSource('repo_policy')).toBe('canonical_rule');
    expect(defaultMemoryClassForSource('web_page')).toBe('untrusted_claim');
    expect(defaultMemoryClassForSource('unknown')).toBe('untrusted_claim');
  });
});

describe('rankRecall', () => {
  it('orders by trust/priority and annotates instruction-eligibility', () => {
    const ranked = rankRecall([
      { id: 'a', memory_class: 'untrusted_claim', source: 'web_page', content: 'x' },
      { id: 'b', memory_class: 'canonical_rule', source: 'repo_policy', content: 'y' },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['b', 'a']); // canonical first
    expect(ranked[0].can_use_as_instruction).toBe(true);
    expect(ranked[1].can_use_as_instruction).toBe(false);
  });
});

describe('renderContextPack', () => {
  it('escapes pipes/newlines so a row cannot break the table framing', () => {
    const out = renderContextPack([
      { id: 1, source: 'web_page', authority: 'untrusted_content', memory_class: 'untrusted_claim', recall_priority: 15, can_use_as_instruction: false, content: 'a | b\nc' },
    ]);
    expect(out.split('\n')).toHaveLength(2); // header + 1 row (newline collapsed)
    expect(out).toContain('\\|'); // literal pipe escaped
  });
});
