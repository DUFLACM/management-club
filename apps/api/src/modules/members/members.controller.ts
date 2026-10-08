import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common'
import { z } from 'zod'
import { SessionGuard, PermissionsGuard, ActionGuard, RequireAction, CurrentUser, CurrentActor, ok } from '../../common/guards.js'
import { MembersService, MembersError, MEMBERSHIP_STATUSES } from './members.service.js'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import type { SessionActor } from '../auth/session.service.js'

@Controller('/api/v1/me')
@UseGuards(SessionGuard, PermissionsGuard)
export class MeController {
  constructor(
    private readonly members: MembersService,
    private readonly db: PrismaService,
  ) {}

  @Get('dashboard')
  async dashboard(@CurrentUser() user: { userId: string }) {
    return ok(await this.members.memberDashboard(user.userId))
  }

  /** 本人出勤历史 */
  @Get('attendance')
  async attendance(@CurrentUser() user: { userId: string }) {
    const results = await this.db.attendanceAttendanceResult.findMany({
      where: { userId: user.userId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: { activity: { select: { id: true, title: true, type: true, startAt: true, endAt: true } } },
    })
    return ok(results)
  }

  @Get('room-bookings')
  async roomBookings(@CurrentUser() user: { userId: string }) {
    return ok(await this.members.myRoomBookings(user.userId))
  }

  @Post('room-bookings')
  async createRoomBooking(@CurrentUser() user: { userId: string }, @Body() body: unknown) {
    const parsed = z.object({
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
      purpose: z.string().min(3).max(300),
      coApplicantUserIds: z.array(z.string().uuid()).min(2).max(8),
      contestLink: z.string().max(300).optional(),
    }).parse(body)
    return ok(await this.members.createRoomBooking(user.userId, parsed))
  }
}

@Controller('/api/v1/admin')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class MembersAdminController {
  constructor(
    private readonly members: MembersService,
    private readonly db: PrismaService,
  ) {}

  @Get('dashboard')
  async dashboard() {
    return ok(await this.members.adminDashboard())
  }

  @Get('members')
  @RequireAction('members.read')
  async list(@Query('q') q?: string, @Query('status') status?: string, @Query('cursor') cursor?: string) {
    return ok(await this.members.adminMembers({ q, status, cursor }))
  }

  @Get('members/:id')
  @RequireAction('members.read')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    const user = await this.db.user.findUnique({
      where: { id },
      include: {
        profile: true,
        membershipTerms: { orderBy: { createdAt: 'desc' } },
        platformAccounts: true,
        restrictions: true,
        registrations: { take: 10, orderBy: { createdAt: 'desc' }, include: { activity: { select: { title: true, startAt: true } } } },
      },
    })
    return ok(user)
  }

  @Post('members/:id/membership-decision')
  @RequireAction('members.review')
  async membershipDecision(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ decision: z.enum(['admit', 'reject']), reason: z.string().min(3).max(500) }).parse(body)
    await this.members.reviewMembership(actor, id, parsed.decision, parsed.reason)
    return ok({ decided: true })
  }

  /** 直接调整身份（presidium）：记录流转与审计 */
  @Post('members/:id/membership')
  @RequireAction('members.manage')
  async setMembership(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ status: z.enum(MEMBERSHIP_STATUSES), reason: z.string().min(3).max(500) }).safeParse(body)
    if (!parsed.success) throw new MembersError(parsed.error.issues[0].message, 'INVALID_INPUT')
    await this.members.setMembership(actor, id, parsed.data.status, parsed.data.reason)
    return ok({ updated: true })
  }

  /** 禁用账号（软删除）：会话立即失效，历史保留 */
  @Post('members/:id/disable')
  @RequireAction('members.manage')
  async disableMember(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ reason: z.string().min(3).max(500) }).safeParse(body)
    if (!parsed.success) throw new MembersError(parsed.error.issues[0].message, 'INVALID_INPUT')
    await this.members.disableMember(actor, id, parsed.data.reason)
    return ok({ disabled: true })
  }

  @Post('members/:id/enable')
  @RequireAction('members.manage')
  async enableMember(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    await this.members.enableMember(actor, id)
    return ok({ enabled: true })
  }

  /** 删除空账号成员（无任何业务数据；有记录请禁用） */
  @Delete('members/:id')
  @RequireAction('members.manage')
  async deleteMember(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    await this.members.deleteMember(actor, id)
    return ok({ deleted: true })
  }

  /** 批量删除空账号（逐项校验，失败项跳过并返回原因） */
  @Post('members/batch-delete')
  @RequireAction('members.manage')
  async batchDeleteMembers(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = z.object({ userIds: z.array(z.string().uuid()).min(1).max(100) }).safeParse(body)
    if (!parsed.success) throw new MembersError(parsed.error.issues[0].message, 'INVALID_INPUT')
    return ok(await this.members.batchDeleteMembers(actor, parsed.data.userIds))
  }

  /** Excel/表格批量导入成员：管理员确认为已验证成员，跳过 CAS 核验直接建账号 */
  @Post('members/import')
  @RequireAction('members.manage')
  async importMembers(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const rowSchema = z.object({
      studentNo: z.string().min(1).max(64),
      realName: z.string().min(1).max(100),
      grade: z.number().int().optional(),
      phone: z.string().max(32).optional(),
      membershipStatus: z.enum(MEMBERSHIP_STATUSES).optional(),
      /** 本批次录取名次 r：填了即自动记入社基础分 */
      admissionRank: z.number().int().min(1).optional(),
    })
    const parsed = z.object({
      rows: z.array(rowSchema).min(1).max(500),
      /** 本批次录取总人数 m（默认 max(有名次的行数, 最大名次)） */
      admissionTotal: z.number().int().min(1).max(1000).optional(),
      /** 入社月份 YYYY-MM（默认导入当月） */
      admissionMonth: z.string().regex(/^\d{4}-\d{2}$/, '入社月份格式为 YYYY-MM').optional(),
    }).safeParse(body)
    if (!parsed.success) throw new MembersError(parsed.error.issues[0].message, 'INVALID_INPUT')
    const { rows, ...options } = parsed.data
    return ok(await this.members.importMembers(actor, rows, options))
  }

  /** 更改成员平台绑定账号（换绑账号回到待核验；仅改显示名保持原状态） */
  @Post('members/:id/platform-accounts/:accountId')
  @RequireAction('members.manage')
  async updatePlatformAccount(
    @CurrentActor() actor: SessionActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() body: unknown,
  ) {
    const parsed = z.object({
      externalId: z.string().min(2).max(64),
      displayHandle: z.string().max(64).optional(),
    }).safeParse(body)
    if (!parsed.success) throw new MembersError(parsed.error.issues[0].message, 'INVALID_INPUT')
    await this.members.updateMemberPlatformAccount(actor, id, accountId, parsed.data)
    return ok({ updated: true })
  }

  /** 解绑（软删除）成员平台账号：保留历史成绩，可重新绑定 */
  @Post('members/:id/platform-accounts/:accountId/revoke')
  @RequireAction('members.manage')
  async revokePlatformAccount(
    @CurrentActor() actor: SessionActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ) {
    await this.members.revokeMemberPlatformAccount(actor, id, accountId)
    return ok({ revoked: true })
  }

  @Get('membership-evaluation')
  @RequireAction('members.review')
  async evaluationPreview(@Query('month') month?: string) {
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : undefined
    return ok(await this.members.monthlyEvaluationPreview(m ?? currentMonth()))
  }

  // ---- 邀请 ----
  @Get('invitations')
  @RequireAction('invitations.manage')
  async listInvitations(@Query('cursor') cursor?: string) {
    return ok(await this.members.listInvitations(cursor))
  }

  @Post('invitations')
  @RequireAction('invitations.manage')
  async createInvitation(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = z.object({
      maxUses: z.number().int().min(1).max(200).default(1),
      expiresInDays: z.number().int().min(1).max(365).default(14),
      batchLabel: z.string().max(64).optional(),
      allowedStudentNo: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
    }).parse(body)
    return ok(await this.members.createInvitation(actor, parsed))
  }

  @Post('invitations/:id/revoke')
  @RequireAction('invitations.manage')
  async revokeInvitation(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    await this.members.revokeInvitation(actor, id)
    return ok({ revoked: true })
  }

  // ---- 训练室 ----
  @Get('room-bookings')
  @RequireAction('rooms.approve')
  async roomBookings(@Query('status') status?: string) {
    const rows = await this.db.roomBooking.findMany({
      where: status ? { status } : { status: 'pending' },
      orderBy: { startsAt: 'asc' },
      take: 50,
    })
    return ok(rows)
  }

  @Post('room-bookings/:id/decision')
  @RequireAction('rooms.approve')
  async roomDecision(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().max(500).optional() }).parse(body)
    await this.members.decideRoomBooking(actor, id, parsed.decision, parsed.reason)
    return ok({ decided: true })
  }

  // ---- 审计 ----
  @Get('audit-logs')
  @RequireAction('audit.read')
  async audit(@Query('resourceType') resourceType?: string, @Query('cursor') cursor?: string) {
    return ok(await this.members.auditLogs({ resourceType, cursor }))
  }
}

function currentMonth(): string {
  const d = new Date(Date.now() + 8 * 3600_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
