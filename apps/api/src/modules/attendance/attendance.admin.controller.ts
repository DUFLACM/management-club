import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import QRCode from 'qrcode'
import { SessionGuard, PermissionsGuard, ActionGuard, RequireAction, ok, CurrentActor } from '../../common/guards.js'
import { AttendanceService, AttendanceError } from './attendance.service.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { AuditService } from '../../infrastructure/audit/audit.service.js'
import { newId } from '../../common/utils.js'
import type { SessionActor } from '../auth/session.service.js'
import { enrollRequiredAfterCheckin } from './checkin-registration.js'
import { attendanceDeadline, settleRequiredAbsences } from '@acm/db'

/** 现场码 / 补签 / 复核（/admin?section=activities&tab=attendance） */
@Controller('/api/v1/admin')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class AttendanceAdminController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly db: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 大屏统计直接读取已接受检查点与报名/必到名单，最近名单有界，人数不受名单长度影响。 */
  @Get('activities/:id/attendance/board')
  @RequireAction('attendance.qr')
  async board(@Param('id', ParseUUIDPipe) id: string) {
    const activity = await this.db.activity.findUnique({ where: { id }, select: { id: true } })
    if (!activity) throw new AttendanceError('活动不存在', 'NOT_FOUND')
    const [checkedIn, checkedOut, recent, allCheckins, enrolled, required, leaves, remotes] = await this.db.$transaction([
      this.db.attendanceCheckpoint.count({ where: { activityId: id, checkpoint: 'IN' } }),
      this.db.attendanceCheckpoint.count({ where: { activityId: id, checkpoint: 'OUT' } }),
      this.db.attendanceCheckpoint.findMany({
        where: { activityId: id, checkpoint: 'IN' },
        orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
        take: 24,
        select: { userId: true, acceptedAt: true, user: { select: { verifiedRealName: true } } },
      }),
      this.db.attendanceCheckpoint.findMany({ where: { activityId: id, checkpoint: 'IN' }, select: { userId: true } }),
      this.db.activityRegistration.findMany({
        where: { activityId: id, status: 'enrolled' },
        select: { userId: true, user: { select: { verifiedRealName: true, studentNo: true } } },
      }),
      this.db.activityParticipant.findMany({
        where: { activityId: id, required: true },
        select: { userId: true, user: { select: { verifiedRealName: true, studentNo: true } } },
      }),
      this.db.leaveRequest.findMany({ where: { activityId: id, status: 'approved' }, select: { userId: true } }),
      this.db.remotePermission.findMany({ where: { activityId: id, status: 'approved' }, select: { userId: true } }),
    ], { isolationLevel: 'RepeatableRead' })
    // 应到 = 已报名（enrolled）∪ 必到名单；未到 = 应到中无 IN 检查点且无已批请假/远程
    const checkedInSet = new Set(allCheckins.map((row) => row.userId))
    const excused = new Set([...leaves, ...remotes].map((row) => row.userId))
    const roster = new Map<string, { name: string; studentNo: string }>()
    for (const row of enrolled) roster.set(row.userId, { name: row.user.verifiedRealName ?? '成员', studentNo: row.user.studentNo })
    for (const row of required) {
      if (!roster.has(row.userId)) roster.set(row.userId, { name: row.user.verifiedRealName ?? '成员', studentNo: row.user.studentNo })
    }
    const pendingAll = [...roster.entries()]
      .filter(([userId]) => !checkedInSet.has(userId) && !excused.has(userId))
      .sort((a, b) => a[1].studentNo.localeCompare(b[1].studentNo))
    return ok({
      checkedIn,
      checkedOut,
      registeredTotal: roster.size,
      pendingTotal: pendingAll.length,
      pendingCheckins: pendingAll.slice(0, 48).map(([userId, info]) => ({ userId, name: info.name, studentNo: info.studentNo })),
      recentCheckins: recent.map((row) => ({
        userId: row.userId, name: row.user.verifiedRealName ?? '成员', acceptedAt: row.acceptedAt.toISOString(),
      })),
      updatedAt: new Date().toISOString(),
    })
  }

  /** 当前活动指定地点/检查点的有效现场码（过期自动轮换签发新窗口） */
  @Post('activities/:id/attendance/qr')
  @RequireAction('attendance.qr')
  async issueQr(
    @CurrentActor() actor: SessionActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = z.object({ venueVersionId: z.string().uuid(), checkpoint: z.enum(['IN', 'OUT']) }).parse(body)
    // 复用未过期窗口（轮换期内同一码），过期签新
    const existing = await this.attendance.currentQrForActivity(id, parsed.venueVersionId, parsed.checkpoint)
    if (existing) {
      // 返回既有 token 需要明文 nonce——我们只在签发时持有；过期即签新码。
      // 简化策略：每次请求签发新窗口（管理屏幕按 rotateSeconds 轮询请求本接口）。
    }
    const { token, expiresAt, rotateSeconds } = await this.attendance.issueQrWindow(actor.principalId, id, parsed.venueVersionId, parsed.checkpoint)
    // 深链格式：活动二维码 token 放 fragment（不进 query/Referer/代理日志）
    const dataUrl = await QRCode.toDataURL(`club://att#${token}`, {
      errorCorrectionLevel: 'M',
      margin: 4,
      width: 512,
      color: { dark: '#000000', light: '#FFFFFF' },
    })
    return ok({ token, expiresAt, rotateSeconds, dataUrl, note: '现场码在有效期内可被多位成员使用；黑白码不加 logo，保留 4 模块 quiet zone' })
  }

  /** 人工补签/更正：原值+认定值+原因+证据，追加式；利益关联回避 */
  @Post('attendance/:resultId/corrections')
  @RequireAction('attendance.review')
  async correction(
    @CurrentActor() actor: SessionActor,
    @Param('resultId', ParseUUIDPipe) resultId: string,
    @Body() body: unknown,
  ) {
    const parsed = z.object({
      newStatus: z.enum(['ontime', 'late', 'early_leave', 'late_and_early', 'absent', 'leave_approved', 'remote_approved']),
      reason: z.string().min(3).max(1000),
      evidenceRef: z.string().max(500).optional(),
      lateMinutes: z.number().int().min(0).max(600).optional(),
      earlyMinutes: z.number().int().min(0).max(600).optional(),
    }).parse(body)
    const result = await this.db.attendanceAttendanceResult.findUnique({ where: { id: resultId }, include: { user: true } })
    if (!result) throw new AttendanceError('出勤记录不存在', 'NOT_FOUND')
    if (result.user && result.user.principalId === actor.principalId) {
      throw new AttendanceError('不能为本人补签/更正（利益回避）', 'RECUSED')
    }
    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM activities WHERE id = ${result.activityId}::uuid FOR UPDATE`
      if (['ontime', 'late', 'early_leave', 'late_and_early'].includes(parsed.newStatus)) {
        await enrollRequiredAfterCheckin(tx, result.activityId, result.userId, new Date(), actor.principalId)
      }
      await tx.attendanceCorrection.create({
        data: {
          id: newId(),
          resultId,
          originalValue: { status: result.status, lateMinutes: result.lateMinutes, earlyMinutes: result.earlyMinutes } as never,
          correctedValue: { status: parsed.newStatus, lateMinutes: parsed.lateMinutes ?? 0, earlyMinutes: parsed.earlyMinutes ?? 0 } as never,
          reason: parsed.reason,
          evidenceRef: parsed.evidenceRef,
          operatorId: actor.principalId,
        },
      })
      await tx.attendanceAttendanceResult.update({
        where: { id: resultId },
        data: {
          status: parsed.newStatus,
          lateMinutes: parsed.lateMinutes ?? 0,
          earlyMinutes: parsed.earlyMinutes ?? 0,
          reviewStatus: 'corrected',
          reviewNote: parsed.reason,
          decidedBy: actor.principalId,
          revision: { increment: 1 },
        },
      })
      await tx.auditLog.create({
        data: {
          id: newId(),
          actorPrincipalId: actor.principalId,
          action: 'attendance.correction',
          resourceType: 'attendance_result',
          resourceId: resultId,
          summary: `人工更正为 ${parsed.newStatus}：${parsed.reason.slice(0, 200)}`,
        },
      })
    })
    return ok({ corrected: true })
  }

  /** 请假审批 */
  @Post('leave-requests/:id/decision')
  @RequireAction('attendance.review')
  async leaveDecision(
    @CurrentActor() actor: SessionActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional() }).parse(body)
    const leave = await this.db.leaveRequest.findUnique({ where: { id }, include: { user: true } })
    if (!leave) throw new AttendanceError('请假申请不存在', 'NOT_FOUND')
    if (leave.user.principalId === actor.principalId) throw new AttendanceError('不能审批本人请假（利益回避）', 'RECUSED')
    await this.db.leaveRequest.update({
      where: { id },
      data: { status: parsed.decision === 'approve' ? 'approved' : 'rejected', reviewedBy: actor.principalId, reviewedAt: new Date(), reviewNote: parsed.note },
    })
    if (parsed.decision === 'approve') {
      await this.db.attendanceAttendanceResult.upsert({
        where: { activityId_userId: { activityId: leave.activityId, userId: leave.userId } },
        create: { id: newId(), activityId: leave.activityId, userId: leave.userId, status: 'leave_approved', decidedBy: actor.principalId },
        update: { status: 'leave_approved', decidedBy: actor.principalId, revision: { increment: 1 } },
      })
    }
    return ok({ decided: parsed.decision })
  }

  /** 远程参赛审批（月次数由积分认定时校验） */
  @Post('remote-requests/:id/decision')
  @RequireAction('activity.manage')
  async remoteDecision(
    @CurrentActor() actor: SessionActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(500).optional() }).parse(body)
    const perm = await this.db.remotePermission.findUnique({ where: { id }, include: { user: true } })
    if (!perm) throw new AttendanceError('远程申请不存在', 'NOT_FOUND')
    if (perm.user.principalId === actor.principalId) throw new AttendanceError('利益回避', 'RECUSED')
    await this.db.remotePermission.update({
      where: { id },
      data: { status: parsed.decision === 'approve' ? 'approved' : 'rejected', approvedBy: actor.principalId, approvedAt: new Date() },
    })
    return ok({ decided: parsed.decision })
  }

  /** 活动结束后批量生成出勤认定候选（pending_review 不自动满勤/扣分） */
  @Post('activities/:id/settle')
  @RequireAction('attendance.review')
  async settle(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    const activity = await this.db.activity.findUnique({
      where: { id },
      include: { policy: true, participants: true, checkpoints: true, leaveRequests: true, remotePermissions: true },
    })
    if (!activity) throw new AttendanceError('活动不存在', 'NOT_FOUND')
    const now = new Date()
    if (attendanceDeadline(activity) >= now) throw new AttendanceError('活动及出勤窗口尚未结束，不能提前认定缺勤', 'ATTENDANCE_NOT_ENDED')
    const checkpointsByUser = new Map<string, Map<string, Date>>()
    for (const c of activity.checkpoints) {
      if (!checkpointsByUser.has(c.userId)) checkpointsByUser.set(c.userId, new Map())
      checkpointsByUser.get(c.userId)!.set(c.checkpoint, c.acceptedAt)
    }
    const durationMin = (activity.endAt.getTime() - activity.startAt.getTime()) / 60_000
    let created = 0
    for (const [userId, cps] of checkpointsByUser) {
      const existing = await this.db.attendanceAttendanceResult.findUnique({ where: { activityId_userId: { activityId: id, userId } } })
      if (existing && existing.status !== 'pending') continue
      const inAt = cps.get('IN')
      const outAt = cps.get('OUT')
      let status: string
      if (!inAt && !outAt) continue
      if (inAt && !outAt) status = 'pending_review' // 缺签退不默认满勤
      else if (!inAt && outAt) status = 'pending_review'
      else {
        const lateMin = Math.max(0, Math.round((inAt!.getTime() - activity.startAt.getTime()) / 60_000))
        const earlyMin = Math.max(0, Math.round((activity.endAt.getTime() - outAt!.getTime()) / 60_000))
        if (lateMin > durationMin / 2 || earlyMin > durationMin / 2) status = 'pending_review'
        else if (lateMin > 15 || earlyMin > 15) status = lateMin > 15 && earlyMin > 15 ? 'late_and_early' : lateMin > 15 ? 'late' : 'early_leave'
        else status = 'ontime'
        await this.db.attendanceAttendanceResult.upsert({
          where: { activityId_userId: { activityId: id, userId } },
          create: { id: newId(), activityId: id, userId, status, lateMinutes: lateMin, earlyMinutes: earlyMin },
          update: { status, lateMinutes: lateMin, earlyMinutes: earlyMin, revision: { increment: 1 } },
        })
        created++
        continue
      }
      await this.db.attendanceAttendanceResult.upsert({
        where: { activityId_userId: { activityId: id, userId } },
        create: { id: newId(), activityId: id, userId, status, reviewNote: !outAt ? '有 IN 无 OUT：待人工复核' : '仅有 OUT：待人工复核' },
        update: { status, reviewNote: !outAt ? '有 IN 无 OUT：待人工复核' : '仅有 OUT：待人工复核', revision: { increment: 1 } },
      })
      created++
    }
    const absences = await settleRequiredAbsences(this.db, id)
    void actor
    return ok({ created, absenceCandidates: absences.absent + absences.pendingReview, absent: absences.absent, pendingReview: absences.pendingReview, note: '必到成员无操作逾期记为缺勤；待审核申请和签到异常保留待复核，扣分另行审核' })
  }
}
