import { describe, expect, it } from 'vitest';
import { parseCuePoints, replaceProbeBlock, renderTable } from './probe.ts';

describe('parseCuePoints', () => {
  it('turns the flat name,time list into cue points, keeping Live order', () => {
    expect(parseCuePoints(['Song A', 0, 'Verse', 16.5, 'Song B', 8])).toEqual([
      { index: 0, name: 'Song A', time: 0 },
      { index: 1, name: 'Verse', time: 16.5 },
      { index: 2, name: 'Song B', time: 8 },
    ]);
  });
  it('handles an empty set and ignores a dangling name', () => {
    expect(parseCuePoints([])).toEqual([]);
    expect(parseCuePoints(['A', 0, 'B'])).toHaveLength(1);
  });
});

describe('replaceProbeBlock', () => {
  it('appends the block when markers are missing', () => {
    const out = replaceProbeBlock('# Compat\n\nnotes', 'table');
    expect(out).toBe('# Compat\n\nnotes\n\n<!-- probe:start -->\ntable\n<!-- probe:end -->\n');
  });
  it('replaces only the marked block and keeps manual notes around it', () => {
    const doc = 'before\n<!-- probe:start -->\nold\n<!-- probe:end -->\nafter';
    expect(replaceProbeBlock(doc, 'new')).toBe('before\n<!-- probe:start -->\nnew\n<!-- probe:end -->\nafter');
  });
});

it('renderTable escapes pipes in details', () => {
  expect(renderTable([{ n: 1, check: 'X', status: 'PASS', detail: 'a|b' }])).toContain('a\\|b');
});
