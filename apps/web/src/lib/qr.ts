/**
 * 二维码工具：token 解析（深链/URL/裸 token）与前端生成（动态 import qrcode）。
 * 生成二维码的页面按需加载 qrcode 库，避免进入首屏包。
 */

/** 从扫码文本/深链/URL 中提取出勤 token。 */
export function parseQrToken(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // 深链：club://att#<token>
  const deep = trimmed.match(/^club:\/\/att#(.+)$/i);
  if (deep?.[1]) return deep[1];
  // 站内 URL：…#q=<token> 或 …?q=<token>
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) {
    try {
      const url = new URL(trimmed, window.location.origin);
      const fromQuery = url.searchParams.get('q');
      if (fromQuery) return fromQuery;
      const hash = url.hash.replace(/^#/, '');
      if (hash) {
        const fromHash = new URLSearchParams(hash).get('q');
        if (fromHash) return fromHash;
      }
    } catch {
      // 非 URL 形态，继续按裸 token 处理
    }
  }
  // 裸 token（签发的 base64url 串，长度 ≥10）
  if (trimmed.length >= 10 && /^[\w-]+$/.test(trimmed)) return trimmed;
  return null;
}

/** 生成黑白二维码 dataUrl（无 logo，保留 quiet zone）。 */
export async function renderQrDataUrl(text: string): Promise<string> {
  const QRCode = await import('qrcode');
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 512,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}
