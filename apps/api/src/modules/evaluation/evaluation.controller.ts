import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Res, StreamableFile, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { z } from 'zod'
import { SessionGuard, PermissionsGuard, ActionGuard, RequireAction, CurrentActor, ok } from '../../common/guards.js'
import { EvaluationService, EvaluationError } from './evaluation.service.js'
import type { SessionActor } from '../auth/session.service.js'

/** 标准分 0–100；纪律扣减与最终加分允许清空（null 表示撤销覆盖） */
const overrideSchema = z.object({
  pointsStd: z.number().min(0).max(100).nullable().optional(),
  contestStd: z.number().min(0).max(100).nullable().optional(),
  serviceStd: z.number().min(0).max(100).nullable().optional(),
  penalty: z.number().min(0).max(100).nullable().optional(),
  score: z.number().min(0).max(5).nullable().optional(),
  excluded: z.boolean().optional(),
  excludeReason: z.string().max(300).nullable().optional(),
  cadre: z.boolean().optional(),
  reason: z.string().min(3, '请填写修改理由').max(500),
})

@Controller('/api/v1/admin/evaluation')
@UseGuards(SessionGuard, PermissionsGuard, ActionGuard)
export class EvaluationAdminController {
  constructor(private readonly evaluation: EvaluationService) {}

  /** 学期列表：ended 表示已达折算时点，canGenerate 含测试口放行 */
  @Get('semesters')
  @RequireAction('evaluation.manage')
  async semesters() {
    return ok(await this.evaluation.semesters())
  }

  @Get('batches')
  @RequireAction('evaluation.manage')
  async batches() {
    return ok(await this.evaluation.batches())
  }

  @Post('batches')
  @RequireAction('evaluation.manage')
  async generate(@CurrentActor() actor: SessionActor, @Body() body: unknown) {
    const parsed = z.object({ semesterId: z.string().uuid() }).safeParse(body)
    if (!parsed.success) throw new EvaluationError(parsed.error.issues[0]!.message, 'INVALID_INPUT')
    return ok(await this.evaluation.generate(actor, parsed.data.semesterId))
  }

  @Get('batches/:id')
  @RequireAction('evaluation.manage')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.evaluation.batchDetail(id))
  }

  @Post('batches/:id/rows/:rowId')
  @RequireAction('evaluation.manage')
  async override(
    @CurrentActor() actor: SessionActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() body: unknown,
  ) {
    const parsed = overrideSchema.safeParse(body)
    if (!parsed.success) throw new EvaluationError(parsed.error.issues[0]!.message, 'INVALID_INPUT')
    return ok(await this.evaluation.overrideRow(actor, id, rowId, parsed.data))
  }

  @Post('batches/:id/recompute')
  @RequireAction('evaluation.manage')
  async recompute(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.evaluation.recompute(actor, id))
  }

  @Post('batches/:id/publish')
  @RequireAction('evaluation.manage')
  async publish(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.evaluation.publish(actor, id))
  }

  @Delete('batches/:id')
  @RequireAction('evaluation.manage')
  async remove(@CurrentActor() actor: SessionActor, @Param('id', ParseUUIDPipe) id: string) {
    return ok(await this.evaluation.deleteBatch(actor, id))
  }

  /** 导出 学号/姓名/加分；BOM 前置以便 Excel 正确识别 UTF-8 */
  @Get('batches/:id/export')
  @RequireAction('evaluation.manage')
  async exportCsv(@Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const { csv, filename } = await this.evaluation.exportCsv(id)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="evaluation-${id}.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`)
    return new StreamableFile(Buffer.from(`﻿${csv}`, 'utf-8'))
  }
}
