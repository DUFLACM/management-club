import { BadRequestException, Controller, Post, UseInterceptors, UseGuards, UploadedFile, Get, Param, ParseUUIDPipe, Query, Res, StreamableFile } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Response } from 'express'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { SessionGuard, PermissionsGuard, CurrentUser, CurrentActor, actorCan, ok } from '../../common/guards.js'
import type { SessionActor } from '../auth/session.service.js'
import { newId } from '../../common/utils.js'

/**
 * 私有附件：头像与贡献申报佐证图的上传与读取（08 方案 3.2）。受控本地存储（开发）/对象存储引用（生产）。
 * - 头像：仅 JPEG/PNG/WebP 白名单（魔数检测），≤2MiB；处理内联完成（worker 队列不再必需，
 *   worker 中 media.process_avatar 保留用于历史排队任务的幂等兜底）。
 * - 佐证图：同一白名单，≤5MiB，重编码为 WebP（剥除 EXIF/GPS）并派生缩略图；
 *   读取限本人与具 claims.review 的审核方。
 * - 变体读取走授权媒体入口，private 缓存；所有附件不直接公开。
 */

const IMAGE_MIME_WHITELIST = ['image/jpeg', 'image/png', 'image/webp']

/** 声明类型须在白名单内，且文件头与之一致（阻止改扩展名的 SVG/HTML 等） */
function assertImageMagic(file: { buffer: Buffer; mimetype: string }): void {
  if (!IMAGE_MIME_WHITELIST.includes(file.mimetype)) {
    throw new BadRequestException('仅支持 JPEG/PNG/WebP（禁止 SVG/GIF/HTML）')
  }
  const magic = file.buffer.subarray(0, 12)
  const isJpeg = magic[0] === 0xff && magic[1] === 0xd8
  const isPng = magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47
  const isWebp = magic.subarray(0, 4).toString('ascii') === 'RIFF' && magic.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!isJpeg && !isPng && !isWebp) throw new BadRequestException('文件内容与声明类型不符（已按魔数校验）')
}

@Controller('/api/v1/me')
@UseGuards(SessionGuard, PermissionsGuard)
export class UploadController {
  constructor(private readonly db: PrismaService) {}

  @Post('profile/avatar')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1 } }))
  async uploadAvatar(@CurrentUser() user: { userId: string }, @UploadedFile() file?: { buffer: Buffer; mimetype: string; size: number }) {
    if (!file) throw new BadRequestException('缺少上传文件')
    if (file.size > 2 * 1024 * 1024) throw new BadRequestException('头像源文件不超过 2 MiB')
    assertImageMagic(file)

    const assetId = newId()
    const storageKey = `avatars/${assetId}/source.bin`
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const storageRoot = process.env.STORAGE_LOCAL_DIR ?? './storage'
    const sourcePath = path.join(storageRoot, storageKey)
    await fs.mkdir(path.dirname(sourcePath), { recursive: true })
    await fs.writeFile(sourcePath, file.buffer)

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

    // 内联派生变体：方向修正 → 裁剪缩放 → WebP 重编码（剥除 EXIF/GPS）；失败即时报错
    try {
      const sharp = (await import('sharp')).default
      const image = sharp(file.buffer, { limitInputPixels: 16_000_000 })
      const meta = await image.metadata()
      if (meta.pages && meta.pages > 1) throw new BadRequestException('多帧/动画图片不支持')
      if (!meta.width || !meta.height || meta.width < 64 || meta.height < 64 || meta.width > 4096 || meta.height > 4096) {
        throw new BadRequestException('图片尺寸须在 64–4096px')
      }
      const variants: Record<string, string> = {}
      for (const size of [64, 128, 256, 512]) {
        const outKey = `avatars/${assetId}/${size}.webp`
        await image.rotate().resize(size, size, { fit: 'cover' }).webp({ quality: size <= 128 ? 78 : 82 }).toFile(path.join(storageRoot, outKey))
        variants[String(size)] = outKey
      }
      await this.db.mediaAsset.update({
        where: { id: assetId },
        data: { status: 'ready', width: meta.width, height: meta.height, frames: 1, variants: variants as never, mimeType: 'image/webp' },
      })
    } catch (error) {
      await this.db.mediaAsset.update({ where: { id: assetId }, data: { status: 'failed' } }).catch(() => undefined)
      throw error instanceof BadRequestException ? error : new BadRequestException('头像处理失败，请换一张图片重试')
    }

    return ok({ assetId, status: 'ready', variants: ['64', '128', '256', '512'] })
  }

  /**
   * 贡献申报佐证图上传（先传图拿 assetId，再随申报一起提交）。
   * 重编码为 WebP 即剥除 EXIF/GPS（截图常带定位信息），并派生 320px 缩略图供审核列表使用。
   */
  @Post('claim-evidence')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  async uploadClaimEvidence(
    @CurrentUser() user: { userId: string },
    @UploadedFile() file?: { buffer: Buffer; mimetype: string; size: number },
  ) {
    if (!file) throw new BadRequestException('缺少上传文件')
    if (file.size > 5 * 1024 * 1024) throw new BadRequestException('单张佐证图不超过 5 MiB')
    assertImageMagic(file)

    // 传了图却从未提交申报的资产会滞留，限制未关联数量，避免单账号无限占用存储
    const dangling = await this.db.mediaAsset.count({
      where: { ownerUserId: user.userId, purpose: 'evidence', status: 'ready', claimLink: { is: null } },
    })
    if (dangling >= 20) {
      throw new BadRequestException('有过多尚未提交的佐证图，请先完成申报提交后再上传')
    }

    const assetId = newId()
    const storageKey = `evidence/${assetId}/source.bin`
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const storageRoot = process.env.STORAGE_LOCAL_DIR ?? './storage'
    const sourcePath = path.join(storageRoot, storageKey)
    await fs.mkdir(path.dirname(sourcePath), { recursive: true })
    await fs.writeFile(sourcePath, file.buffer)

    await this.db.mediaAsset.create({
      data: {
        id: assetId,
        ownerUserId: user.userId,
        purpose: 'evidence',
        status: 'processing',
        mimeType: file.mimetype,
        contentHash: createHash('sha256').update(file.buffer).digest('hex'),
        storageKey,
      },
    })

    try {
      const sharp = (await import('sharp')).default
      const image = sharp(file.buffer, { limitInputPixels: 50_000_000 })
      const meta = await image.metadata()
      if (meta.pages && meta.pages > 1) throw new BadRequestException('多帧/动画图片不支持')
      if (!meta.width || !meta.height || meta.width < 32 || meta.height < 32 || meta.width > 10_000 || meta.height > 10_000) {
        throw new BadRequestException('图片尺寸须在 32–10000px')
      }
      const variants: Record<string, string> = {}
      // full：长边不超过 1600px，够看清截图文字又不至于过大；thumb：审核列表缩略图
      for (const [name, size] of [['full', 1600], ['thumb', 320]] as const) {
        const outKey = `evidence/${assetId}/${name}.webp`
        await image
          .rotate()
          .resize(size, size, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: name === 'thumb' ? 76 : 84 })
          .toFile(path.join(storageRoot, outKey))
        variants[name] = outKey
      }
      // 原始文件已派生出剥离元数据的副本，不再保留（避免 EXIF/GPS 长期留存）
      await fs.rm(sourcePath, { force: true })
      await this.db.mediaAsset.update({
        where: { id: assetId },
        data: {
          status: 'ready',
          width: meta.width,
          height: meta.height,
          frames: 1,
          variants: variants as never,
          mimeType: 'image/webp',
          storageKey: variants.full,
        },
      })
      return ok({ assetId, status: 'ready', width: meta.width, height: meta.height })
    } catch (error) {
      await this.db.mediaAsset.update({ where: { id: assetId }, data: { status: 'failed' } }).catch(() => undefined)
      throw error instanceof BadRequestException ? error : new BadRequestException('佐证图处理失败，请换一张图片重试')
    }
  }

  /**
   * 佐证图读取：本人，或审核方（审核时需要看图）。
   * 队列接口按 points.review 开放、裁决按 claims.review，故两者任一皆可读，
   * 否则指导教师能打开申报队列却看不到图。
   */
  @Get('claim-evidence/:assetId')
  async claimEvidence(
    @CurrentActor() actor: SessionActor,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Res({ passthrough: true }) res: Response,
    @Query('size') size?: string,
  ): Promise<StreamableFile> {
    const asset = await this.db.mediaAsset.findUnique({ where: { id: assetId } })
    if (!asset || asset.status !== 'ready' || asset.purpose !== 'evidence') throw new BadRequestException('佐证图不存在')
    const isOwner = actor.userId != null && actor.userId === asset.ownerUserId
    const isReviewer = actorCan(actor, 'claims.review') || actorCan(actor, 'points.review')
    if (!isOwner && !isReviewer) throw new BadRequestException('佐证图不存在')

    const variants = (asset.variants ?? {}) as Record<string, string>
    const variantName = size === 'thumb' ? 'thumb' : 'full'
    const storageKey = variants[variantName] ?? asset.storageKey
    if (!storageKey) throw new BadRequestException('佐证图文件缺失')
    const path = await import('node:path')
    const filePath = path.join(process.env.STORAGE_LOCAL_DIR ?? './storage', storageKey)
    const fs = await import('node:fs/promises')
    await fs.access(filePath).catch(() => {
      throw new BadRequestException('佐证图文件缺失')
    })
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.setHeader('Content-Type', 'image/webp')
    return new StreamableFile(createReadStream(filePath))
  }

  /** 处理状态查询：接受上传任务 ID（jobs.payload.mediaAssetId）或资产 ID */
  @Get('media-jobs/:id')
  async mediaJob(@CurrentUser() user: { userId: string }, @Param('id', ParseUUIDPipe) id: string) {
    const job = await this.db.job.findUnique({ where: { id } })
    const assetIdFromJob = (job?.payload as { mediaAssetId?: string } | null)?.mediaAssetId
    const asset = await this.db.mediaAsset.findUnique({ where: { id: assetIdFromJob ?? id } })
    if (!asset || asset.ownerUserId !== user.userId) throw new BadRequestException('任务不存在')
    return ok({ assetId: asset.id, status: asset.status, variants: asset.variants })
  }

  /** 头像变体读取：本人可直接读；他人头像仅当其主页可见性非「仅自己」时开放（社内成员登录态） */
  @Get('avatar/:assetId')
  async avatar(
    @CurrentUser() user: { userId: string },
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Res({ passthrough: true }) res: Response,
    @Query('size') size?: string,
  ): Promise<StreamableFile> {
    const variantSize = ['64', '128', '256', '512'].includes(size ?? '') ? size! : '256'
    const asset = await this.db.mediaAsset.findUnique({ where: { id: assetId } })
    if (!asset || asset.status !== 'ready' || asset.purpose !== 'avatar') throw new BadRequestException('头像不存在')
    if (asset.ownerUserId !== user.userId) {
      const profile = await this.db.userProfile.findUnique({ where: { userId: asset.ownerUserId } })
      if (profile?.visibility === 'self_only') throw new BadRequestException('该成员头像不对外展示')
    }
    const variants = (asset.variants ?? {}) as Record<string, string>
    const storageKey = variants[variantSize] ?? asset.storageKey
    const path = await import('node:path')
    const filePath = path.join(process.env.STORAGE_LOCAL_DIR ?? './storage', storageKey)
    const fs = await import('node:fs/promises')
    await fs.access(filePath).catch(() => {
      throw new BadRequestException('头像文件缺失')
    })
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.setHeader('Content-Type', 'image/webp')
    return new StreamableFile(createReadStream(filePath))
  }
}
