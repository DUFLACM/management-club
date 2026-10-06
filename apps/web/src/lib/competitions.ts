/**
 * 正式赛事报名与组队广场的类型与端点封装
 * （对应 apps/api/src/modules/competitions/）。
 *
 * api.ts 只做传输层；本模块集中领域 DTO 与路径，避免面板里散落字符串路径。
 */
import { api } from './api';

export type CompetitionCategory = 'A' | 'B';
export type ScoringMode = 'platform_auto' | 'manual_review';

/** 赛事生命周期：草稿 → 开放报名 → 已出名单/组队中 → 已结算 */
export type CompetitionEventStatus =
  | 'draft'
  | 'open'
  | 'shortlisted'
  | 'team_forming'
  | 'closed'
  | 'settled'
  | 'archived';

export const CONTEST_TIERS = [
  { value: 'school_select', label: '校级选拔' },
  { value: 'provincial', label: '省级赛事' },
  { value: 'icpc_invite', label: 'ICPC 邀请赛' },
  { value: 'icpc_regional', label: 'ICPC 区域赛' },
  { value: 'top_final', label: '顶级总决赛' },
  { value: 'network_qualifier', label: '网络预选赛' },
  { value: 'ladder', label: '天梯赛' },
  { value: 'lanqiao', label: '蓝桥杯' },
  { value: 'baidu_star', label: '百度之星' },
] as const;

export type ContestTier = (typeof CONTEST_TIERS)[number]['value'];

export const MEDAL_LEVELS = [
  { value: 'gold', label: '金奖 / 一等奖' },
  { value: 'silver', label: '银奖 / 二等奖' },
  { value: 'bronze', label: '铜奖 / 三等奖' },
  { value: 'honorable', label: '优胜 / 鼓励奖' },
] as const;

export const LADDER_TEAM_AWARDS = [
  { value: 'prov3', label: '省级三等（8）' },
  { value: 'prov2', label: '省级二等（14）' },
  { value: 'prov1', label: '省级一等（22）' },
  { value: 'nat3', label: '国家级三等（28）' },
  { value: 'nat2', label: '国家级二等（45）' },
  { value: 'nat1', label: '国家级一等（75）' },
  { value: 'special', label: '特等（135）' },
] as const;

export const LADDER_INDIVIDUAL_AWARDS = [
  { value: 'third', label: '个人三等（14）' },
  { value: 'second', label: '个人二等（25）' },
  { value: 'first', label: '个人一等（45）' },
  { value: 'special', label: '个人特等（90）' },
] as const;

export const LANQIAO_AWARDS = [
  { value: 'prov3', label: '省赛三等' },
  { value: 'prov2', label: '省赛二等' },
  { value: 'prov1', label: '省赛一等' },
  { value: 'nat_excellent', label: '国赛优秀' },
  { value: 'nat3', label: '国赛三等' },
  { value: 'nat2', label: '国赛二等' },
  { value: 'nat1', label: '国赛一等' },
] as const;

/** 人工审核时该档位需要录入的奖项字段形态 */
export type AwardFormKind = 'medal' | 'network_qualifier' | 'ladder' | 'lanqiao' | 'baidu_star';

export function awardFormKind(tier: string | null | undefined): AwardFormKind {
  if (tier === 'network_qualifier') return 'network_qualifier';
  if (tier === 'ladder') return 'ladder';
  if (tier === 'lanqiao') return 'lanqiao';
  if (tier === 'baidu_star') return 'baidu_star';
  return 'medal';
}

export const EVENT_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  open: '开放报名',
  shortlisted: '已出资格名单',
  team_forming: '组队中',
  closed: '已关闭',
  settled: '已结算',
  archived: '已归档',
};

/** 报名/队伍报名状态文案（成员端与管理端共用） */
export const ENTRY_STATUS_LABELS: Record<string, string> = {
  submitted: '已提交',
  pending_review: '待审核',
  approved: '已通过',
  confirmed: '已确认',
  rejected: '已驳回',
  waitlisted: '候补中',
  declined: '已拒绝',
  cancelled: '已取消',
};

export function eventStatusLabel(status: string): string {
  return EVENT_STATUS_LABELS[status] ?? status;
}

export function entryStatusLabel(status: string | null | undefined): string {
  if (!status) return '未报名';
  return ENTRY_STATUS_LABELS[status] ?? status;
}

export function contestTierLabel(tier: string | null | undefined): string {
  if (!tier) return '—';
  return CONTEST_TIERS.find((item) => item.value === tier)?.label ?? tier;
}

export const LAMBDA_LABELS: Record<string, string> = {
  A: '甲类 λ1.2',
  B: '乙类 λ1.0',
  C: '丙类 λ0.8',
};

export interface CompetitionEventDto {
  id: string;
  designatedContestId: string | null;
  title: string;
  category: CompetitionCategory;
  teamSize: number | null;
  scoringMode: ScoringMode;
  platform: string | null;
  platformContestId: string | null;
  contestTier: string | null;
  lambdaKey: string | null;
  announcement: string;
  registerStartAt: string | null;
  registerDeadline: string;
  startAt: string;
  endAt: string;
  quota: number | null;
  qualificationRule: { basedOn?: 'currentE' | 'specialQ'; specialWeight?: number } | null;
  freezeAt: string | null;
  teamFormDeadline: string | null;
  status: CompetitionEventStatus;
  createdAt: string;
}

/** 管理端列表附带报名/队伍计数 */
export interface AdminCompetitionEventDto extends CompetitionEventDto {
  _count: { registrations: number; teamEntries: number };
}

/** 成员端列表附带「我的状态」（个人报名或所属队伍报名状态） */
export interface MemberCompetitionEventDto extends CompetitionEventDto {
  myStatus: string | null;
}

export interface CompetitionMaterialDto {
  id: string;
  title: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

export interface MyRegistrationDto {
  id: string;
  eventId: string;
  userId: string;
  platformAccountId: string | null;
  status: string;
  resultScore: string | null;
  resultDetail: Record<string, unknown> | null;
  reviewNote: string | null;
  note: string | null;
  registeredAt: string;
  confirmedAt: string | null;
  materials: CompetitionMaterialDto[];
  platformAccount: { id: string; platform: string; displayHandle: string; status: string } | null;
}

export interface MyShortlistRowDto {
  position: number;
  eSnapshot: string;
  qScore: string | null;
  eligible: boolean;
  shortlisted: boolean;
}

export interface TeamMemberDto {
  id: string;
  userId: string;
  role: string;
  status: string;
  user?: {
    id: string;
    verifiedRealName: string;
    studentNo: string;
    profile: { displayName: string | null } | null;
  };
}

export interface MyTeamEntryDto {
  id: string;
  teamId: string;
  eventId: string;
  status: string;
  resultScore: string | null;
  reviewNote: string | null;
  registeredAt: string;
  materials: CompetitionMaterialDto[];
  team: { id: string; name: string; teamSize: number; status: string; members: TeamMemberDto[] };
}

export interface CompetitionEventDetailDto {
  event: CompetitionEventDto;
  contestUrl: string | null;
  myShortlist: MyShortlistRowDto | null;
  myRegistration: MyRegistrationDto | null;
  myTeamEntries: MyTeamEntryDto[];
}

export interface MemberShortlistBoardDto {
  event: {
    id: string;
    title: string;
    category: string;
    status: string;
    quota: number | null;
    teamSize: number | null;
    freezeAt: string | null;
  };
  rows: Array<{
    position: number;
    userId: string;
    eSnapshot: string;
    qScore: string | null;
    eligible: boolean;
    shortlisted: boolean;
    isMe: boolean;
  }>;
}

export interface AdminShortlistRowDto {
  id: string;
  eventId: string;
  userId: string;
  position: number;
  eSnapshot: string;
  qScore: string | null;
  eligible: boolean;
  shortlisted: boolean;
  user: {
    verifiedRealName: string;
    studentNo: string;
    profile: { displayName: string | null } | null;
  };
}

export interface AdminRegistrationDto {
  id: string;
  eventId: string;
  userId: string;
  status: string;
  resultScore: string | null;
  reviewNote: string | null;
  note: string | null;
  registeredAt: string;
  materials: CompetitionMaterialDto[];
  user: {
    verifiedRealName: string;
    studentNo: string;
    profile: { displayName: string | null } | null;
  };
}

/** 管理端队伍报名：含在队成员明细，审核通过时逐人入账 */
export interface AdminTeamEntryDto {
  id: string;
  eventId: string;
  teamId: string;
  status: string;
  resultScore: string | null;
  reviewNote: string | null;
  registeredAt: string;
  materials: CompetitionMaterialDto[];
  team: {
    id: string;
    name: string;
    teamSize: number;
    status: string;
    members: Array<{
      id: string;
      userId: string;
      role: string;
      status: string;
      user: {
        id: string;
        verifiedRealName: string;
        studentNo: string;
        profile: { displayName: string | null } | null;
      };
    }>;
  };
}

export interface TeamDto {
  id: string;
  name: string;
  teamSize: number;
  captainUserId: string;
  status: string;
  createdAt: string;
  members: TeamMemberDto[];
  entries: Array<{
    id: string;
    eventId: string;
    status: string;
    resultScore: string | null;
    reviewNote: string | null;
    event: { id: string; title: string; status: string };
  }>;
}

export interface TeamInviteDto {
  id: string;
  teamId: string;
  invitedUserId: string;
  invitedBy: string;
  status: string;
  createdAt: string;
  team: { id: string; name: string; teamSize: number };
}

export interface EligibleEventDto {
  event: CompetitionEventDto;
  eligible: boolean;
  reason?: string;
}

export interface InvitableMemberDto {
  userId: string;
  displayName: string;
  studentNoMasked: string;
}

export interface SettleResultDto {
  posted: number;
  deduplicated: number;
  skipped: Array<{ name: string; reason: string }>;
}

/** 创建赛事的请求体（与后端 competitionEventInputSchema 对齐） */
export interface CompetitionEventInput {
  designatedContestId?: string;
  title: string;
  category: CompetitionCategory;
  teamSize?: number | null;
  scoringMode: ScoringMode;
  platform?: string;
  platformContestId?: string;
  contestTier?: string;
  lambdaKey?: string;
  announcement: string;
  registerStartAt?: string | null;
  registerDeadline: string;
  startAt: string;
  endAt: string;
  quota?: number | null;
  qualificationRule?: { basedOn: 'currentE' | 'specialQ'; specialWeight?: number } | null;
  freezeAt?: string | null;
  teamFormDeadline?: string | null;
}

// ---------------- 成员端 ----------------

export const competitionsApi = {
  async listOpenEvents() {
    return (await api.get<MemberCompetitionEventDto[]>('/me/competition-events')).data;
  },
  async eventDetail(eventId: string) {
    return (await api.get<CompetitionEventDetailDto>(`/me/competition-events/${eventId}`)).data;
  },
  async shortlistBoard(eventId: string) {
    return (await api.get<MemberShortlistBoardDto>(`/me/competition-events/${eventId}/shortlist`)).data;
  },
  async register(eventId: string, body: { platformAccountId?: string; note?: string }) {
    return (await api.post<{ registrationId: string }>(`/me/competition-events/${eventId}/register`, body)).data;
  },
  async resubmit(registrationId: string, note?: string) {
    await api.post(`/me/competition-registrations/${registrationId}/resubmit`, { note });
  },
  async uploadRegistrationMaterial(registrationId: string, file: File, title: string) {
    const form = new FormData();
    form.append('file', file);
    form.append('title', title);
    return (await api.upload<{ materialId: string }>(`/me/competition-registrations/${registrationId}/materials`, form)).data;
  },
  registrationMaterialUrl(registrationId: string, materialId: string) {
    return `/api/v1/me/competition-registrations/${registrationId}/materials/${materialId}/download`;
  },

  // ---------------- 组队广场 ----------------

  async myTeams() {
    return (await api.get<TeamDto[]>('/me/teams')).data;
  },
  async createTeam(body: { name: string; teamSize: number }) {
    return (await api.post<{ teamId: string }>('/me/teams', body)).data;
  },
  async myInvites() {
    return (await api.get<TeamInviteDto[]>('/me/team-invites')).data;
  },
  async searchInvitableMembers(q: string) {
    return (await api.get<InvitableMemberDto[]>(`/me/invitable-members?q=${encodeURIComponent(q)}`)).data;
  },
  async invite(teamId: string, inviteeUserId: string) {
    return (await api.post<{ inviteId: string }>(`/me/teams/${teamId}/invite`, { inviteeUserId })).data;
  },
  async respondInvite(inviteId: string, decision: 'accept' | 'decline') {
    await api.post(`/me/team-invites/${inviteId}/respond`, { decision });
  },
  async leaveTeam(teamId: string) {
    await api.post(`/me/teams/${teamId}/leave`);
  },
  async eligibleEvents(teamId: string) {
    return (await api.get<EligibleEventDto[]>(`/me/teams/${teamId}/eligible-events`)).data;
  },
  async registerTeam(teamId: string, eventId: string) {
    return (await api.post<{ entryId: string }>(`/me/teams/${teamId}/register/${eventId}`)).data;
  },
  async uploadTeamMaterial(entryId: string, file: File, title: string) {
    const form = new FormData();
    form.append('file', file);
    form.append('title', title);
    return (await api.upload<{ materialId: string }>(`/me/team-competition-entries/${entryId}/materials`, form)).data;
  },
  teamMaterialUrl(entryId: string, materialId: string) {
    return `/api/v1/me/team-competition-entries/${entryId}/materials/${materialId}/download`;
  },
};

// ---------------- 管理端 ----------------

export const competitionsAdminApi = {
  async listEvents(status?: string) {
    const suffix = status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : '';
    return (await api.get<AdminCompetitionEventDto[]>(`/admin/competition-events${suffix}`)).data;
  },
  async createEvent(body: CompetitionEventInput) {
    return (await api.post<{ eventId: string }>('/admin/competition-events', body)).data;
  },
  async publish(eventId: string) {
    await api.post(`/admin/competition-events/${eventId}/publish`);
  },
  async buildShortlist(eventId: string) {
    return (await api.post<{ shortlisted: number; total: number }>(`/admin/competition-events/${eventId}/build-shortlist`)).data;
  },
  async shortlist(eventId: string) {
    return (await api.get<AdminShortlistRowDto[]>(`/admin/competition-events/${eventId}/shortlist`)).data;
  },
  async overrideShortlist(eventId: string, userId: string, body: { qScore?: number | null; eligible?: boolean }) {
    await api.post(`/admin/competition-events/${eventId}/shortlist/${userId}/override`, body);
  },
  async registrations(eventId: string) {
    return (await api.get<AdminRegistrationDto[]>(`/admin/competition-events/${eventId}/registrations`)).data;
  },
  async teamEntries(eventId: string) {
    return (await api.get<AdminTeamEntryDto[]>(`/admin/competition-events/${eventId}/team-entries`)).data;
  },
  async reviewRegistration(
    registrationId: string,
    body: { decision: 'approve' | 'reject'; note?: string; award?: Record<string, unknown> },
  ) {
    await api.post(`/admin/competition-events/registrations/${registrationId}/review`, body);
  },
  async reviewTeamEntry(
    entryId: string,
    body: { decision: 'approve' | 'reject'; note?: string; award?: Record<string, unknown> },
  ) {
    await api.post(`/admin/competition-events/team-entries/${entryId}/review`, body);
  },
  async settle(eventId: string) {
    return (await api.post<SettleResultDto>(`/admin/competition-events/${eventId}/settle`)).data;
  },
  async forceTeamAssignment(eventId: string) {
    return (await api.post<{ teamsCreated: number; remainder: number }>(`/admin/competition-events/${eventId}/force-team-assignment`)).data;
  },
  exportUrl(eventId: string) {
    return `/api/v1/admin/competition-events/${eventId}/export`;
  },
  /** 管理端下载报名材料：走 admin 路由（成员端路由仅限本人） */
  registrationMaterialUrl(registrationId: string, materialId: string) {
    return `/api/v1/admin/competition-events/registrations/${registrationId}/materials/${materialId}/download`;
  },
  teamMaterialUrl(entryId: string, materialId: string) {
    return `/api/v1/admin/competition-events/team-entries/${entryId}/materials/${materialId}/download`;
  },
};
