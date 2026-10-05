import { describe, expect, it } from 'vitest';
import { casErrorMessage } from './cas-errors';

describe('CAS 回调错误说明', () => {
  it('为已知认证问题提供可执行的下一步', () => {
    expect(casErrorMessage('FLOW_INVALID')).toContain('重新发起');
    expect(casErrorMessage('COOKIE_BINDING_MISMATCH')).toContain('重新发起');
    expect(casErrorMessage('NOT_REGISTERED')).toContain('邀请注册');
    for (const code of ['CAS_CONTRACT_MISSING', 'CAMPUS_ID_MISSING', 'STUDENT_NO_MISSING', 'REAL_NAME_MISSING']) expect(casErrorMessage(code)).toContain('管理员');
    expect(casErrorMessage('CAS_AUTH_FAILURE')).toContain('重新认证');
  });

  it('未知输入只显示通用说明，未收到错误时不生成提示', () => {
    expect(casErrorMessage('<script>ticket-secret</script>')).toBe('登录未完成，请重新发起校园认证。');
    expect(casErrorMessage(null)).toBeNull();
    expect(casErrorMessage('')).toBeNull();
  });
});
