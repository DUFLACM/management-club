import { describe, expect, it } from 'vitest';
import { parseInvitationQr } from './invitation-qr';

const origin = 'https://club.example.edu';
const code = '7K2MQR4T9WXZ';

describe('邀请二维码解析', () => {
  it('接受裸邀请码、分组粘贴和本站 fragment 链接', () => {
    expect(parseInvitationQr(code, origin)).toBe(code);
    expect(parseInvitationQr(' 7k2m-qr4t-9wxz ', origin)).toBe(code);
    expect(parseInvitationQr(`${origin}/register#invite=${code}`, origin)).toBe(code);
    expect(parseInvitationQr(`/register#invite=${code}`, origin)).toBe(code);
  });

  it('拒绝外站、相似域名、其他路径和歧义参数', () => {
    for (const value of [
      `https://external.example/register#invite=${code}`,
      `https://club.example.edu.external.example/register#invite=${code}`,
      `/app#invite=${code}`, `/register?invite=${code}`,
      `/register#invite=${code}&invite=${code}`,
      `https://user:pass@club.example.edu/register#invite=${code}`,
      `club://att#${code}`,
    ]) expect(parseInvitationQr(value, origin)).toBeNull();
  });

  it('拒绝错误长度和后端字母表排除的易混字符', () => {
    for (const value of ['', code.slice(1), code+'A', '7K2LQR4T9WXZ', '7K2IQR4T9WXZ', '7K2OQR4T9WXZ', '7K20QR4T9WXZ', '7K21QR4T9WXZ']) {
      expect(parseInvitationQr(value, origin)).toBeNull();
    }
  });
});
