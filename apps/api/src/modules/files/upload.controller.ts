import { BadRequestException, Controller, Post, UseInterceptors, UseGuards, UploadedFile, Get, Param, ParseUUIDPipe } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { createHash } from 'node:crypto'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { SessionGuard, PermissionsGuard, CurrentUser, ok } from '../../common/guards.js'
import { newId } from '../../common/utils.js'
import { JobsService } from '../../infrastructure/jobs/jobs.service.js'

/**
 * 私有附件上传（08 方案 3.2）：受控本地存储（开发）/对象存储引用（生产）。
 * - 头像：仅 JPEG/PNG/WebP 白名单（魔数检测），≤2MiB；源文件不直接公开。
 * - 所有附件通过授权媒体入口访问，private,no-store。
 */
@Controller('/api/v1/me')
@UseGuards(SessionGuard, PermissionsGuard)
export class UploadController {
  constructor(
    private readonly db: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  @Post('profile/avatar')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1 } }))
  async uploadAvatar(@CurrentUser() user: { userId: string }, @UploadedFile() file?: { buffer: Buffer; mimetype: string; size: number }) {
    if (!file) throw new BadRequestException('缺少上传文件')
    if (file.size > 2 * 1024 * 1024) throw new BadRequestException('头像源文件不超过 2 MiB')
    const allowedMime = ['image/jpeg', 'image/png', 'image/webp']
    if (!allowedMime.includes(file.mimetype)) throw new BadRequestException('仅支持 JPEG/PNG/WebP（禁止 SVG/GIF/HTML）')
    const magic = file.buffer.subarray(0, 12)
    const isJpeg = magic[0] === 0xff && magic[1] === 0xd8
    const isPng = magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47
    const isWebp = magic.subarray(0, 4).toString('ascii') === 'RIFF' && magic.subarray(8, 12).toString('ascii') === 'WEBP'
    if (!isJpeg && !isPng && !isWebp) throw new BadRequestException('文件内容与声明类型不符（已按魔数校验）')

    const assetId = newId()
    const storageKey = `avatars/${assetId}/source.bin`
    // 开发环境受控本地目录；生产替换为私有对象存储
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const dir = path.join(process.env.STORAGE_LOCAL_DIR ?? './storage', storageKey)
    await fs.mkdir(path.dirname(dir), { recursive: true })
    await fs.writeFile(dir, file.buffer)

    await this.db.mediaAsset.create({
      data: {
        id: assetId,
        ownerUserId: user.userId,
        purpose: 'avatar',
        status: 'processing',
        mimeType: file.mimetype,
        contentHash: createHash('sha256').update(file.buffer).digest('hex'),
        storageKey,
      },
    })
    const enqueued = await this.jobs.enqueue({
      type: 'media.process_avatar',
      payload: { mediaAssetId: assetId },
      dedupeKey: `avatar:${assetId}`,
      priority: 6,
    })
    const jobId = enqueued.id
    return { ...ok({ assetId, jobId }), status: 202 } as never
  }

  @Get('media-jobs/:id')
  async mediaJob(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string) {
    const asset = await this.db.mediaAsset.findUnique({ where: { id } })
    if (!asset || asset.ownerUserId !== user.userId) throw new BadRequestException('任务不存在')
    return ok({ assetId: asset.id, status: asset.status, variants: asset.variants })
  }
}
