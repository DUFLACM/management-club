/**
 * 会话/身份解析：面板内自助读取 GET /auth/csrf 的会话绑定形态。
 *
 * - 401 由 lib/api.ts 全局事件兜底；这里只关心「已登录与否」与 principalId；
 * - usePrivateQuery 的 key 使用权限主体 principalId；学生业务记录另用 userId。
 */
import { useQuery } from '@tanstack/react-query';

import { api } from './api';

export interface CsrfSession {
  authenticated: boolean;
  principalId: string | null;
  principalKind: string | null;
  userId: string | null;
  campusId: string | null;
  studentNo: string | null;
  staffNo: string | null;
  roles: string[];
  /** 学生是否已绑定牛客（登录绑定门用）；非学生或旧版接口为 null */
  nowcoderBound: boolean | null;
}

export interface CsrfPayload {
  token?: string;
  authenticated?: boolean;
  principalId?: string | null;
  principalKind?: string | null;
  userId?: string | null;
  campusId?: string | null;
  studentNo?: string | null;
  staffNo?: string | null;
  roles?: string[];
  nowcoderBound?: boolean | null;
}

/**
 * 将 CSRF 端点的可选字段收敛为稳定会话形态。
 *
 * 旧版本只返回 userId；兼容期仅为学生会话回退到该值。教师会话必须由
 * 服务端返回真正的 principalId，不能伪造学生 userId。
 */
export function normalizeCsrfSession(data: CsrfPayload | null | undefined): CsrfSession {
  const userId = data?.userId ?? null;
  return {
    authenticated: data?.authenticated === true,
    principalId: data?.principalId ?? userId,
    principalKind: data?.principalKind ?? (userId ? 'student' : null),
    userId,
    campusId: data?.campusId ?? data?.studentNo ?? data?.staffNo ?? null,
    studentNo: data?.studentNo ?? null,
    staffNo: data?.staffNo ?? null,
    roles: data?.roles ?? [],
    nowcoderBound: typeof data?.nowcoderBound === 'boolean' ? data.nowcoderBound : null,
  };
}

async function fetchSession(): Promise<CsrfSession> {
  const { data } = await api.get<CsrfPayload>('/auth/csrf');
  return normalizeCsrfSession(data);
}

/** 当前登录身份（member 工作台与管理台共用）。 */
export function usePrincipalQuery() {
  return useQuery({
    queryKey: ['session', 'csrf'],
    queryFn: fetchSession,
    staleTime: 60_000,
  });
}

export function usePrincipal(): CsrfSession | null {
  return usePrincipalQuery().data ?? null;
}

/** 是否具备任一目标动作能力（与后端 ROLE_ACTIONS 映射保持一致）。 */
export function hasAnyAction(roles: string[], actions: string[]): boolean {
  const roleActions: Record<string, string[]> = {
    member: [],
    activity_manager: [
      'activity.manage',
      'attendance.review',
      'attendance.qr',
      'venue.manage',
      'venue.suspend',
    ],
    points_reviewer: ['points.review', 'points.propose', 'claims.review'],
    presidium: [
      'activity.manage',
      'attendance.review',
      'attendance.qr',
      'venue.manage',
      'venue.suspend',
      'venue.verify',
      'points.review',
      'points.propose',
      'claims.review',
      'members.read',
      'members.review',
      'members.manage',
      'invitations.manage',
      'disclosure.publish',
      'badges.grant',
      'badges.define',
      'competitions.manage',
      'rooms.approve',
      'evaluation.manage',
    ],
    advisor: [
      'teacher.approve',
      'members.read',
      'members.review',
      'points.review',
      'disclosure.publish',
      'competitions.manage',
      'evaluation.manage',
    ],
    system_admin: [
      'settings.manage',
      'secrets.write',
      'sync.manage',
      'audit.read',
      'platform.configure',
      'members.read',
    ],
  };
  return actions.some((action) =>
    roles.some((role) => roleActions[role]?.includes(action)),
  );
}
