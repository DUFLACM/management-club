/** 回调仅接受已知错误码映射，绝不显示查询参数原文或认证票据。 */
export function casErrorMessage(code: string | null): string | null {
  if (!code) return null;
  switch (code) {
    case 'FLOW_INVALID':
    case 'COOKIE_BINDING_MISMATCH':
      return '登录流程已失效，请重新发起校园认证。';
    case 'NOT_REGISTERED':
      return '当前校园账号尚未入社，请使用协会邀请注册。';
    case 'CAS_CONTRACT_MISSING':
    case 'CAMPUS_ID_MISSING':
    case 'STUDENT_NO_MISSING':
    case 'REAL_NAME_MISSING':
      return '暂时无法核验校园身份，请联系协会管理员。';
    case 'CAS_AUTH_FAILURE':
      return '校园认证未完成，请重新认证。';
    default:
      return '登录未完成，请重新发起校园认证。';
  }
}
