import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
  type CallHandler,
  type ExecutionContext as EC,
  type NestInterceptor,
  type PipeTransform,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import type { Observable } from 'rxjs'
import { SessionService, type SessionActor } from '../modules/auth/session.service.js'

export const ROLES_KEY = 'required_roles'
export const RequireRoles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles)

/**
 * Guard 顺序（02 方案 4）：SessionGuard → PermissionsGuard →（业务内 MembershipGuard/回避检查）。
 * 前端隐藏按钮不能替代服务端授权。
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { actor?: SessionActor }>()
    const actor = await this.sessions.resolveActor(req)
    if (!actor) throw new UnauthorizedException('未登录或会话已失效')
    req.actor = actor
    return true
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!required || required.length === 0) return true
    const req = context.switchToHttp().getRequest<Request & { actor?: SessionActor }>()
    const actor = req.actor
    if (!actor) throw new UnauthorizedException()
    const ok = required.some((role) => actor.roles.includes(role))
    if (!ok) {
      throw new ForbiddenException(`当前身份无权执行该操作（需要 ${required.join(' 或 ')}）`)
    }
    return true
  }
}

/** 业务动作权限（细粒度）：与基础角色映射放 role 定义处；这里按 role 集合判断 */
export const ROLE_ACTIONS: Record<string, string[]> = {
  member: [],
  activity_manager: ['activity.manage', 'attendance.review', 'attendance.qr', 'venue.manage', 'venue.suspend'],
  points_reviewer: ['points.review', 'points.propose', 'claims.review'],
  presidium: [
    'activity.manage', 'attendance.review', 'attendance.qr', 'venue.manage', 'venue.suspend', 'venue.verify',
    'points.review', 'points.propose', 'claims.review', 'members.read', 'members.review', 'members.manage', 'invitations.manage',
    'disclosure.publish', 'badges.grant', 'badges.define', 'competitions.manage', 'rooms.approve', 'claims.review',
    'evaluation.manage',
  ],
  // 综评建议折算须经指导教师审核（附录三·九.3），故 advisor 同样可管理
  advisor: ['teacher.approve', 'members.read', 'members.review', 'points.review', 'disclosure.publish', 'competitions.manage', 'evaluation.manage'],
  system_admin: ['settings.manage', 'secrets.write', 'sync.manage', 'audit.read', 'platform.configure', 'members.read'],
}

export function actorCan(actor: SessionActor, action: string): boolean {
  // 系统管理员拥有全部业务与技术权限
  if (actor.roles.includes('system_admin')) return true
  return actor.roles.some((role) => ROLE_ACTIONS[role]?.includes(action))
}

@Injectable()
export class ActionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const action = this.reflector.getAllAndOverride<string>('required_action', [
      context.getHandler(),
      context.getClass(),
    ])
    if (!action) return true
    const req = context.switchToHttp().getRequest<Request & { actor?: SessionActor }>()
    if (!req.actor) throw new UnauthorizedException()
    if (!actorCan(req.actor, action)) throw new ForbiddenException(`无 ${action} 权限`)
    return true
  }
}

export const RequireAction = (action: string) => SetMetadata('required_action', action)

export const CurrentActor = createParamDecorator((_data: unknown, ctx: EC): SessionActor | undefined => {
  const req = ctx.switchToHttp().getRequest<Request & { actor?: SessionActor }>()
  return req.actor
})

export const CurrentUser = createParamDecorator((_data: unknown, ctx: EC) => {
  const req = ctx.switchToHttp().getRequest<Request & { actor?: SessionActor }>()
  const actor = req.actor
  if (!actor?.userId) throw new UnauthorizedException('该接口要求学生身份')
  return { userId: actor.userId, studentNo: actor.studentNo!, principalId: actor.principalId }
})

/** 私人响应统一 no-store（02 方案 8.4/10） */
@Injectable()
export class NoStoreInterceptor implements NestInterceptor {
  intercept(_context: EC, next: CallHandler): Observable<unknown> {
    const res = _context.switchToHttp().getResponse<{ setHeader?: (k: string, v: string) => void }>()
    res.setHeader?.('Cache-Control', 'private, no-store')
    return next.handle()
  }
}

/** zod 校验管道（DTO 白名单；拒绝额外字段由各 schema .strict() 控制） */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: { parse(input: unknown): unknown }) {}
  transform(value: unknown): unknown {
    return this.schema.parse(value)
  }
}

export interface ApiEnvelope<T> {
  data: T
  meta: { requestId: string; nextCursor?: string; revision?: number }
}

export function ok<T>(data: T, meta?: { nextCursor?: string; revision?: number }): ApiEnvelope<T> {
  return { data, meta: { requestId: crypto.randomUUID(), ...meta } }
}
