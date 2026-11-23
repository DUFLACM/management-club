import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Response } from 'express'
import { PrismaService } from '../../infrastructure/database/database.module.js'
import { UploadController } from '../../modules/files/upload.controller.js'
import { ensureTestDatabase, TEST_URL } from './setup.js'
import { createTestUser, makeActor } from './helpers.js'

/**
 * 头像读取身份口径：
 * - 不再要求请求者必须是学生；系统管理员 / 教职工等已登录主体也可读取；
 * - 「仅自己」头像对普通成员隐藏，但 members.read 管理角色可查看。
 */

process.env.DATABASE_URL = TEST_URL

let db: PrismaService
let controller: UploadController
let storageRoot: string

const response = { setHeader: () => undefined } as unknown as Response

beforeAll(async () => {
  const url = ensureTestDatabase()
  db = new PrismaService(url)
  controller = new UploadController(db)
  storageRoot = await mkdtemp(path.join(tmpdir(), 'acm-avatar-test-'))
  process.env.STORAGE_LOCAL_DIR = storageRoot
})

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true })
  await db.$disconnect()
})

async function createAvatar(ownerUserId: string): Promise<string> {
  const assetId = randomUUID()
  const key = `avatars/${assetId}/64.webp`
  await mkdir(path.join(storageRoot, `avatars/${assetId}`), { recursive: true })
  await writeFile(path.join(storageRoot, key), Buffer.from([0x52, 0x49, 0x46, 0x46]))
  await db.mediaAsset.create({
    data: {
      id: assetId,
      ownerUserId,
      purpose: 'avatar',
      status: 'ready',
      mimeType: 'image/webp',
      storageKey: key,
      variants: { '64': key, '128': key, '256': key, '512': key } as never,
    },
  })
  return assetId
}

describe('头像读取不限学生身份', () => {
  it('系统管理员没有 userId 也能读取；普通成员仍受「仅自己」限制，管理角色可绕过', async () => {
    const owner = await createTestUser(db, { studentNo: '20269911', name: '头像所有者' })
    const member = await createTestUser(db, { studentNo: '20269912', name: '普通成员' })
    const assetId = await createAvatar(owner.userId)
    await db.userProfile.update({
      where: { userId: owner.userId },
      data: { avatarAssetId: assetId, visibility: 'self_only' },
    })

    // 系统管理员 / 教职工主体通常没有 users.id；旧实现 @CurrentUser 会直接 401
    const systemView = await controller.avatar(
      makeActor({ principalKind: 'system', roles: ['system_admin'] }),
      assetId,
      response,
      '64',
    )
    expect(systemView).toBeTruthy()

    const advisorView = await controller.avatar(
      makeActor({ principalKind: 'staff', roles: ['advisor'] }),
      assetId,
      response,
      '64',
    )
    expect(advisorView).toBeTruthy()

    const ordinaryMember = makeActor({
      principalId: member.principalId,
      userId: member.userId,
      studentNo: '20269912',
      roles: ['member'],
    })
    await expect(
      controller.avatar(ordinaryMember, assetId, response, '64'),
    ).rejects.toThrow('该成员头像不对外展示')

    const ownerView = await controller.avatar(owner.actor, assetId, response, '64')
    expect(ownerView).toBeTruthy()

    // 非「仅自己」头像：普通成员也可读取
    await db.userProfile.update({ where: { userId: owner.userId }, data: { visibility: 'members' } })
    const memberView = await controller.avatar(ordinaryMember, assetId, response, '64')
    expect(memberView).toBeTruthy()
  })
})
