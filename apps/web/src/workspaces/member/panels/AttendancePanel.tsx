/**
 * 成员端 · 签到与出勤（单任务面板）。
 *
 * - 活动选择：?id= 或从 /me/dashboard 的开放活动中选择；
 * - 上下文 GET /activities/:id/attendance-context（资格/窗口/地点/策略）；
 * - 流程：POST attendance/challenge → POST attendance/checkpoints（GEO/QR/双证据）；
 * - GEO：navigator.geolocation（enableHighAccuracy，10s 超时，拒绝/超时分别提示）；
 * - QR：懒加载扫码组件（优先 BarcodeDetector；不可用转系统相机 + 手动 token）；
 * - 页面地址 #q=<token> 读取后立即清除；切页/关闭释放相机与定位。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { lazy, Suspense } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  CrosshairIcon,
  DoorOpenIcon,
  LoaderCircleIcon,
  MapPinIcon,
  QrCodeIcon,
} from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { usePrincipal } from '@/lib/session';
import { formatStartEnd, formatTime, policyLabel } from '@/lib/format';
import { parseQrToken } from '@/lib/qr';
import { PanelHeader } from '@/components/club/PanelHeader';
import { MemberGate } from '@/components/club/QueryBoundary';
import { StatusBadge } from '@/components/club/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from '@/components/ui/drawer';
import { Skeleton } from '@/components/ui/skeleton';

const QrScanner = lazy(() => import('@/components/club/QrScanner'));

interface AttendanceContextDto {
  activity: {
    id: string;
    title: string;
    type: string;
    startAt: string;
    endAt: string;
    requireValidSubmission: boolean;
  };
  eligibility: {
    eligible: boolean;
    reason: string;
    registration: { status: string; waitlistSeq: number | null } | null;
    required: boolean;
    leave: { status: string } | null;
    remote: { status: string } | null;
  };
  policy: {
    policy: string;
    checkinOpenAt: string;
    checkinCloseAt: string;
    checkoutOpenAt: string | null;
    checkoutCloseAt: string | null;
    selfCheckout: boolean;
    maxAccuracyMeters: number;
    windowOpen: { IN: boolean; OUT: boolean };
  } | null;
  venues: Array<{
    venueVersionId: string;
    name: string;
    building: string | null;
    room: string | null;
    directions: string | null;
    operationalStatus: string;
    allowedCapabilities: string[];
    hasCoordinates: boolean;
  }>;
  checkpoints: Array<{ checkpoint: 'IN' | 'OUT'; acceptedAt: string; method: string }>;
  serverTime: string;
}

interface CheckpointResult {
  result: 'accepted' | 'pending_review' | 'rejected' | 'already_recorded';
  serverTime: string;
  acceptedAt?: string;
  message: string;
  nextStep?: string;
  method?: string;
}

interface OpenActivityOption {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  windowOpen: 'IN' | 'OUT' | 'none';
  canCheckIn: boolean;
  checkedIn: boolean;
  checkedOut: boolean;
  required: boolean;
  venue: { name: string; building: string | null; room: string | null } | null;
}

type Phase = 'idle' | 'locating' | 'submitting';

function getPosition(signal?: AbortSignal): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('UNSUPPORTED'));
      return;
    }
    let watchId: number | undefined;
    const clear = () => {
      if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      clear();
      reject(new DOMException('定位已取消', 'AbortError'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    watchId = navigator.geolocation.watchPosition((position) => {
      clear();
      resolve(position);
    }, (error) => {
      clear();
      reject(error);
    }, {
      enableHighAccuracy: true,
      timeout: 10_000,
      maximumAge: 0,
    });
  });
}

function geoErrorMessage(error: unknown, policy?: string): string {
  const code = (error as { code?: number } | null)?.code;
  const next = policy === 'GEO_OR_QR'
    ? '也可扫描现场活动码。'
    : '仍需完成本活动的定位核验；无法定位时请联系现场工作人员。';
  if (code === 1) return `定位权限被拒绝：请在浏览器地址栏允许位置访问。${next}`;
  if (code === 2) return `当前位置不可用：请到开阔位置重试。${next}`;
  if (code === 3) return `定位超时（10 秒）：请重试。${next}`;
  return `定位失败：请重试。${next}`;
}

export default function AttendancePanel() {
  const principal = usePrincipal();
  return (
    <MemberGate principal={principal}>
      {(principalId) => <AttendanceBody principalId={principalId} />}
    </MemberGate>
  );
}

function AttendanceBody({ principalId }: { principalId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const activityId = searchParams.get('id');
  const [phase, setPhase] = useState<Phase>('idle');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [result, setResult] = useState<CheckpointResult | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [manualCheckpoint, setManualCheckpoint] = useState<'IN' | 'OUT' | null>(null);
  const geoControllerRef = useRef<AbortController | null>(null);
  const pendingGeoRef = useRef<GeolocationPosition | null>(null);
  const pendingQrRef = useRef<string | null>(null);
  const queryClient = useQueryClient();

  // 页面 fragment #q=<token>：读取后立即清除（暂存待上下文就绪后提交）
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    if (hash === '') return;
    const token = new URLSearchParams(hash).get('q') ?? parseQrToken(hash);
    pendingQrRef.current = token;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  useEffect(() => {
    const stopDevices = () => {
      geoControllerRef.current?.abort();
      geoControllerRef.current = null;
      pendingGeoRef.current = null;
    };
    const onHidden = () => {
      if (document.visibilityState !== 'hidden') return;
      stopDevices();
      setScannerOpen(false);
      setPhase('idle');
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      stopDevices();
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [activityId]);

  useEffect(() => {
    setResult(null);
    setNotice(null);
    setManualCheckpoint(null);
    setScannerOpen(false);
    setPhase('idle');
  }, [activityId]);

  const optionsQuery = usePrivateQuery<{ openActivities: OpenActivityOption[] }, ApiError>(
    principalId,
    ['me', 'dashboard', 'attendance-options'],
    async () => (await api.get<{ openActivities: OpenActivityOption[] }>('/me/dashboard')).data,
    { enabled: activityId == null },
  );

  const contextQuery = usePrivateQuery<AttendanceContextDto, ApiError>(
    principalId,
    ['activities', 'attendance-context', activityId ?? 'none'],
    async () => (await api.get<AttendanceContextDto>(`/activities/${activityId}/attendance-context`)).data,
    { enabled: activityId != null, refetchInterval: 30_000 },
  );

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['principal', principalId, 'activities', 'attendance-context'],
    });
    void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me'] });
  }, [principalId, queryClient]);

  const autoCheckpoint = ((): 'IN' | 'OUT' | null => {
    const ctx = contextQuery.data;
    if (!ctx?.policy) return null;
    if (manualCheckpoint && ctx.policy.windowOpen[manualCheckpoint] &&
      (manualCheckpoint === 'IN' || ctx.policy.selfCheckout) &&
      !ctx.checkpoints.some((c) => c.checkpoint === manualCheckpoint)) return manualCheckpoint;
    const inRecorded = ctx.checkpoints.some((c) => c.checkpoint === 'IN');
    const outRecorded = ctx.checkpoints.some((c) => c.checkpoint === 'OUT');
    if (ctx.policy.windowOpen.IN && !inRecorded) return 'IN';
    if (ctx.policy.windowOpen.OUT && ctx.policy.selfCheckout && !outRecorded) return 'OUT';
    return null;
  })();

  const submitCheckpoint = useCallback(
    async (input: {
      checkpoint: 'IN' | 'OUT';
      method: 'GEO' | 'QR';
      geo?: { latitude: number; longitude: number; accuracyMeters: number; sampledAt: string };
      qrToken?: string;
    }) => {
      setPhase('submitting');
      setNotice(null);
      try {
        const challengeResponse = await api.post<{ challenge: string; expiresAt: string }>(
          `/activities/${activityId}/attendance/challenge`,
          { checkpoint: input.checkpoint },
        );
        const response = await api.post<CheckpointResult>(
          `/activities/${activityId}/attendance/checkpoints`,
          {
            challenge: challengeResponse.data.challenge,
            method: input.method,
            checkpoint: input.checkpoint,
            ...(input.geo ? { geo: input.geo } : {}),
            ...(input.qrToken ? { qrToken: input.qrToken } : {}),
            idempotencyKey: crypto.randomUUID(),
          },
        );
        setResult(response.data);
        refresh();
      } catch (error) {
        if (error instanceof ApiError && error.code === 'ALREADY_RECORDED') {
          const { data: latest } = await api.get<AttendanceContextDto>(
            `/activities/${activityId}/attendance-context`,
          ).catch(() => ({ data: null }));
          const existing = latest?.checkpoints.find((c) => c.checkpoint === input.checkpoint);
          if (latest && existing) {
            setResult({
              result: 'already_recorded',
              serverTime: latest.serverTime,
              acceptedAt: existing.acceptedAt,
              message: '该检查点此前已记录，不重复计时。',
              method: existing.method,
            });
            refresh();
            return;
          }
        }
        const message = error instanceof ApiError ? error.message : '提交失败，请重试。';
        setNotice({ tone: 'error', text: message });
      } finally {
        setPhase('idle');
      }
    },
    [activityId, refresh],
  );

  const runGeoFlow = useCallback(
    async (checkpoint: 'IN' | 'OUT', attachToQr = false) => {
      setPhase('locating');
      setNotice(null);
      const controller = new AbortController();
      geoControllerRef.current?.abort();
      geoControllerRef.current = controller;
      let position: GeolocationPosition | null = null;
      try {
        position = await getPosition(controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        setPhase('idle');
        setNotice({ tone: 'error', text: geoErrorMessage(error, contextQuery.data?.policy?.policy) });
        return;
      }
      if (controller.signal.aborted) return;
      const geo = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy,
        sampledAt: new Date(position.timestamp).toISOString(),
      };
      if (attachToQr) {
        pendingGeoRef.current = position;
        setPhase('idle');
        setNotice({ tone: 'info', text: '定位已采集，请继续扫描现场活动码完成双证据提交。' });
        setScannerOpen(true);
        return;
      }
      await submitCheckpoint({ checkpoint, method: 'GEO', geo });
    },
    [contextQuery.data?.policy?.policy, submitCheckpoint],
  );

  const onScannerToken = useCallback(
    async (token: string) => {
      setScannerOpen(false);
      const ctx = contextQuery.data;
      const checkpoint = autoCheckpoint ?? 'IN';
      const policy = ctx?.policy?.policy;
      let geo:
        | { latitude: number; longitude: number; accuracyMeters: number; sampledAt: string }
        | undefined;
      if (policy === 'GEO_AND_QR') {
        const pending = pendingGeoRef.current;
        if (pending) {
          geo = {
            latitude: pending.coords.latitude,
            longitude: pending.coords.longitude,
            accuracyMeters: pending.coords.accuracy,
            sampledAt: new Date(pending.timestamp).toISOString(),
          };
          pendingGeoRef.current = null;
        } else {
          const controller = new AbortController();
          geoControllerRef.current?.abort();
          geoControllerRef.current = controller;
          setPhase('locating');
          try {
            const position = await getPosition(controller.signal);
            if (controller.signal.aborted) return;
            geo = {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracyMeters: position.coords.accuracy,
              sampledAt: new Date(position.timestamp).toISOString(),
            };
          } catch (error) {
            if (controller.signal.aborted) return;
            setPhase('idle');
            setNotice({ tone: 'error', text: `${geoErrorMessage(error)}（双证据需要定位+活动码）` });
            return;
          }
        }
      }
      await submitCheckpoint({ checkpoint, method: 'QR', qrToken: token, geo });
    },
    [autoCheckpoint, contextQuery.data, submitCheckpoint],
  );

  // 深链 token（#q=…）进入后自动尝试扫码提交
  useEffect(() => {
    const pending = pendingQrRef.current;
    if (!pending || !activityId || phase !== 'idle' || !contextQuery.data) return;
    pendingQrRef.current = null;
    void onScannerToken(pending);
  }, [activityId, contextQuery.data, onScannerToken, phase]);

  if (!activityId) {
    const options = optionsQuery.data?.openActivities ?? [];
    return (
      <div className="flex flex-col gap-4">
        <PanelHeader title="签到与出勤" description="选择正在进行的活动完成签到/签退。" />
        {optionsQuery.isPending ? (
          <div className="flex flex-col gap-3">
            {[0, 1].map((index) => (
              <Skeleton key={index} className="h-24 rounded-2xl" />
            ))}
          </div>
        ) : optionsQuery.isError ? (
          <Card>
            <CardContent className="py-10">
              <ErrorBlock
                message={optionsQuery.error.message}
                onRetry={() => void optionsQuery.refetch()}
              />
            </CardContent>
          </Card>
        ) : options.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              当前没有进行中或两小时内开始的活动。
            </CardContent>
          </Card>
        ) : (
          <ul className="flex flex-col gap-3">
            {options.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  onClick={() => setSearchParams((previous) => {
                    const next = new URLSearchParams(previous);
                    next.set('section', 'attendance');
                    next.set('id', option.id);
                    return next;
                  })}
                  className="flex w-full flex-col gap-1 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/50"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{option.title}</span>
                    {option.required && <StatusBadge kind="registration" value="必到名单" />}
                    {option.checkedIn && !option.checkedOut && (
                      <StatusBadge kind="attendance" value="待签退" />
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatStartEnd(option.startAt, option.endAt)} ·{' '}
                    {option.venue
                      ? [option.venue.building, option.venue.room].filter(Boolean).join(' ') || '待公布'
                      : '待公布'}
                    {option.windowOpen === 'IN' ? ' · 签到窗口开放中' : ''}
                    {option.windowOpen === 'OUT' ? ' · 签退窗口开放中' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const ctx = contextQuery.data;
  const policy = ctx?.policy;

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader title="签到与出勤" description="定位或活动码核验到场；签退在活动结束后进行。" />

      {contextQuery.isPending && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-16 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
        </div>
      )}
      {contextQuery.isError && (
        <Card>
          <CardContent className="py-10">
            <ErrorBlock
              message={contextQuery.error.message}
              onRetry={() => void contextQuery.refetch()}
            />
          </CardContent>
        </Card>
      )}

      {ctx && (
        <>
          <Card>
            <CardContent className="flex flex-col gap-3 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-[15px] font-semibold text-foreground">{ctx.activity.title}</h2>
                  <p className="text-xs text-muted-foreground">
                    {formatStartEnd(ctx.activity.startAt, ctx.activity.endAt)} · 服务时间{' '}
                    {formatTime(ctx.serverTime)}
                  </p>
                </div>
                {ctx.eligibility.required && (
                  <StatusBadge kind="registration" value="必到名单" />
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {ctx.eligibility.registration && (
                  <StatusBadge
                    kind="registration"
                    value={
                      ctx.eligibility.registration.status === 'enrolled'
                        ? '已报名'
                        : ctx.eligibility.registration.status === 'waitlisted'
                          ? '候补中'
                          : ctx.eligibility.registration.status === 'pending_approval'
                            ? '待审核'
                            : '未报名'
                    }
                  />
                )}
                {(['IN', 'OUT'] as const).map((checkpoint) => {
                  const record = ctx.checkpoints.find((c) => c.checkpoint === checkpoint);
                  return (
                    <span key={checkpoint} className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">
                        {checkpoint === 'IN' ? '签到' : '签退'}
                      </span>
                      {record ? (
                        <>
                          <StatusBadge
                            kind="attendance"
                            value={checkpoint === 'OUT'
                              ? '签退已记录'
                              : record.method === 'QR' ? '二维码签到已记录' : '签到已记录'}
                          />
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {formatTime(record.acceptedAt)}
                          </span>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">未记录</span>
                      )}
                    </span>
                  );
                })}
              </div>
              {!ctx.eligibility.eligible && (
                <Alert variant="destructive">
                  <AlertTitle>暂无签到资格</AlertTitle>
                  <AlertDescription>
                    {ctx.eligibility.reason || '未报名且不在必到名单；报名确认后才可签到。'}
                  </AlertDescription>
                </Alert>
              )}
              {notice && (
                <Alert variant={notice.tone === 'error' ? 'destructive' : 'info'}>
                  <AlertTitle>{notice.tone === 'error' ? '未能完成' : '提示'}</AlertTitle>
                  <AlertDescription>{notice.text}</AlertDescription>
                </Alert>
              )}
              {result && <ResultCard result={result} policy={policy?.policy} />}
            </CardContent>
          </Card>

          {policy ? (
            <Card>
              <CardContent className="flex flex-col gap-4 p-5">
                {/* 检查点选择（IN/OUT 由窗口决定，双开时可切换） */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">检查点：</span>
                  {(['IN', 'OUT'] as const).map((checkpoint) => {
                    const open =
                      checkpoint === 'IN' ? policy.windowOpen.IN : policy.windowOpen.OUT;
                    const recorded = ctx.checkpoints.some((c) => c.checkpoint === checkpoint);
                    const active = autoCheckpoint === checkpoint;
                    return (
                      <Button
                        key={checkpoint}
                        type="button"
                        size="sm"
                        variant={active ? 'default' : 'outline'}
                        disabled={!open || recorded || (checkpoint === 'OUT' && !policy.selfCheckout)}
                        aria-pressed={active}
                        onClick={() => setManualCheckpoint(checkpoint)}
                      >
                        {checkpoint === 'IN' ? <DoorOpenIcon aria-hidden="true" /> : null}
                        {checkpoint === 'OUT' ? <CrosshairIcon aria-hidden="true" /> : null}
                        {checkpoint === 'IN' ? '签到 IN' : '签退 OUT'}
                        {!open && '（窗口未开）'}
                        {recorded && '（已记录）'}
                      </Button>
                    );
                  })}
                  <span className="text-xs text-muted-foreground">
                    {policyLabel(policy.policy)} · 定位精度阈值 ±{policy.maxAccuracyMeters} 米
                  </span>
                </div>

                {autoCheckpoint == null ? (
                  <p className="text-sm leading-[22px] text-muted-foreground">
                    {ctx.checkpoints.some((c) => c.checkpoint === 'IN') && !policy.selfCheckout
                      ? '签到已记录，签退由现场工作人员点验；请等待出勤认定。'
                      : '当前没有待完成的开放检查点。'}签到窗口{' '}
                    {formatStartEnd(policy.checkinOpenAt, policy.checkinCloseAt)}
                    {policy.checkoutOpenAt && policy.checkoutCloseAt
                      ? `；签退窗口 ${formatStartEnd(policy.checkoutOpenAt, policy.checkoutCloseAt)}`
                      : ''}
                    。
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-2">
                      {(policy.policy === 'GEO_ONLY' ||
                        policy.policy === 'GEO_OR_QR') && (
                        <Button
                          size="lg"
                          className="h-12 min-w-40"
                          disabled={!ctx.eligibility.eligible || phase !== 'idle'}
                          onClick={() => {
                            void runGeoFlow(autoCheckpoint);
                          }}
                        >
                          {phase === 'locating' ? (
                            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                          ) : (
                            <MapPinIcon aria-hidden="true" />
                          )}
                          {autoCheckpoint === 'IN' ? '定位签到' : '定位签退'}
                        </Button>
                      )}
                      {(policy.policy === 'QR_ONLY' ||
                        policy.policy === 'GEO_OR_QR') && (
                        <Button
                          size="lg"
                          variant="outline"
                          className="h-12 min-w-40"
                          disabled={!ctx.eligibility.eligible || phase !== 'idle'}
                          onClick={() => {
                            pendingGeoRef.current = null;
                            setScannerOpen(true);
                          }}
                        >
                          <QrCodeIcon aria-hidden="true" />
                          扫描活动码{autoCheckpoint === 'OUT' ? '签退' : '签到'}
                        </Button>
                      )}
                      {policy.policy === 'GEO_AND_QR' && (
                        <>
                          <Button
                            size="lg"
                            className="h-12 min-w-44"
                            disabled={!ctx.eligibility.eligible || phase !== 'idle'}
                            onClick={() => {
                              void runGeoFlow(autoCheckpoint, true);
                            }}
                          >
                            {phase === 'locating' ? (
                              <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                            ) : (
                              <MapPinIcon aria-hidden="true" />
                            )}
                            定位后扫码（双证据）
                          </Button>
                          <Button
                            size="lg"
                            variant="outline"
                            className="h-12"
                            disabled={!ctx.eligibility.eligible || phase !== 'idle'}
                            onClick={() => {
                              pendingGeoRef.current = null;
                              setScannerOpen(true);
                            }}
                          >
                            <QrCodeIcon aria-hidden="true" />
                            先扫码后定位
                          </Button>
                        </>
                      )}
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {policy.policy === 'QR_ONLY'
                        ? '本活动仅支持现场活动码；二维码签到不经过地理围栏核验。'
                        : policy.policy === 'GEO_AND_QR'
                          ? '本活动要求定位与活动码双证据：先完成定位再扫码，一次提交。'
                        : policy.policy === 'GEO_ONLY'
                          ? '本活动仅支持定位：请在现场围栏内打开定位完成核验。'
                          : '在现场（围栏内）打开定位即可；也可以扫描现场屏幕上的活动码。'}
                    </p>
                  </div>
                )}

                <div className="flex flex-col gap-2 border-t border-border pt-3">
                  <h3 className="text-sm font-semibold text-foreground">签到地点</h3>
                  <ul className="flex flex-col gap-2">
                    {ctx.venues.map((venue) => (
                      <li key={venue.venueVersionId} className="text-sm">
                        <span className="text-foreground">
                          {[venue.name, venue.building, venue.room].filter(Boolean).join(' ')}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          支持能力 {venue.allowedCapabilities.join(' / ')}
                          {venue.hasCoordinates ? ' · 已核验围栏' : ''}
                        </span>
                        {venue.directions && (
                          <p className="text-xs leading-5 text-muted-foreground">
                            路线：{venue.directions}
                          </p>
                        )}
                      </li>
                    ))}
                    {ctx.venues.length === 0 && (
                      <li className="text-sm text-muted-foreground">地点待公布。</li>
                    )}
                  </ul>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                本活动未配置现场签到策略，无需签到。
              </CardContent>
            </Card>
          )}
        </>
      )}

      <Drawer open={scannerOpen} onOpenChange={setScannerOpen}>
        <DrawerContent className="md:max-w-md">
          <DrawerHeader className="sr-only">
            <DrawerTitle>扫描活动码</DrawerTitle>
            <DrawerDescription>对准现场屏幕上的黑白活动码</DrawerDescription>
          </DrawerHeader>
          <Suspense
            fallback={
              <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
                正在加载扫码组件…
              </div>
            }
          >
            <QrScanner
              onToken={(token) => {
                void onScannerToken(token);
              }}
              onCameraError={(message) => setNotice({ tone: 'info', text: message })}
            />
          </Suspense>
        </DrawerContent>
      </Drawer>
    </div>
  );
}

function ResultCard({
  result,
  policy,
}: {
  result: CheckpointResult;
  policy: string | null | undefined;
}) {
  const tone =
    result.result === 'accepted'
      ? 'border-success-subtle bg-success-subtle/60'
      : result.result === 'pending_review'
        ? 'border-warning-subtle bg-warning-subtle/60'
        : result.result === 'already_recorded'
          ? 'border-border bg-muted/50'
          : 'border-destructive-subtle bg-destructive-subtle/60';
  const title =
    result.result === 'accepted'
      ? policy === 'QR_ONLY' && result.method === 'QR'
        ? '二维码签到已记录'
        : result.message
      : result.result === 'pending_review'
        ? '待人工复核'
        : result.result === 'already_recorded'
          ? '此前已记录'
          : '本次未通过核验';
  return (
    <div
      role="status"
      className={`flex flex-col gap-1 rounded-xl border p-4 ${tone}`}
      aria-live="polite"
    >
      <p className="text-sm font-semibold text-foreground">
        {result.result === 'accepted' && policy === 'QR_ONLY' && result.method === 'QR'
          ? '二维码签到已记录'
          : title}
      </p>
      <p className="text-sm leading-[22px] text-foreground/90">
        {result.result === 'accepted' && policy === 'QR_ONLY' && result.method === 'QR'
          ? '活动结束后请按现场安排签退。'
          : result.message}
      </p>
      {result.nextStep && (
        <p className="text-xs leading-5 text-muted-foreground">下一步：{result.nextStep}</p>
      )}
      <p className="text-xs text-muted-foreground tabular-nums">
        记录时间 {result.acceptedAt ? formatTime(result.acceptedAt) : formatTime(result.serverTime)}
      </p>
    </div>
  );
}

function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <p className="text-sm font-medium text-foreground">签到上下文加载失败</p>
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}
