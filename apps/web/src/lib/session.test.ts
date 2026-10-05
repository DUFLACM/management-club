import { describe, expect, it } from 'vitest';

import { normalizeCsrfSession } from './session';

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
