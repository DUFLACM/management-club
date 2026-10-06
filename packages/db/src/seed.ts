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

  // 1. 规则版本 v1（R01–R13 已拍板，见 scoring-core RESOLVED_RULE_DECISIONS）
  const ruleCount = await db.ruleVersion.count()
  if (ruleCount === 0) {
    const { defaultRuleParams } = await import('@acm/scoring-core')
    await db.ruleVersion.create({
      data: {
        id: randomUUID(),
        version: 1,
        source: 'seed：docs/ 九份 PDF（核对 2026-10-05）；R01–R13 口径已拍板（2026-10-06）',
        params: defaultRuleParams() as never,
        status: 'published',
        effectiveFrom: new Date('2026-01-01'),
      },
    })
    console.log('✓ 规则版本 v1（R01–R13 已拍板）')
  }

  // 2. 学期
  let semester = await db.semester.findFirst({ where: { code: '2026F' } })
  if (!semester) {
    semester = await db.semester.create({
      data: { id: randomUUID(), code: '2026F', name: '2026 秋季学期（演示）', startsOn: new Date('2026-09-01'), endsOn: new Date('2027-01-15') },
    })
    console.log('✓ 学期 2026F')
  }

  // 2.5 指定比赛认定目录（附录一基础清单；幂等：无数据时写入）
  const designatedCount = await db.designatedContest.count()
  if (designatedCount === 0) {
    const catalog: Array<{ category: 'A' | 'B' | 'C'; groupName: string; name: string; platform?: string; lambdaKey?: 'A' | 'B' | 'C'; note?: string; evidenceRef: string }> = [
      // —— A 类：学校配额统一管理 ——
      { category: 'A', groupName: 'ICPC 体系', name: 'ICPC 网络预选赛', note: '以大连外国语大学名义报名、占用学校配额', evidenceRef: '附录一 第二条（一）1' },
      { category: 'A', groupName: 'ICPC 体系', name: 'ICPC 亚洲区域赛 / 分站赛', evidenceRef: '附录一 第二条（一）2' },
      { category: 'A', groupName: 'ICPC 体系', name: 'ICPC 邀请赛及同类配额赛事', evidenceRef: '附录一 第二条（一）3' },
      { category: 'A', groupName: 'CCPC 体系', name: 'CCPC 网络赛', evidenceRef: '附录一 第二条（二）1' },
      { category: 'A', groupName: 'CCPC 体系', name: 'CCPC 分站赛 / 邀请赛', evidenceRef: '附录一 第二条（二）2-3' },
      { category: 'A', groupName: 'CCPC 体系', name: 'CCPC 总决赛', evidenceRef: '附录一 第二条（二）4' },
      { category: 'A', groupName: '天梯赛体系', name: '团体程序设计天梯赛（正式赛）', evidenceRef: '附录一 第二条（三）1' },
      { category: 'A', groupName: '天梯赛体系', name: '天梯赛校内/专题/集训队选拔赛', evidenceRef: '附录一 第二条（三）2' },
      { category: 'A', groupName: '省级与区域赛事', name: '辽宁省大学生程序设计竞赛（及同级别省赛）', evidenceRef: '附录一 第二条（四）1' },
      { category: 'A', groupName: '省级与区域赛事', name: '东北地区及其他区域性大学生程序设计竞赛', evidenceRef: '附录一 第二条（四）2' },
      { category: 'A', groupName: '校内选拔与承接', name: '大连外国语大学程序设计竞赛 / 软件学院程序设计竞赛', evidenceRef: '附录一 第二条（五）1' },
      { category: 'A', groupName: '校内选拔与承接', name: '新生程序设计竞赛 / 实验班选拔与结业考试', evidenceRef: '附录一 第二条（五）2' },
      { category: 'A', groupName: '校内选拔与承接', name: '软件学院「智汇杯」计算机编程挑战赛', evidenceRef: '附录一 第二条（五）3' },
      { category: 'A', groupName: '校内选拔与承接', name: 'ICPC / CCPC / 省赛 / 天梯赛校内选拔赛', evidenceRef: '附录一 第二条（五）4-6' },
      // —— B 类：纳入积分认定、原则上不占学校配额 ——
      { category: 'B', groupName: '平台型公开训练赛事', name: '牛客寒假 / 多校训练营', platform: 'nowcoder', lambdaKey: 'A', note: '须赛前公告为指定场次，并由协会统一组织线下集中参加', evidenceRef: '附录一 第三条（一）1' },
      { category: 'B', groupName: '平台型公开训练赛事', name: '「钉耙编程」中国大学生算法设计联赛（杭电多校）', platform: 'nowcoder', lambdaKey: 'A', note: '须赛前公告指定 + 统一组织核验', evidenceRef: '附录一 第三条（一）1' },
      { category: 'B', groupName: '平台型公开训练赛事', name: 'Codeforces Div.1 / Educational Round', platform: 'codeforces', lambdaKey: 'A', note: '须赛前公告指定 + 统一组织核验', evidenceRef: '附录一 第三条（一）2' },
      { category: 'B', groupName: '平台型公开训练赛事', name: 'Codeforces Div.2', platform: 'codeforces', lambdaKey: 'A', note: '须赛前公告指定 + 统一组织核验', evidenceRef: '附录一 第三条（一）2' },
      { category: 'B', groupName: '平台型公开训练赛事', name: 'Codeforces Div.3 / Div.4', platform: 'codeforces', lambdaKey: 'B', note: '须赛前公告指定 + 统一组织核验', evidenceRef: '附录一 第三条（一）2' },
      { category: 'B', groupName: '平台型公开训练赛事', name: 'AtCoder ABC', platform: 'atcoder', lambdaKey: 'B', note: '须赛前公告指定 + 统一组织核验', evidenceRef: '附录一 第三条（一）3' },
      { category: 'B', groupName: '平台型公开训练赛事', name: 'AtCoder ARC', platform: 'atcoder', lambdaKey: 'A', note: '须赛前公告指定 + 统一组织核验', evidenceRef: '附录一 第三条（一）3' },
      { category: 'B', groupName: '平台型公开训练赛事', name: 'AtCoder AGC', platform: 'atcoder', note: '附录二 λ 表未给 AGC 档位，须由赛前公告确定', evidenceRef: '附录一 第三条（一）3；04 方案 3.2' },
      { category: 'B', groupName: '平台型公开训练赛事', name: '牛客周赛 / 牛客练习赛', platform: 'nowcoder', lambdaKey: 'B', note: '须赛前公告指定 + 统一组织核验', evidenceRef: '附录一 第三条（一）4' },
      { category: 'B', groupName: '平台型公开训练赛事', name: '牛客小白月赛', platform: 'nowcoder', lambdaKey: 'C', note: '须赛前公告指定 + 统一组织核验', evidenceRef: '附录一 第三条（一）4' },
      { category: 'B', groupName: '官方认证与个人实名赛事', name: '蓝桥杯全国软件和信息技术专业人才大赛（软件赛）', note: '个人实名报名；赛后凭证书/官方公示核验计分', evidenceRef: '附录一 第三条（二）1' },
      { category: 'B', groupName: '官方认证与个人实名赛事', name: 'CCF CSP 计算机软件能力认证', note: '个人实名；赛后凭认证成绩核验', evidenceRef: '附录一 第三条（二）2' },
      { category: 'B', groupName: '官方认证与个人实名赛事', name: 'PAT 程序员能力认证', note: '个人实名；赛后凭认证成绩核验', evidenceRef: '附录一 第三条（二）3' },
      { category: 'B', groupName: '学校系统组织的算法活动', name: '校内单位组织的算法专项活动/竞赛', note: '由协会赛前公告认定方式与记分级别', evidenceRef: '附录一 第三条（三）' },
      // —— C 类：原则上不予认定 ——
      { category: 'C', groupName: '原则不认定', name: '复现赛、模拟赛、赛后补题、私人对战', note: '不计入积分', evidenceRef: '附录一 第四条 2' },
      { category: 'C', groupName: '原则不认定', name: '非指定场次或非指定地点自行参加的平台赛', note: '除经批准的远程参赛外不予认定', evidenceRef: '附录一 第四条 2-3' },
      { category: 'C', groupName: '原则不认定', name: '未列入目录且未备案、未履行申报/核验程序的赛事', evidenceRef: '附录一 第四条 1' },
      { category: 'C', groupName: '原则不认定', name: '取得统一报名权后未走公告渠道且未在截止前备案的成果', evidenceRef: '附录一 第四条 4' },
      { category: 'C', groupName: '原则不认定', name: '关联性低、无法客观核验或材料造假的成果', evidenceRef: '附录一 第四条 5-6' },
    ]
    await db.designatedContest.createMany({
      data: catalog.map((item) => ({ id: randomUUID(), ...item, effectiveFrom: new Date('2026-01-01') })),
    })
    console.log(`✓ 指定比赛认定目录（附录一）${catalog.length} 条`)
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

  // 9. 综评折算演示队列（附录三）：若只有 4 名演示用户，定档池只剩 1 人，A/B/C 三档看不出效果。
  //    这里补一批在册正式成员 + 已发布月度积分 + 差异化竞赛/服务/纪律账目，让测试批次能跑出完整分布。
  const cohort = Array.from({ length: 12 }, (_, index) => {
    const n = index + 1
    return {
      studentNo: `2026001${String(n).padStart(2, '0')}`,
      name: `综评演示${String(n).padStart(2, '0')}号（演示）`,
      // 两个月的有效积分：错开取值，使百分位、并列决胜都有可观察的差异
      monthly: { '2026-09': 10 + n * 3, '2026-10': 8 + ((n * 7) % 20) } as Record<string, number>,
      contest: (n % 4) * 15,
      service: ((n + 2) % 3) * 8,
      penalty: n === 5 ? 3 : 0,
    }
  })

  const publishMonthly = async (userId: string, monthly: Record<string, number>) => {
    for (const [scoreMonth, m] of Object.entries(monthly)) {
      const exists = await db.monthlyScore.findFirst({ where: { userId, scoreMonth } })
      if (exists) continue
      await db.monthlyScore.create({
        data: {
          id: randomUUID(), userId, scoreMonth,
          rawTotal: String(m), m, roundingPolicy: 'round_half_up', revision: 1, status: 'published',
        },
      })
    }
  }

  const postDemoEntry = async (userId: string, category: string, amount: number, scoreMonth: string, tag: string) => {
    if (amount === 0) return
    const sourceKey = `${category}:${userId}:evaluation-demo-${tag}`
    const exists = await db.pointsLedgerEntry.findFirst({ where: { sourceKey } })
    if (exists) return
    await db.pointsLedgerEntry.create({
      data: {
        id: randomUUID(), userId, sourceKey, category,
        amount: String(category === 'penalty' ? -amount : amount), scoreMonth,
        recordedAt: new Date(`${scoreMonth}-15T12:00:00+08:00`), status: 'approved',
        detail: { demo: true, note: '综评折算演示数据（附录三）' } as never,
        idempotencyKey: sourceKey,
      },
    })
  }

  for (const member of cohort) {
    let user = await db.user.findUnique({ where: { studentNo: member.studentNo } })
    if (!user) {
      const principalId = randomUUID()
      const userId = randomUUID()
      await db.principal.create({ data: { id: principalId, kind: 'student' } })
      user = await db.user.create({
        data: { id: userId, principalId, studentNo: member.studentNo, verifiedRealName: member.name, grade: 2026 },
      })
      await db.authIdentity.create({
        data: { id: randomUUID(), principalId, provider: 'cas', subject: `dev-${member.studentNo}`, verifiedCampusId: member.studentNo, verifiedRealName: member.name },
      })
      await db.userProfile.create({ data: { userId, displayName: member.name.replace('（演示）', '') } })
      await db.roleGrant.create({ data: { id: randomUUID(), principalId, role: 'member', grantedBy: principalId } })
    }
    const hasTerm = await db.membershipTerm.findFirst({ where: { userId: user.id, semesterId: semester.id } })
    if (!hasTerm) {
      await db.membershipTerm.create({
        data: { id: randomUUID(), userId: user.id, semesterId: semester.id, membershipStatus: 'formal', basis: '综评演示数据', semesterRegisteredAt: new Date('2026-09-05T12:00:00+08:00') },
      })
    }
    await publishMonthly(user.id, member.monthly)
    await postDemoEntry(user.id, 'contest', member.contest, '2026-10', 'contest')
    await postDemoEntry(user.id, 'contribution', member.service, '2026-09', 'service')
    await postDemoEntry(user.id, 'penalty', member.penalty, '2026-10', 'penalty')
  }
  // 原有两名正式成员也补发月度积分，否则其积分标准分为 0
  for (const [studentNo, monthly] of [
    ['202600001', { '2026-09': 32, '2026-10': 24 }],
    ['202600002', { '2026-09': 21, '2026-10': 17 }],
  ] as Array<[string, Record<string, number>]>) {
    const u = await db.user.findUnique({ where: { studentNo } })
    if (u) await publishMonthly(u.id, monthly)
  }
  console.log(`✓ 综评折算演示队列（${cohort.length} 名在册成员 + 已发布月度积分）`)

  // 10. 已结束的演示讲座：讲题满意度只在「活动已结束 + 本人到场 + 有已批准讲题」时开放，
  //     第 5 节的演示周赛仍在进行中，没有这场已结束的讲座就无法在本地看到评分区块。
  const lectureTitle = '专题讲座 · 树上问题选讲（演示·已结束）'
  let lectureActivityId = (await db.activity.findFirst({ where: { title: lectureTitle } }))?.id ?? null
  if (!lectureActivityId && venueVersionId) {
    const lecturer = await db.user.findUnique({ where: { studentNo: '202600002' } })
    const creator = await db.user.findUnique({ where: { studentNo: '202600001' } })
    if (lecturer && creator) {
      lectureActivityId = randomUUID()
      const lectureStart = new Date(now.getTime() - 3 * 24 * 3600_000)
      const lectureEnd = new Date(lectureStart.getTime() + 2 * 3600_000)
      await db.activity.create({
        data: {
          id: lectureActivityId,
          type: 'lecture', sourceType: 'custom', title: lectureTitle,
          announcement: '树的直径、重心与树上倍增，含三道例题讲解。到场成员可在活动结束后对讲题人匿名打分。',
          startAt: lectureStart, endAt: lectureEnd,
          registerStartAt: new Date(lectureStart.getTime() - 5 * 24 * 3600_000),
          registerDeadline: new Date(lectureStart.getTime() - 2 * 3600_000),
          capacity: 40, waitlistCapacity: 5,
          status: 'published', publishedAt: new Date(lectureStart.getTime() - 5 * 24 * 3600_000),
          venueVersionId,
          createdBy: creator.principalId,
        },
      })
      await db.activityVenueBinding.create({ data: { activityId: lectureActivityId, venueVersionId } })
      await db.attendancePolicy.create({
        data: {
          id: randomUUID(), activityId: lectureActivityId, policy: 'GEO_OR_QR',
          checkinOpenAt: new Date(lectureStart.getTime() - 15 * 60_000), checkinCloseAt: new Date(lectureStart.getTime() + 15 * 60_000),
          checkoutOpenAt: new Date(lectureEnd.getTime() - 10 * 60_000), checkoutCloseAt: new Date(lectureEnd.getTime() + 20 * 60_000),
          maxAccuracyMeters: 45, qrRotateSeconds: 25, qrTtlSeconds: 60,
        },
      })
      const lectureRequestId = randomUUID()
      await db.lectureRequest.create({
        data: {
          id: lectureRequestId, activityId: lectureActivityId, userId: lecturer.id,
          topic: '树的直径与重心', status: 'approved',
          reviewedBy: creator.principalId, reviewedAt: new Date(lectureStart.getTime() - 24 * 3600_000),
        },
      })
      // 到场打点：讲题人 + 三名听众（听众才有评分资格，讲题人不自评）
      const attendees = [lecturer.id, ...userIds.filter((id) => id !== lecturer.id)]
      for (const userId of attendees) {
        await db.activityRegistration.create({
          data: { id: randomUUID(), activityId: lectureActivityId, userId, status: 'enrolled', acceptedAt: new Date(lectureStart.getTime() - 24 * 3600_000) },
        })
        for (const [checkpoint, at] of [['IN', lectureStart], ['OUT', lectureEnd]] as Array<['IN' | 'OUT', Date]>) {
          await db.attendanceCheckpoint.create({
            data: { id: randomUUID(), activityId: lectureActivityId, userId, checkpoint, method: 'QR', acceptedAt: at, venueVersionId },
          })
        }
      }
      // 两条演示评分：此时样本不足 3 人，讲题人只看到均值，评语对其仍不展示
      const raters = userIds.filter((id) => id !== lecturer.id).slice(0, 2)
      const demoRatings = [
        { score: 5, comment: '例题选得好，推导讲得很清楚（演示数据）' },
        { score: 4, comment: '节奏稍快，希望多留一点练习时间（演示数据）' },
      ]
      for (const [index, raterUserId] of raters.entries()) {
        const rating = demoRatings[index]
        if (!rating) continue
        await db.lectureRating.create({
          data: { id: randomUUID(), lectureRequestId, raterUserId, score: rating.score, comment: rating.comment },
        })
      }
      console.log('✓ 演示讲座（已结束，含已批准讲题与 2 条匿名满意度评分）')
    }
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
