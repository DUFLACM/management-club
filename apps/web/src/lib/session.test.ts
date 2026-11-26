import { describe, expect, it } from 'vitest';

import { hasAnyAction, normalizeCsrfSession } from './session';

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
