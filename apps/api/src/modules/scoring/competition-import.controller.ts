import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common'
import type { z } from 'zod'
import { SessionGuard, PermissionsGuard, ActionGuard, RequireAction, CurrentActor, ok } from '../../common/guards.js'
import { ScoringError } from './scoring.service.js'
import {
  CompetitionImportService,
  competitionImportPreviewSchema,
  competitionImportCommitSchema,
} from './competition-import.service.js'
import type { SessionActor } from '../auth/session.service.js'

function parseOrThrow<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ScoringError(
      issue ? (issue.path.length ? `${issue.path.join('.')}：${issue.message}` : issue.message) : '请求参数无效',
      'INVALID_INPUT',
    )
  }
  return parsed.data
}

/** 正式赛报名名单与人员成绩导入（积分审核页面） */
@Controller('/api/v1/admin/competition-import')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class CompetitionImportController {
  constructor(@Inject(CompetitionImportService) private readonly competitionImport: CompetitionImportService) {}

  /** 预览：匹配成员（学号/姓名二选一，同名返回候选列表）、按赛事档位试算积分、校验重复行 */
  @Post('preview')
  @RequireAction('points.review')
  async preview(@Body() body: unknown) {
    return ok(await this.competitionImport.preview(parseOrThrow(competitionImportPreviewSchema, body)))
  }

  /** 提交：自动创建并归档正式赛事、写入个人/团队报名名单与成绩、归档积分并通知关联成员 */
  @Post('commit')
  @RequireAction('points.review')
  async commit(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    return ok(await this.competitionImport.commit(actor, parseOrThrow(competitionImportCommitSchema, body)))
  }
}
