import fs from 'node:fs'
import path from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { randomUUID } from 'node:crypto'
import { createPrismaClient, type PrismaClient } from './client.js'
import { sha256Hex } from './seed-utils.js'

// 加载仓库根 .env（seed 通过 tsx 在 packages/db 下执行）
{
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env')
    if (fs.existsSync(candidate)) {
      loadDotenv({ path: candidate })
      break
    }
    dir = path.dirname(dir)
  }
}

/**
 * 开发 seed（仅本地/演示；生产禁止执行——生产启动不得含模拟认证/示例审批数据）。
 * 全部示例身份均带 dev- 前缀 subject 与“演示”标记，不含真实凭证。
 * 幂等：重复执行跳过已存在数据。
 */

async function main(): Promise<void> {
  const db: PrismaClient = createPrismaClient(process.env.DATABASE_URL!)
  const demo = process.env.SEED_DEMO_DATA !== 'false'

  // 1. 规则版本 v1（monthlyRounding 保持 pending —— R01 未决，正式月结算阻塞是预期行为）
  const ruleCount = await db.ruleVersion.count()
  if (ruleCount === 0) {
    const { defaultRuleParams } = await import('@acm/scoring-core')
    await db.ruleVersion.create({
      data: {
        id: randomUUID(),
        version: 1,
        source: 'seed：docs/ 九份 PDF（核对 2026-10-05）；R01–R13 未决项见 pending_items',
        params: defaultRuleParams() as never,
        pendingItems: { open: ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10', 'R11', 'R12', 'R13'] } as never,
        status: 'published',
        effectiveFrom: new Date('2026-01-01'),
      },
    })
    console.log('✓ 规则版本 v1（R01 pending）')
  }

  // 2. 学期
  let semester = await db.semester.findFirst({ where: { code: '2026F' } })
  if (!semester) {
    semester = await db.semester.create({
      data: { id: randomUUID(), code: '2026F', name: '2026 秋季学期（演示）', startsOn: new Date('2026-09-01'), endsOn: new Date('2027-01-15') },
    })
    console.log('✓ 学期 2026F')
  }

  if (!demo) {
    console.log('SEED_DEMO_DATA=false：仅初始化规则版本与学期')
    await db.$disconnect()
    return
  }

  // 3. 演示用户（演示标记：verifiedRealName 带“（演示）”后缀；subject 为 dev-<学号>，可被 dev CAS 模拟器登录）
  const demoUsers: Array<{ studentNo: string; name: string; membership: string; grade: number }> = [
    { studentNo: '202600001', name: '林同学（演示）', membership: 'formal', grade: 2026 },
    { studentNo: '202600002', name: '王同学（演示）', membership: 'formal', grade: 2026 },
    { studentNo: '202600003', name: '李同学（演示）', membership: 'observing', grade: 2026 },
    { studentNo: '202600004', name: '赵同学（演示）', membership: 'applicant', grade: 2026 },
  ]
  const userIds: string[] = []
  for (const u of demoUsers) {
    const existing = await db.user.findUnique({ where: { studentNo: u.studentNo } })
    if (existing) {
      userIds.push(existing.id)
      continue
    }
    const principalId = randomUUID()
    const userId = randomUUID()
    await db.principal.create({ data: { id: principalId, kind: 'student' } })
    await db.user.create({
      data: { id: userId, principalId, studentNo: u.studentNo, verifiedRealName: u.name, grade: u.grade },
    })
    await db.authIdentity.create({
      data: { id: randomUUID(), principalId, provider: 'cas', subject: `dev-${u.studentNo}`, verifiedCampusId: u.studentNo, verifiedRealName: u.name },
    })
    await db.userProfile.create({ data: { userId, displayName: u.name.replace('（演示）', '') } })
    await db.membershipTerm.create({
      data: { id: randomUUID(), userId, semesterId: semester.id, membershipStatus: u.membership, basis: '演示数据', semesterRegisteredAt: new Date() },
    })
    await db.roleGrant.create({ data: { id: randomUUID(), principalId, role: 'member', grantedBy: principalId } })
    userIds.push(userId)
  }
  // 管理角色：主席团（演示）授予 202600001 —— 实际生产通过 CLI 绑定已验证主体
  const adminUser = await db.user.findUnique({ where: { studentNo: '202600001' } })
  if (adminUser) {
    const hasRole = await db.roleGrant.findFirst({ where: { principalId: adminUser.principalId, role: 'presidium' } })
    if (!hasRole) {
      await db.roleGrant.create({ data: { id: randomUUID(), principalId: adminUser.principalId, role: 'presidium', grantedBy: adminUser.principalId } })
    }
  }
  console.log('✓ 演示用户 4 名（formal×2 / observing×1 / applicant×1），管理员=202600001（presidium）')

  // 4. 已认证地点（演示坐标：明确标记为示例数据，不得冒充实测）
  let venueVersionId: string | null = null
  const existingVenue = await db.venue.findFirst({ where: { name: '教学楼 A-306（演示）' } })
  if (!existingVenue) {
    const systemPrincipal = await ensureSystemPrincipal(db)
    const venueId = randomUUID()
    venueVersionId = randomUUID()
    await db.venue.create({
      data: { id: venueId, name: '教学楼 A-306（演示）', campus: '主校区', building: '教学楼 A', floor: '3', room: '306', operationalStatus: 'active', createdBy: systemPrincipal },
    })
    await db.venueVersion.create({
      data: {
        id: venueVersionId, venueId, versionNo: 1, status: 'approved',
        name: '教学楼 A-306（演示）', campus: '主校区', building: '教学楼 A', floor: '3', room: '306',
        // 示例坐标（演示）：121.5°E 附近；生产必须现场采样核验
        latitude: 38.8800, longitude: 121.5300, radiusMeters: 60, maxAccuracyMeters: 45,
        coordinateSource: 'manual_verified',
        allowedCapabilities: ['GEO', 'QR'],
        contentHash: sha256Hex('demo-venue-a306'),
        approvedBy: systemPrincipal, approvedAt: new Date(),
      },
    })
    await db.venue.update({ where: { id: venueId }, data: { effectiveVersionId: venueVersionId } })
    console.log('✓ 演示地点（已认证 GEO+QR，坐标为示例数据）')
  } else {
    venueVersionId = existingVenue.effectiveVersionId
  }

  // 5. 演示活动：进行中的周赛 + 讲座
  const now = new Date()
  let activityId: string | null = null
  const existingActivity = await db.activity.findFirst({ where: { title: '社团周赛 · 图论与最短路（演示）' } })
  if (!existingActivity) {
    activityId = randomUUID()
    const start = new Date(now.getTime() + 10 * 60_000) // 10 分钟后开始：IN 窗口 [start-15, start+15] 当前开放
    const end = new Date(now.getTime() + 190 * 60_000)
    await db.activity.create({
      data: {
        id: activityId,
        type: 'weekly_contest',
        sourceType: 'custom',
        title: '社团周赛 · 图论与最短路（演示）',
        announcement: '本周周赛覆盖图论基础与最短路算法。请提前 15 分钟到场签到，赛后再签退。比赛需至少一次有效提交方可认定有效参赛。',
        startAt: start, endAt: end,
        registerStartAt: new Date(now.getTime() - 48 * 3600_000),
        registerDeadline: new Date(now.getTime() - 2 * 3600_000),
        cancelDeadline: new Date(now.getTime() - 6 * 3600_000),
        capacity: 60, waitlistCapacity: 10,
        remoteAllowed: true, remotePolicy: '每月最多一次远程认定，须赛前申请（演示）',
        requireValidSubmission: true,
        status: 'published', publishedAt: new Date(now.getTime() - 47 * 3600_000),
        venueVersionId,
        createdBy: (await db.user.findUnique({ where: { studentNo: '202600001' } }))!.principalId,
      },
    })
    if (venueVersionId) {
      await db.activityVenueBinding.create({ data: { activityId, venueVersionId } })
    }
    await db.attendancePolicy.create({
      data: {
        id: randomUUID(), activityId, policy: 'GEO_OR_QR',
        checkinOpenAt: new Date(start.getTime() - 15 * 60_000), checkinCloseAt: new Date(start.getTime() + 15 * 60_000),
        checkoutOpenAt: new Date(end.getTime() - 10 * 60_000), checkoutCloseAt: new Date(end.getTime() + 20 * 60_000),
        maxAccuracyMeters: 45, qrRotateSeconds: 25, qrTtlSeconds: 60,
      },
    })
    // 报名：演示主已报名
    await db.activityRegistration.create({
      data: { id: randomUUID(), activityId, userId: userIds[0], status: 'enrolled', acceptedAt: new Date() },
    })
    console.log('✓ 演示活动（进行中，窗口开放）')
  }

  // 6. 演示积分（近六个月 M：8/18/12/40/32/24 → E=95.0，方案 06 §11 fixture）
  const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']
  const ms = [8, 18, 12, 40, 32, 24]
  const leadUser = await db.user.findUnique({ where: { studentNo: '202600001' } })
  if (leadUser) {
    for (let i = 0; i < months.length; i++) {
      const sourceKey = `contribution:${leadUser.id}:demo-${months[i]}`
      const exists = await db.pointsLedgerEntry.findFirst({ where: { sourceKey, status: 'approved' } })
      if (!exists && ms[i] > 0) {
        await db.pointsLedgerEntry.create({
          data: {
            id: randomUUID(), userId: leadUser.id, sourceKey,
            category: 'contest', amount: String(ms[i]), scoreMonth: months[i],
            recordedAt: new Date(`${months[i]}-20T12:00:00+08:00`), status: 'approved',
            detail: { demo: true, note: '演示月度积分（06 文档 §11 fixture）' } as never,
            idempotencyKey: sourceKey,
          },
        })
      }
    }
    console.log('✓ 演示积分流水（近六月 8/18/12/40/32/24 → E=95.0）')
  }

  // 7. 演示徽标定义
  const badgeDefs = [
    { key: 'lecture_contrib', name: '讲题贡献', description: '完成经审核的讲题贡献', icon: 'book-open', theme: 'lilac', category: 'contribution' },
    { key: 'contest_honor', name: '正式赛荣誉', description: '在正式竞赛中获奖（经结果核验）', icon: 'award', theme: 'amber', category: 'honor' },
    { key: 'training_regular', name: '训练投入', description: '持续参与协会训练活动', icon: 'target', theme: 'blue', category: 'growth' },
  ]
  for (const def of badgeDefs) {
    const exists = await db.badgeDefinition.findUnique({ where: { key: def.key } })
    if (!exists) {
      await db.badgeDefinition.create({
        data: { id: randomUUID(), ...def, grantMethod: def.key === 'training_regular' ? 'rule' : 'manual', isOfficialHonor: def.key === 'contest_honor' },
      })
    }
  }
  console.log('✓ 徽标定义 3 枚')

  // 8. Hydro 实例（登记但 disabled —— 未联调）
  const instanceCount = await db.integrationInstance.count()
  if (instanceCount === 0) {
    await db.integrationInstance.create({
      data: {
        id: randomUUID(), kind: 'hydro', instanceId: randomUUID(), displayName: '校内 Hydro OJ（未联调）',
        baseUrl: 'https://hydro.example.edu.cn', allowedDomains: ['acm-club'], adapterVersion: 'hydro-v5',
        enabled: false, status: 'registered',
        config: { note: '演示登记：启用需校方实例联调与 secret 配置' } as never,
      },
    })
    console.log('✓ Hydro connector 登记（disabled，未联调）')
  }

  console.log('Seed 完成（演示数据已明确标记；生产启动禁用 SEED_DEMO_DATA）')
  await db.$disconnect()
}

async function ensureSystemPrincipal(db: PrismaClient): Promise<string> {
  const sys = await db.principal.findFirst({ where: { kind: 'system' } })
  if (sys) return sys.id
  const id = randomUUID()
  await db.principal.create({ data: { id, kind: 'system' } })
  return id
}

void main().catch((e) => {
  console.error('Seed 失败:', e)
  process.exit(1)
})
