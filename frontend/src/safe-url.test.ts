import { describe, expect, it } from 'vitest';
import { safeHttpUrl } from './safe-url';

describe('job source URLs', () => {
  it('accepts absolute HTTP(S) links', () => { expect(safeHttpUrl('https://example.com/job')).toBe('https://example.com/job'); expect(safeHttpUrl('http://example.com')).toBe('http://example.com/'); });
  it('rejects executable schemes and malformed/cached unsafe values', () => {
    for (const value of ['javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,test', '//example.com', 'https://user:password@example.com', '', null]) expect(safeHttpUrl(value)).toBeUndefined();
  });
});
