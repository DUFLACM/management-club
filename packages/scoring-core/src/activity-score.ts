import { Decimal } from 'decimal.js'
import type { RuleParams, ScoreOutcome } from './rule-params.js'

/**
 * 活动参与分（附录二第五节 + 活动组织办法）。
 * 必到活动：准时到场完成内容 +2；迟到/早退 >15 分钟且未超半场 +1（扣分单列）；
 * 超过半场到场或提前离场超半场 0；普通宣讲/分享/复盘参会 +1.5（小数口径 R01）。
 *
 * “超过 15 分钟”严格为 >15；“超过一半”严格为 >D/2。
 * 同场同时迟到和早退 / 15 分钟与半场阈值交叉（活动 <30 分钟）等情形属 R03 未决：
 * 未配置时返回 pending 转人工复核，不擅自叠加两次扣分。
 */

export interface AttendanceFacts {
  /** 活动时长 D = E - S（分钟） */
  durationMinutes: number
  checkinOffsetMinutes?: number | null // IN - S，>0 迟到
  checkoutOffsetMinutes?: number | null // E - OUT，>0 早退；null = 缺签退
  required: boolean // 必到活动
  normalSession: boolean // 宣讲/分享/复盘普通参会
  leaveApproved: boolean
  remoteApproved: boolean
  incidentVerified?: boolean // 经核实的故障例外
}

export interface ActivityScoreOutcome extends ScoreOutcome {
  /** 纪律扣分候选（与参与分分别留痕，不互相抵消吞并） */
  penaltyDraft?: { amount: Decimal; reason: string }
}

export function classifyAttendance(facts: AttendanceFacts, params: RuleParams): ActivityScoreOutcome {
  const decisions: ScoreOutcome['decisions'] = []
  const push = (s: string, n: string) => decisions.push({ step: s, note: n })
  const D = facts.durationMinutes

  if (facts.leaveApproved) {
    push('leave', '请假已批准：不作无故缺席处理，未参与部分不计参与分')
    return { status: 'ok', value: new Decimal(0), decisions }
  }
  if (facts.remoteApproved) {
    push('remote', '远程已批准：显示“远程已批准”，不生成线下到场证据，参与分依活动公告')
    return { status: 'ok', value: new Decimal(0), decisions }
  }

  const late = facts.checkinOffsetMinutes != null ? Math.max(0, facts.checkinOffsetMinutes) : null
  const early = facts.checkoutOffsetMinutes != null ? Math.max(0, facts.checkoutOffsetMinutes) : null

  // 缺签退：不默认满勤、不填虚假时间，转人工复核
  if (facts.checkinOffsetMinutes != null && facts.checkoutOffsetMinutes == null) {
    push('missing-out', '有 IN 无 OUT：不默认满勤，转待复核')
    return { status: 'pending', pendingReason: '缺少签退记录，待人工复核', decisions }
  }
  // 仅 OUT 无 IN 同样复核
  if (facts.checkinOffsetMinutes == null && facts.checkoutOffsetMinutes != null) {
    return { status: 'pending', pendingReason: '仅有签退无签到记录，待人工复核', decisions }
  }
  // 无任何到场记录：必到 → 无故缺席候选（故障例外除外）；非必到 → 0 分
  if (late == null && early == null) {
    if (facts.incidentVerified) {
      push('incident', '故障例外已核实：按一次性补充认定流程处理')
      return { status: 'pending', pendingReason: '故障例外，按主席团会同指导教师一次性补充认定', decisions }
    }
    if (facts.required) {
      return {
        status: 'ok',
        value: new Decimal(0),
        penaltyDraft: { amount: new Decimal(params.attendancePenalties.unexcusedAbsence), reason: '无故缺席必到活动' },
        decisions,
      }
    }
    return { status: 'ok', value: new Decimal(0), decisions }
  }

  const lateOver15 = (late ?? 0) > 15
  const earlyOver15 = (early ?? 0) > 15
  const overHalfArrive = (late ?? 0) > D / 2
  const overHalfLeave = (early ?? 0) > D / 2

  if (overHalfArrive || overHalfLeave) {
    push('half', '超过半场到场或提前离场：参与分 0，扣分按相应制度单列')
    return { status: 'ok', value: new Decimal(0), decisions }
  }

  // 同时迟到且早退（R03 已拍板）：按次独立叠加，同场最多 -4；参与分 +1 仍只发一次
  if (lateOver15 && earlyOver15) {
    if (params.lateEarlyPolicy === 'pending') {
      return {
        status: 'pending',
        gap: 'R03',
        pendingReason: '同时迟到与早退的参与分档与扣分合计口径未确认（R03），转人工复核',
        decisions,
      }
    }
    const cfg = params.lateEarlyConfig
    const per = Math.abs(cfg.penaltyPerViolation)
    const cap = Math.abs(cfg.maxPenaltyPerSession)
    const penalty = -Math.min(cap, cfg.stackViolations ? per * 2 : per)
    push('late-early-both', `同时迟到与早退超 15 分钟：参与分 +${cfg.participationPoints}（每场一次）；扣分按次叠加 ${penalty}`)
    return {
      status: 'ok',
      value: new Decimal(cfg.participationPoints),
      penaltyDraft: { amount: new Decimal(penalty), reason: '迟到与早退均超过 15 分钟（按次叠加）' },
      decisions,
    }
  }

  if (lateOver15 || earlyOver15) {
    push('late-early', '迟到或早退超过 15 分钟且未超半场：参与分 +1；-2 扣分候选单列')
    return {
      status: 'ok',
      value: new Decimal(1),
      penaltyDraft: { amount: new Decimal(params.attendancePenalties.lateOrEarlyOver15), reason: '迟到或早退超过 15 分钟' },
      decisions,
    }
  }

  if (facts.required) {
    push('ontime', '必到活动准时到场并完成内容：+2')
    return { status: 'ok', value: new Decimal(2), decisions }
  }
  if (facts.normalSession) {
    push('session', '宣讲/分享/复盘普通参会：+1.5（整数 M 汇总口径属 R01，账本保留精确值）')
    return { status: 'ok', value: new Decimal(1.5), decisions }
  }
  push('default', '普通活动按时参与：按活动公告规则')
  return { status: 'ok', value: new Decimal(0), decisions }
}

/** 工作人员 / 主持：在普通参会基础上额外 +1 / +2，同一任务取明确角色防重复 */
export function staffBonus(role: 'staff' | 'host'): Decimal {
  return new Decimal(role === 'host' ? 2 : 1)
}
