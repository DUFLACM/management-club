import { QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { UNAUTHORIZED_EVENT } from './api';
import { attachSessionListeners, createQueryClient } from './query';
import { hasAnyAction, normalizeCsrfSession, type CsrfSession } from './session';

it('会话过期时通知正在查看姓名的页面，并清除私人缓存', () => {
  vi.stubGlobal('window', new EventTarget());
  const client = createQueryClient();
  const key = ['session', 'csrf'];
  const privateKey = ['principal', 'member-1', 'me', 'evaluation', 'publicity-names'];
  client.setQueryData(key, normalizeCsrfSession({ authenticated: true, userId: 'member-1' }));
  client.setQueryData(privateKey, { rows: [{ displayName: '测试成员' }] });
  const observer = new QueryObserver<CsrfSession>(client, { queryKey: key, enabled: false });
  const notify = vi.fn();
  const unsubscribe = observer.subscribe(notify);
  const detach = attachSessionListeners(client);
  try {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ data: normalizeCsrfSession(null) }));
    expect(client.getQueryData(privateKey)).toBeUndefined();
  } finally {
    detach();
    unsubscribe();
    vi.unstubAllGlobals();
  }
});

describe('积分公示管理权限', () => {
  it('系统管理员与有积分审核权限的业务角色可以管理公示', () => {
    for (const role of ['system_admin', 'points_reviewer', 'presidium', 'advisor']) {
      expect(hasAnyAction([role], ['points.review'])).toBe(true);
    }
    expect(hasAnyAction(['member', 'activity_manager'], ['points.review'])).toBe(false);
    expect(hasAnyAction(['system_admin'], [])).toBe(false);
  });
});

describe('CSRF session identity normalization', () => {
  it('keeps a staff principal authenticated without inventing a student user', () => {
    expect(normalizeCsrfSession({
      authenticated: true,
      principalId: 'principal-staff-1',
      principalKind: 'staff',
      userId: null,
      campusId: 'T00123',
      studentNo: null,
      staffNo: 'T00123',
      roles: ['advisor'],
    })).toEqual({
      authenticated: true,
      principalId: 'principal-staff-1',
      principalKind: 'staff',
      userId: null,
      campusId: 'T00123',
      studentNo: null,
      staffNo: 'T00123',
      roles: ['advisor'],
      nowcoderBound: null,
    });
  });

  it('keeps legacy student sessions working while the API contract rolls out', () => {
    expect(normalizeCsrfSession({
      authenticated: true,
      userId: 'member-1',
      studentNo: '00123456',
      roles: ['member'],
    })).toMatchObject({
      principalId: 'member-1',
      principalKind: 'student',
      userId: 'member-1',
      campusId: '00123456',
      studentNo: '00123456',
    });
  });
});
