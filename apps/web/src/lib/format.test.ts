import { describe, expect, it } from 'vitest';

import { formatMemberName, memberName } from './format';

describe('成员显示名', () => {
  it('展示名后括号带实名；未设展示名或与实名相同时只显示实名', () => {
    expect(formatMemberName('Alice', '张三')).toBe('Alice（张三）');
    expect(formatMemberName('张三', '张三')).toBe('张三');
    expect(formatMemberName(null, '张三')).toBe('张三');
    expect(memberName({ verifiedRealName: '李四', profile: { displayName: '  ' } })).toBe('李四');
    expect(memberName(null, '队员')).toBe('队员');
  });
});
