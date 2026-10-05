import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@acm/db'
import type { SessionActor } from '../../modules/auth/session.service.js'

/** 测试助手：直接以服务层对接真实 PostgreSQL（绕过 HTTP；并发/约束/事务验证的最直接方式） */

export function makeActor(overrides: Partial<SessionActor> = {}): SessionActor {
  return {
    sessionId: randomUUID(),
    principalId: randomUUID(),
    principalKind: 'student',
    authzVersion: 1,
    roles: ['presidium'],
    ...overrides,
  }
}

export async function createTestUser(
  db: PrismaClient,
  opts: { studentNo: string; name?: string; membership?: string; semesterId?: string },
): Promise<{ userId: string; principalId: string; actor: SessionActor }> {
  const principalId = randomUUID()
  const userId = randomUUID()
  await db.principal.create({ data: { id: principalId, kind: 'student' } })
  await db.user.create({
    data: { id: userId, principalId, studentNo: opts.studentNo, verifiedRealName: opts.name ?? `测试${opts.studentNo}` },
  })
  await db.authIdentity.create({
    data: { id: randomUUID(), principalId, provider: 'cas', subject: `test-${opts.studentNo}`, verifiedCampusId: opts.studentNo },
  })
  await db.userProfile.create({ data: { userId, displayName: opts.name ?? null } })
  await db.membershipTerm.create({
    data: {
      id: randomUUID(), userId,
      semesterId: opts.semesterId ?? (await ensureSemester(db)),
      membershipStatus: opts.membership ?? 'formal',
    },
  })
  await db.roleGrant.create({ data: { id: randomUUID(), principalId, role: 'member', grantedBy: principalId } })
  const actor = makeActor({ principalId, userId, studentNo: opts.studentNo })
  return { userId, principalId, actor }
}

export async function ensureSemester(db: PrismaClient): Promise<string> {
  const existing = await db.semester.findFirst({ where: { code: 'TEST' } })
  if (existing) return existing.id
  const created = await db.semester.create({
    data: { id: randomUUID(), code: 'TEST', name: '测试学期', startsOn: new Date('2026-01-01'), endsOn: new Date('2027-01-01') },
  })
  return created.id
}

/** 建立已认证地点版本（走完整 venue 流程：创建→提交→独立审批），返回 venueId/versionId */
export async function createApprovedVenue(
  venueService: import('../../modules/venues/venue.service.js').VenueService,
  manager: SessionActor,
  verifier: SessionActor,
  opts: { name: string; lat?: number; lng?: number; radius?: number; capabilities?: string[] },
): Promise<{ venueId: string; versionId: string }> {
  const { venueId, versionId } = await venueService.createVenue(manager, {
    name: opts.name,
    building: '测试楼',
    room: '101',
    latitude: opts.lat ?? 39.9,
    longitude: opts.lng ?? 116.4,
    radiusMeters: opts.radius ?? 80,
    maxAccuracyMeters: 50,
    allowedCapabilities: (opts.capabilities ?? ['GEO', 'QR']) as never,
    coordinateSource: 'manual_verified',
  })
  await venueService.submitForReview(manager, venueId, versionId, 1)
  await venueService.decide(verifier, venueId, versionId, 'approve', '测试认证')
  return { venueId, versionId }
}

export function minutesFromNow(min: number): Date {
  return new Date(Date.now() + min * 60_000)
}
