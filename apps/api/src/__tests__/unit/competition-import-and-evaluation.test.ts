import { describe, expect, it, vi } from 'vitest'
import type { SessionActor } from '../../modules/auth/session.service.js'
import {
  CompetitionImportService,
  resolveOfficialAwardPoints,
} from '../../modules/scoring/competition-import.service.js'
import { EvaluationService } from '../../modules/evaluation/evaluation.service.js'
import { CompetitionEventService } from '../../modules/competitions/competition-event.service.js'

const ACTOR: SessionActor = {
  sessionId: 'sess-1',
  principalId: '11111111-1111-4111-8111-111111111111',
  principalKind: 'system',
  authzVersion: 1,
  roles: ['presidium', 'system_admin'],
}

const U1 = '22222222-2222-4222-8222-222222222201'
const U2 = '22222222-2222-4222-8222-222222222202'
const U3 = '22222222-2222-4222-8222-222222222203'

describe('resolveOfficialAwardPoints 正式赛档位自动计分', () => {
  it('省级赛事 / ICPC 区域赛 / 蓝桥杯 / 天梯赛 / 百度之星 / 打星', () => {
    expect(resolveOfficialAwardPoints('provincial', '金奖')?.points).toBe('95')
    expect(resolveOfficialAwardPoints('provincial', '参赛')?.points).toBe('20')
    expect(resolveOfficialAwardPoints('icpc_regional', '铜奖')?.points).toBe('120')
    expect(resolveOfficialAwardPoints('lanqiao', 'A组国二')?.points).toBe('95')
    expect(resolveOfficialAwardPoints('lanqiao', '省一')?.points).toBe('35')
    expect(resolveOfficialAwardPoints('ladder', '国二 个人二等')?.points).toBe('70')
    expect(resolveOfficialAwardPoints('baidu_star', '初赛银 决赛铜')?.points).toBe('170')
    expect(resolveOfficialAwardPoints('provincial', '打星')?.points).toBe('0')
  })
})

describe('CompetitionImportService 正式赛名单与成绩导入', () => {
  const sampleUsers = [
    { id: U1, studentNo: '202400001', verifiedRealName: '独名同学', grade: 2024, accountStatus: 'active', profile: { displayName: 'Solo' }, membershipTerms: [{ membershipStatus: 'formal' }] },
    { id: U2, studentNo: '202400002', verifiedRealName: '张伟', grade: 2024, accountStatus: 'active', profile: { displayName: '大张伟' }, membershipTerms: [{ membershipStatus: 'formal' }] },
    { id: U3, studentNo: '202500003', verifiedRealName: '张伟', grade: 2025, accountStatus: 'active', profile: { displayName: '小张伟' }, membershipTerms: [{ membershipStatus: 'provisional' }] },
  ]

  it('预览支持学号或姓名导入，姓名重复返回全部候选供手动选择，选定后可正常通过并按档位算分', async () => {
    const db = {
      user: { findMany: vi.fn().mockResolvedValue(sampleUsers) },
      competitionEvent: { findMany: vi.fn().mockResolvedValue([]) },
    }
    const svc = new CompetitionImportService(db as never, { log: vi.fn() } as never, {} as never)

    const preview = await svc.preview({
      event: {
        title: '2026 辽宁省程序设计竞赛',
        competitionDate: '2026-05-16',
        category: 'A',
        contestTier: 'provincial',
        ledgerCategory: 'award',
      },
      rows: [
        { row: 2, studentNo: '202400001', awardText: '金奖' },
        { row: 3, name: '张伟', awardText: '银奖' },
        { row: 4, name: '张伟', selectedUserId: U3, awardText: '铜奖', points: '60' },
        { row: 5, name: '不存在', awardText: '参赛' },
      ],
    })

    expect(preview.summary).toMatchObject({ total: 4, ready: 2, duplicateNameCount: 1, errorCount: 2 })
    expect(preview.rows[0]).toMatchObject({ userId: U1, points: '95', pointsSource: 'tier_rule', matchSource: 'studentNo' })
    expect(preview.rows[1]).toMatchObject({ needsSelection: true })
    expect(preview.rows[1]?.candidates?.map((c) => c.studentNo)).toEqual(['202400002', '202500003'])
    expect(preview.rows[2]).toMatchObject({ userId: U3, studentNo: '202500003', points: '60', pointsSource: 'sheet', matchSource: 'selected' })
    expect(preview.rows[3]?.error).toContain('未找到姓名')
  })

  it('提交时自动创建已归档正式赛、登记报名名单并归档积分，同时向关联成员发通知', async () => {
    const db = {
      $transaction: vi.fn(async (work) => work(db)),
      $executeRaw: vi.fn().mockResolvedValue(1),
      user: { findMany: vi.fn().mockResolvedValue(sampleUsers) },
      competitionEvent: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({}),
      },
      competitionRegistration: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockImplementation(async ({ create }) => ({ id: create.id })),
      },
    }
    const audit = { log: vi.fn().mockResolvedValue(undefined) }
    const scoring = {
      postCompetitionResultPoints: vi.fn(async (_tx, _actor, input) => ({ postedAmount: input.amount })),
      notifyPostedPoints: vi.fn().mockResolvedValue(undefined),
    }
    const notifications = { notify: vi.fn().mockResolvedValue(undefined) }
    const svc = new CompetitionImportService(db as never, audit as never, scoring as never, notifications as never)

    const result = await svc.commit(ACTOR, {
      event: {
        title: '2026 蓝桥杯省赛',
        competitionDate: '2026-04-18',
        category: 'B',
        contestTier: 'lanqiao',
        ledgerCategory: 'award',
      },
      rows: [
        { row: 2, name: '独名同学', awardText: '省一', rankText: '10' },
        { row: 3, name: '张伟', selectedUserId: U2, awardText: '参赛', points: '0' },
      ],
    })

    expect(result.event).toMatchObject({ title: '2026 蓝桥杯省赛', created: true, status: 'archived', scoreMonth: '2026-04' })
    expect(result).toMatchObject({ registeredCount: 2, posted: 1, rosterOnly: 1, duplicate: 0, failed: 0 })
    expect(db.competitionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'archived', title: '2026 蓝桥杯省赛' }) }),
    )
    expect(db.competitionRegistration.upsert).toHaveBeenCalledTimes(2)
    expect(scoring.postCompetitionResultPoints).toHaveBeenCalledTimes(1)
    expect(scoring.postCompetitionResultPoints).toHaveBeenCalledWith(
      db, ACTOR,
      expect.objectContaining({
        userId: U1,
        category: 'award',
        amount: '35.00',
        scoreMonth: '2026-04',
      }),
    )
    expect(scoring.notifyPostedPoints).toHaveBeenCalledTimes(1)
    expect(notifications.notify).toHaveBeenCalledTimes(2)
  })

  it('团队赛按队名编组并逐人归档积分；未解决重名行被拒绝提交', async () => {
    const db = {
      $transaction: vi.fn(async (work) => work(db)),
      $executeRaw: vi.fn().mockResolvedValue(1),
      user: { findMany: vi.fn().mockResolvedValue(sampleUsers) },
      competitionEvent: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({}),
      },
      teamCompetitionEntry: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockImplementation(async ({ create }) => ({ id: create.id })),
      },
      team: { create: vi.fn().mockResolvedValue({}) },
      teamMember: { createMany: vi.fn().mockResolvedValue({ count: 2 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }
    const audit = { log: vi.fn().mockResolvedValue(undefined) }
    const scoring = {
      postCompetitionResultPoints: vi.fn(async (_tx, _actor, input) => ({ postedAmount: input.amount })),
      notifyPostedPoints: vi.fn().mockResolvedValue(undefined),
    }
    const svc = new CompetitionImportService(db as never, audit as never, scoring as never)

    await expect(
      svc.commit(ACTOR, {
        event: { title: '2026 ICPC 沈阳站', competitionDate: '2026-11-15', category: 'A', teamSize: 3, ledgerCategory: 'award' },
        rows: [{ row: 2, name: '张伟', teamName: '大外一队', points: '120' }],
      }),
    ).rejects.toThrow('姓名重复未手动选择')

    const res = await svc.commit(ACTOR, {
      event: { title: '2026 ICPC 沈阳站', competitionDate: '2026-11-15', category: 'A', teamSize: 3, ledgerCategory: 'award' },
      rows: [
        { row: 2, studentNo: '202400001', teamName: '大外一队', awardText: '铜奖', points: '120' },
        { row: 3, name: '张伟', selectedUserId: U2, teamName: '大外一队', awardText: '铜奖', points: '120' },
      ],
    })
    expect(res).toMatchObject({ registeredCount: 2, teamsCreated: 1, posted: 2, failed: 0 })
    expect(db.team.create).toHaveBeenCalledTimes(1)
    expect(db.teamMember.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ userId: U1, role: 'captain' }), expect.objectContaining({ userId: U2, role: 'member' })],
      skipDuplicates: true,
    })
    expect(db.teamCompetitionEntry.upsert).toHaveBeenCalledTimes(1)
    expect(scoring.postCompetitionResultPoints).toHaveBeenCalledTimes(2)

    const initial = db.teamCompetitionEntry.upsert.mock.calls[0]![0].create
    db.competitionEvent.findMany.mockResolvedValue([{ id: initial.eventId, teamSize: 3 }])
    db.teamCompetitionEntry.findFirst.mockResolvedValue({ id: initial.id, teamId: initial.teamId, resultDetail: initial.resultDetail })
    scoring.postCompetitionResultPoints.mockResolvedValueOnce({ postedAmount: '35.00' })
    const partial = await svc.commit(ACTOR, {
      event: { title: '2026 ICPC 沈阳站', competitionDate: '2026-11-15', category: 'A', teamSize: 3, ledgerCategory: 'award' },
      rows: [{ row: 2, selectedUserId: U2, teamName: '大外一队', awardText: '银奖', points: '155' }],
    })
    expect(partial).toMatchObject({ posted: 1, teamsCreated: 0, failed: 0 })
    expect(scoring.notifyPostedPoints).toHaveBeenLastCalledWith(expect.objectContaining({ userId: U2, amount: '35.00' }))
    expect(db.teamCompetitionEntry.upsert.mock.calls[1]![0].update).toMatchObject({
      resultScore: '155.00',
      resultDetail: { memberResults: [
        { userId: U1, awardText: '铜奖', points: '120' },
        { userId: U2, awardText: '银奖', points: '155' },
      ] },
    })
  })
})

describe('EvaluationService 实时无时间限制、不锁定与含积分导出', () => {
  const futureSemester = {
    id: '33333333-3333-4333-8333-333333333333',
    code: '2026F',
    name: '2026 秋季学期',
    startsOn: new Date('2026-09-01T00:00:00+08:00'),
    endsOn: new Date('2027-01-31T23:59:59+08:00'),
  }

  it('未结束学期不限时间可直接生成，实时聚合积分账本，且导出表包含积分列与独立积分汇总表', async () => {
    const db = {
      semester: {
        findMany: vi.fn().mockResolvedValue([futureSemester]),
        findUnique: vi.fn().mockResolvedValue(futureSemester),
        findFirst: vi.fn().mockResolvedValue(futureSemester),
      },
      membershipTerm: {
        findMany: vi.fn().mockResolvedValue([
          {
            userId: U1,
            membershipStatus: 'formal',
            user: { id: U1, studentNo: '202400001', verifiedRealName: '张三', profile: { displayName: '小张' }, principalId: 'p-1', accountStatus: 'active', createdAt: new Date('2026-09-01T00:00:00Z') },
          },
          {
            userId: U2,
            membershipStatus: 'formal',
            user: { id: U2, studentNo: '202400002', verifiedRealName: '李四', principalId: 'p-2', accountStatus: 'active', createdAt: new Date('2026-09-01T00:00:00Z') },
          },
          {
            userId: U3,
            membershipStatus: 'observing',
            user: { id: U3, studentNo: '202400003', verifiedRealName: '王五', principalId: 'p-3', accountStatus: 'active', createdAt: new Date('2026-09-01T00:00:00Z') },
          },
        ]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ accountStatus: 'active', membershipTerms: [{ membershipStatus: 'formal' }] }),
      },
      monthlyScore: { findMany: vi.fn().mockResolvedValue([]) },
      pointsLedgerEntry: {
        groupBy: vi.fn().mockImplementation(async ({ by }: { by: string[] }) => {
          if (by.includes('scoreMonth')) {
            return [
              { userId: U1, scoreMonth: '2026-10', _sum: { amount: 30 } },
              { userId: U1, scoreMonth: '2026-11', _sum: { amount: 20 } },
              { userId: U2, scoreMonth: '2026-10', _sum: { amount: 10 } },
            ]
          }
          return [
            { userId: U1, category: 'contest', _sum: { amount: 30 } },
            { userId: U1, category: 'activity', _sum: { amount: 20 } },
            { userId: U2, category: 'activity', _sum: { amount: 10 } },
          ]
        }),
      },
      restriction: { findMany: vi.fn().mockResolvedValue([]) },
      roleGrant: { findMany: vi.fn().mockResolvedValue([]) },
      ruleVersion: { findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn().mockImplementation(async (fn: unknown) => {
        if (typeof fn === 'function') {
          return fn({
            evaluationBatch: { create: vi.fn().mockResolvedValue({}) },
            evaluationRow: { createMany: vi.fn().mockResolvedValue({}) },
          })
        }
        return Promise.all(fn as Promise<unknown>[])
      }),
    }
    const audit = { log: vi.fn().mockResolvedValue(undefined) }
    const svc = new EvaluationService(db as never, audit as never)

    const semRes = await svc.semesters()
    expect(semRes.testMode).toBe(false)
    expect(semRes.semesters[0]?.canGenerate).toBe(true)

    const gen = await svc.generate(ACTOR, futureSemester.id)
    expect(gen).toMatchObject({ isTest: false, rowCount: 3 })

    const liveEval = await svc.exportRealtimeCsv(futureSemester.id)
    expect(liveEval.filename).not.toContain('测试数据')
    expect(liveEval.csv).toContain('学号,姓名,口径,排名,定档,当前有效积分,学期总积分,月均积分')
    expect(liveEval.csv).toContain('202400001,张三')

    const livePoints = await svc.exportRealtimePointsCsv(futureSemester.id)
    expect(livePoints.csv).toContain('学号,姓名,在册身份,综评状态,当前有效积分,学期总积分,月均积分,活动积分,竞赛积分,服务贡献积分')
    expect(livePoints.csv).toContain('202400001,张三')
    expect(livePoints.csv).toContain('202400002,李四')
    expect(livePoints.csv).toContain('202400003,王五')

    const board = await svc.memberLeaderboard(U1, futureSemester.id)
    const exported = liveEval.csv.trim().split('\n').slice(1).map((line) => line.split(','))
    expect(board.rows).toEqual(exported.map((cells) => ({
      rank: Number(cells[3]),
      displayName: cells[1] === '张三' ? '小张（张三）' : '李四',
      hScore: Number(cells[12]),
      tier: cells[4],
      suggestedScore: Number(cells[13]),
      needsManual: false,
      isMe: cells[0] === '202400001',
    })))
    expect(board.rows).toHaveLength(2)
    expect(db.semester.findFirst).toHaveBeenCalledWith({ where: { id: futureSemester.id, startsOn: { lte: expect.any(Date) } } })

    const terms: Array<{ user: { verifiedRealName: string } }> = await db.membershipTerm.findMany()
    const publicRows = (await svc.publicLeaderboard(futureSemester.id)).rows
    expect(publicRows).toEqual(board.rows.map(({ isMe, ...row }, i) => ({
      ...row, displayName: ['张同学', '李同学'][i],
    })))
    const nicknames = [{ visibility: 'public_opt_in', displayName: '稻米' }, { visibility: 'self_only', displayName: '自用昵称' }]
    db.membershipTerm.findMany.mockResolvedValueOnce(terms.map((t, i) => ({ ...t, user: { ...t.user, profile: nicknames[i] } })))
    expect((await svc.publicLeaderboard(futureSemester.id)).rows.map((r) => r.displayName)).toEqual(['稻米', '李同学'])
    const identifyingNames = [{ visibility: 'public_opt_in', displayName: '稻米（张三）' }, { visibility: 'public_opt_in', displayName: '202400002' }]
    db.membershipTerm.findMany.mockResolvedValueOnce(terms.map((t, i) => ({ ...t, user: { ...t.user, profile: identifyingNames[i] } })))
    expect((await svc.publicLeaderboard(futureSemester.id)).rows).toEqual(publicRows)

    // 账本全空时所有指标完全相同，两次查询的原始顺序也可能不同。
    db.pointsLedgerEntry.groupBy.mockResolvedValue([])
    db.membershipTerm.findMany.mockResolvedValueOnce(terms.toReversed())
    const tiedBoard = await svc.memberLeaderboard(U1, futureSemester.id)
    const tiedExport = await svc.exportRealtimeCsv(futureSemester.id)
    expect(tiedBoard.rows.map((row) => row.isMe)).toEqual([true, false])
    expect(tiedBoard.rows.map((row) => row.needsManual)).toEqual([true, true])
    expect(tiedExport.csv.trim().split('\n').slice(1).map((line) => line.split(',')[0]))
      .toEqual(['202400001', '202400002'])
  })

  it('成员可选已开始的学期，默认进行中的学期，间歇期回退至最近学期', async () => {
    const now = Date.now()
    const ended = { ...futureSemester, id: 'ended', endsOn: new Date(now - 86_400_000) }
    const active = { ...futureSemester, id: 'active', endsOn: new Date(now + 86_400_000) }
    const db = {
      semester: {
        findMany: vi.fn().mockResolvedValueOnce([ended, active]).mockResolvedValueOnce([ended]).mockResolvedValueOnce([]),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      user: { findUnique: vi.fn().mockResolvedValue({ accountStatus: 'active', membershipTerms: [{ membershipStatus: 'observing' }] }) },
    }
    const svc = new EvaluationService(db as never, {} as never)
    expect((await svc.memberSemesters(U1)).defaultSemesterId).toBe(active.id)
    expect(db.semester.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { startsOn: { lte: expect.any(Date) } },
      orderBy: [{ startsOn: 'desc' }, { code: 'asc' }],
    }))
    expect((await svc.memberSemesters(U1)).defaultSemesterId).toBe(ended.id)
    expect(await svc.memberSemesters(U1)).toEqual({ semesters: [], defaultSemesterId: null })
    await expect(svc.memberLeaderboard(U1, futureSemester.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(svc.publicLeaderboard(futureSemester.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('非在册成员不能读取学期列表与综评排行榜', async () => {
    const db = {
      user: { findUnique: vi.fn().mockResolvedValue({ accountStatus: 'active', membershipTerms: [{ membershipStatus: 'withdrawn' }] }) },
    }
    const svc = new EvaluationService(db as never, {} as never)
    await expect(svc.memberSemesters(U1)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(svc.memberLeaderboard(U1, futureSemester.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('历史已发布状态的批次不再锁定，仍可修改与重算', async () => {
    const batchId = '44444444-4444-4444-8444-444444444444'
    const rowId = '55555555-5555-4555-8555-555555555555'
    const db = {
      evaluationBatch: {
        findUnique: vi.fn().mockResolvedValue({
          id: batchId,
          status: 'published',
          weights: { points: 0.7, contest: 0.2, service: 0.1 },
          tierRatios: { a: 0.1, b: 0.2 },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      evaluationRow: {
        findUnique: vi.fn().mockResolvedValue({
          id: rowId,
          batchId,
          studentNo: '202400001',
          realName: '张三',
          pointsStd: '80',
          overrideScore: null,
          suggestedScore: '1.000',
          excluded: false,
          cadre: false,
          batch: { id: batchId, status: 'published' },
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: rowId,
            studentNo: '202400001',
            excluded: false,
            cadre: false,
            pointsStd: '80',
            contestStd: '90',
            serviceStd: '50',
            disciplinePenalty: '0',
            overridePointsStd: '95',
            overrideContestStd: null,
            overrideServiceStd: null,
            overridePenalty: null,
            tiebreak: null,
          },
        ]),
        update: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn().mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    }
    const audit = { log: vi.fn().mockResolvedValue(undefined) }
    const svc = new EvaluationService(db as never, audit as never)

    const res = await svc.overrideRow(ACTOR, batchId, rowId, {
      pointsStd: 95,
      reason: '实时复核微调分数',
    })
    expect(res).toEqual({ updated: true })
    expect(db.evaluationRow.update).toHaveBeenCalled()
  })
})

describe('CompetitionEventService.deleteEvent 删除正式赛事', () => {
  it('删除正式赛事并级联清理报名/资格/材料；开启 reversePoints 时同步冲正已入账流水', async () => {
    const eventId = '66666666-6666-4666-8666-666666666666'
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      competitionRegistrationMaterial: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      competitionRegistration: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      teamCompetitionMaterial: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      teamCompetitionEntry: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      competitionShortlistRow: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      competitionEvent: { delete: vi.fn().mockResolvedValue({}) },
    }
    const db = {
      competitionEvent: {
        findUnique: vi.fn().mockResolvedValue({
          id: eventId,
          title: '2026 蓝桥杯省赛',
          status: 'archived',
          _count: { registrations: 2, teamEntries: 0, shortlist: 1 },
          registrations: [{ materials: [] }],
          teamEntries: [],
        }),
      },
      pointsLedgerEntry: {
        findMany: vi.fn().mockResolvedValue([{ id: 'le-1' }, { id: 'le-2' }]),
      },
      $transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    }
    const audit = { log: vi.fn().mockResolvedValue(undefined) }
    const scoring = { reverseEntry: vi.fn().mockResolvedValue({ reversalId: 'rev-1', replacementId: null }) }
    const svc = new CompetitionEventService(db as never, audit as never, scoring as never, {} as never)

    const result = await svc.deleteEvent(ACTOR, eventId, { reversePoints: true })
    expect(result).toEqual({ deleted: true, reversedPointsCount: 2 })
    expect(scoring.reverseEntry).toHaveBeenCalledTimes(2)
    expect(tx.competitionRegistrationMaterial.deleteMany).toHaveBeenCalledTimes(1)
    expect(tx.competitionRegistration.deleteMany).toHaveBeenCalledTimes(1)
    expect(tx.teamCompetitionMaterial.deleteMany).toHaveBeenCalledTimes(1)
    expect(tx.teamCompetitionEntry.deleteMany).toHaveBeenCalledTimes(1)
    expect(tx.competitionShortlistRow.deleteMany).toHaveBeenCalledTimes(1)
    expect(tx.competitionEvent.delete).toHaveBeenCalledWith({ where: { id: eventId } })
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'competition_event.delete', resourceId: eventId }),
    )
  })
})
