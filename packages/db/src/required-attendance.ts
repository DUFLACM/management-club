import { randomUUID } from 'node:crypto'
import type { PrismaClient } from './generated/client/client.js'

/** 等活动及全部现场窗口结束后再判缺勤，窗口截止时刻仍允许提交。 */
export function attendanceDeadline(activity: { endAt: Date; policy?: { checkinCloseAt: Date; checkoutCloseAt: Date | null } | null }): Date {
  return new Date(Math.max(activity.endAt.getTime(), activity.policy?.checkinCloseAt.getTime() ?? 0, activity.policy?.checkoutCloseAt?.getTime() ?? 0))
}

/** API 与 Worker 共用；活动锁防止与签到、名单修改或人工更正交叉，重复运行不覆盖人工认定。 */
export async function settleRequiredAbsences(db: PrismaClient, activityId: string, now = new Date()) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM activities WHERE id = ${activityId}::uuid FOR UPDATE`
    const activity = await tx.activity.findUnique({
      where: { id: activityId },
      include: { policy: true, participants: { where: { required: true } }, checkpoints: true, leaveRequests: true, remotePermissions: true, attempts: true, results: true },
    })
    if (!activity || activity.status !== 'published') return { absent: 0, pendingReview: 0, skipped: true }
    if (attendanceDeadline(activity) >= now) return { absent: 0, pendingReview: 0, skipped: true }
    const checkedIn = new Set(activity.checkpoints.map((checkpoint) => checkpoint.userId))
    const leaves = new Map(activity.leaveRequests.map((leave) => [leave.userId, leave.status]))
    const remotes = new Map(activity.remotePermissions.map((remote) => [remote.userId, remote.status]))
    const attempted = new Set(activity.attempts.map((attempt) => attempt.userId))
    const results = new Map(activity.results.map((result) => [result.userId, result]))
    let absent = 0
    let pendingReview = 0
    for (const participant of activity.participants) {
      const userId = participant.userId
      if (checkedIn.has(userId) || leaves.get(userId) === 'approved' || remotes.get(userId) === 'approved') continue
      const existing = results.get(userId)
      if (existing && (existing.reviewStatus !== 'pending' || existing.decidedBy || !['pending', 'pending_review', 'absent'].includes(existing.status))) continue
      const needsReview = attempted.has(userId) || leaves.get(userId) === 'pending' || remotes.get(userId) === 'pending'
      const status = needsReview ? 'pending_review' : 'absent'
      const note = needsReview ? '必到成员未到场，已有签到尝试或待审核申请，待人工复核' : '必到成员出勤截止仍未签到，且无待审核或获批的请假/远程申请，自动记为缺勤（扣分另行审核）'
      if (existing?.status === status && existing.reviewNote === note) continue
      const result = await tx.attendanceAttendanceResult.upsert({
        where: { activityId_userId: { activityId, userId } },
        create: { id: randomUUID(), activityId, userId, status, reviewNote: note },
        update: { status, reviewNote: note, revision: { increment: 1 } },
      })
      await tx.auditLog.create({ data: {
        id: randomUUID(), action: 'attendance.auto_absence', resourceType: 'attendance_result', resourceId: result.id,
        summary: `${activityId}/${userId}：${note}`,
      } })
      if (needsReview) pendingReview++
      else absent++
    }
    return { absent, pendingReview, skipped: false }
  })
}
