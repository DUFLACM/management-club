import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common'
import type { z } from 'zod'
import { SessionGuard, PermissionsGuard, ActionGuard, RequireAction, CurrentActor, ok } from '../../common/guards.js'
import { ScoringError } from './scoring.service.js'
import { HistoryImportService, historyExcelSchema, historyPreviewSchema } from './history-import.service.js'
import type { SessionActor } from '../auth/session.service.js'

function parseOrThrow<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ScoringError(issue.path.length ? `${issue.path.join('.')}：${issue.message}` : issue.message, 'INVALID_INPUT')
  }
  return parsed.data
}

/** 历史积分导入：Excel 模板（普通积分行 + 平台比赛行，比赛行按表格中的平台 / 场次 / 账号抓榜单） */
@Controller('/api/v1/admin/history-import')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class HistoryImportController {
  constructor(@Inject(HistoryImportService) private readonly history: HistoryImportService) {}

  /** 预览：核对学号，抓取表格中的比赛榜单补全积分 / 名称 / 日期，不入账 */
  @Post('excel/preview')
  @RequireAction('points.review')
  async excelPreview(@Body() body: unknown) {
    return ok(await this.history.preview(parseOrThrow(historyPreviewSchema, body)))
  }

  @Post('excel')
  @RequireAction('points.review')
  async excel(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    return ok(await this.history.importExcel(actor, parseOrThrow(historyExcelSchema, body)))
  }
}
