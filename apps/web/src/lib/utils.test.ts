import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('合并多个类名', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('条件类名按条件生效', () => {
    expect(cn('px-4', false && 'hidden', 'py-2')).toBe('px-4 py-2');
  });

  it('Tailwind 冲突时保留后者', () => {
    expect(cn('px-4', 'px-2')).toBe('px-2');
  });
});
