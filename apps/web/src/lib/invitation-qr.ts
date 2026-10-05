/** 与后端 invitation codec 的 12 位字母表一致：不含 0、1、I、L、O。 */
export const INVITE_PATTERN = /^[A-HJ-KM-NP-Z2-9]{12}$/;

export function normalizeInviteCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

/** 扫码仅提取裸邀请码或本站邀请链接的 fragment，不导航、不记录原文。 */
export function parseInvitationQr(text: string, origin: string): string | null {
  const raw = text.trim();
  const code = normalizeInviteCode(raw);
  if (INVITE_PATTERN.test(code)) return code;
  try {
    const url = new URL(raw, origin);
    if (url.origin !== new URL(origin).origin || url.pathname !== '/register' || url.search || url.username || url.password) return null;
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (fragment.getAll('invite').length !== 1) return null;
    const value = normalizeInviteCode(fragment.get('invite') ?? '');
    return INVITE_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}
