import type { Prisma } from '@acm/db'
import { newId } from '../../common/utils.js'

/** 调用方持有活动锁；仅为必到成员已接受的入场签到或人工到场认定确认报名。 */
export async function enrollRequiredAfterCheckin(
  tx: Prisma.TransactionClient, activityId: string, userId: string, acceptedAt: Date, actorPrincipalId?: string,
): Promise<boolean> {
  const participant = await tx.activityParticipant.findUnique({ where: { activityId_userId: { activityId, userId } } })
  if (!participant?.required) return false
  const existing = await tx.activityRegistration.findUnique({ where: { activityId_userId: { activityId, userId } } })
  if (existing?.status === 'enrolled') return false
  const data = { status: 'enrolled', acceptedAt, waitlistSeq: null, confirmDeadline: null, cancelledAt: null, cancelReason: null }
  const registration = existing
    ? await tx.activityRegistration.update({ where: { id: existing.id }, data: { ...data, revision: { increment: 1 } } })
    : await tx.activityRegistration.create({ data: { id: newId(), activityId, userId, ...data } })
  await tx.registrationHistory.create({
    data: { id: newId(), registrationId: registration.id, fromStatus: existing?.status ?? null, toStatus: 'enrolled', actorPrincipalId, note: '必到成员现场签到成功，自动报名' },
  })
  return true
}
