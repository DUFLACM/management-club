import { Test } from '@nestjs/testing'
import { describe, expect, it } from 'vitest'
import { DatabaseModule, PrismaService } from '../../infrastructure/database/database.module.js'
import { actorCan } from '../../common/guards.js'
import type { SessionActor } from '../../modules/auth/session.service.js'

describe('运行服务与角色授权', () => {
  it('Nest 可创建 Prisma 服务，配置字符串不作为必需注入依赖', async () => {
    const module = await Test.createTestingModule({ imports: [DatabaseModule] }).compile()
    expect(typeof module.get(PrismaService).$connect).toBe('function')
    await module.close()
  })

  it.each(['presidium', 'advisor', 'system_admin'])('%s 可读取其管理范围的成员列表', (role) => {
    expect(actorCan({ roles: [role] } as SessionActor, 'members.read')).toBe(true)
  })

  it('成员无管理读取权，系统管理员读取权不附带业务审批权', () => {
    expect(actorCan({ roles: ['member'] } as SessionActor, 'members.read')).toBe(false)
    expect(actorCan({ roles: ['system_admin'] } as SessionActor, 'members.review')).toBe(false)
  })
})
