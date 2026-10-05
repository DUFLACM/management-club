import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, CheckIcon, ExpandIcon, LoaderCircleIcon, MinimizeIcon, RefreshCwIcon, ScanLineIcon } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrivateQuery } from '@/lib/query';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

interface BoardActivity {
  id: string;
  title: string;
  endAt: string;
  policy: {
    checkinOpenAt: string;
    checkinCloseAt: string;
    checkoutOpenAt: string | null;
    checkoutCloseAt: string | null;
  } | null;
  venueBindings: Array<{
    venueVersionId: string;
    venueVersion: { building: string | null; room: string | null; venue: { name: string } };
  }>;
}

interface BoardAttendance {
  checkedIn: number;
  checkedOut: number;
  recentCheckins: Array<{ userId: string; name: string; acceptedAt: string }>;
  updatedAt: string;
}

interface BoardQr { dataUrl: string; expiresAt: string; rotateSeconds: number }

const timeFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' });
const controlClass = 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100 hover:text-slate-900';

export function AttendanceQrBoard({ activity, principalId, wasFullscreen, onClose }: {
  activity: BoardActivity;
  principalId: string;
  wasFullscreen: boolean;
  onClose: () => void;
}) {
  const [venueVersionId, setVenueVersionId] = useState(activity.venueBindings[0]?.venueVersionId ?? '');
  const [checkpoint, setCheckpoint] = useState<'IN' | 'OUT'>('IN');
  const [qr, setQr] = useState<(BoardQr & { venueVersionId: string; checkpoint: 'IN' | 'OUT' }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [online, setOnline] = useState(navigator.onLine);
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const closeAt = checkpoint === 'IN' ? activity.policy?.checkinCloseAt : activity.policy?.checkoutCloseAt;
  const openAt = checkpoint === 'IN' ? activity.policy?.checkinOpenAt : activity.policy?.checkoutOpenAt;
  const windowClosed = !closeAt || now >= new Date(closeAt).getTime();
  const windowPending = Boolean(openAt && now < new Date(openAt).getTime());
  const canIssue = Boolean(venueVersionId) && !windowClosed && !windowPending && online;

  const attendance = usePrivateQuery<BoardAttendance>(
    principalId, ['admin', 'activities', 'board', activity.id],
    async () => (await api.get<BoardAttendance>(`/admin/activities/${activity.id}/attendance/board`)).data,
    { staleTime: 0, refetchInterval: 3000, refetchOnWindowFocus: true, retry: false },
  );

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const networkChanged = () => { setOnline(navigator.onLine); setNow(Date.now()); };
    const fullscreenChanged = () => setFullscreen(Boolean(document.fullscreenElement));
    window.addEventListener('online', networkChanged);
    window.addEventListener('offline', networkChanged);
    document.addEventListener('fullscreenchange', fullscreenChanged);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener('online', networkChanged);
      window.removeEventListener('offline', networkChanged);
      document.removeEventListener('fullscreenchange', fullscreenChanged);
      if (!wasFullscreen && document.fullscreenElement === document.documentElement) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, [wasFullscreen]);

  // 切换地点/检查点、关屏或窗口到期后，忽略仍在途中的旧响应。
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    setQr(null);
    setError(null);
    const version = ++requestVersion.current;
    if (!canIssue) return;
    const issue = async () => {
      let nextDelay = 5000;
      try {
        const { data } = await api.post<BoardQr>(`/admin/activities/${activity.id}/attendance/qr`, { venueVersionId, checkpoint });
        if (cancelled || requestVersion.current !== version) return;
        const remaining = new Date(data.expiresAt).getTime() - Date.now();
        if (remaining <= 0) throw new Error('现场码已过期，正在重新签发');
        setQr({ ...data, venueVersionId, checkpoint });
        setNow(Date.now());
        setError(null);
        // 短 TTL 也在过期前换码；后续轮询等待本次请求完成，避免请求重叠。
        nextDelay = Math.max(1000, Math.min(data.rotateSeconds * 1000, remaining - 2000));
      } catch (cause) {
        if (cancelled || requestVersion.current !== version) return;
        setQr(null);
        setError(cause instanceof Error ? cause.message : '现场码获取失败');
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) return;
      }
      if (!cancelled) timer = window.setTimeout(issue, nextDelay);
    };
    void issue();
    return () => { cancelled = true; requestVersion.current += 1; window.clearTimeout(timer); };
  }, [activity.id, canIssue, checkpoint, venueVersionId]);

  const close = useCallback(() => {
    if (!wasFullscreen && document.fullscreenElement === document.documentElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
    onClose();
  }, [onClose, wasFullscreen]);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      setFullscreenError(null);
    } catch {
      setFullscreenError('浏览器暂不支持全屏，可继续使用当前大屏。');
    }
  };

  const countdown = qr ? Math.max(0, Math.ceil((new Date(qr.expiresAt).getTime() - now) / 1000)) : 0;
  const visibleQr = canIssue && qr && qr.venueVersionId === venueVersionId && qr.checkpoint === checkpoint && countdown > 0;
  const venue = activity.venueBindings.find(item => item.venueVersionId === venueVersionId)?.venueVersion;
  const syncStale = !online || attendance.isError || Boolean(attendance.data && now - attendance.dataUpdatedAt > 10_000);
  const attendanceError = !online
    ? '网络连接已断开，恢复后自动更新'
    : attendance.error?.status === 403
      ? '当前账号没有查看签到名单的权限'
      : attendance.error?.status === 404
        ? '签到名单服务暂不可用，请稍后重试'
        : '签到名单加载失败，正在自动重试';
  const clock = new Date(now);

  return (
    <Dialog open onOpenChange={open => { if (!open) close(); }}>
      <DialogContent
        data-slot="attendance-qr-board"
        showCloseButton={false}
        className="qr-board fixed inset-0 z-[70] flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 text-slate-900"
      >
        <header className="relative flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-8 sm:py-5">
          <Button variant="outline" className={controlClass} onClick={close}>
            <ArrowLeftIcon aria-hidden="true" />返回上一级
          </Button>
          <div className="hidden items-center gap-2 text-sm text-slate-600 sm:flex">
            <ScanLineIcon className="size-4 text-blue-700" aria-hidden="true" />活动签到现场
          </div>
          <Button variant="outline" className={controlClass} onClick={() => void toggleFullscreen()}>
            {fullscreen ? <MinimizeIcon aria-hidden="true" /> : <ExpandIcon aria-hidden="true" />}
            {fullscreen ? '退出全屏' : '进入全屏'}
          </Button>
        </header>

        <main className="qr-board-main relative mx-auto grid w-full max-w-[1600px] flex-1 gap-6 p-4 sm:p-8 lg:min-h-0 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)] lg:gap-10 lg:px-12">
          <section className="flex min-w-0 flex-col items-center justify-center gap-5 text-center">
            <div className="max-w-full">
              <DialogTitle className="text-2xl leading-tight font-semibold text-slate-900 sm:text-3xl xl:text-4xl">{activity.title}</DialogTitle>
              <DialogDescription className="mt-3 text-slate-600">
                {venue ? [venue.venue.name, venue.building, venue.room].filter(Boolean).join(' · ') : '未绑定地点'}
                {' · '}{checkpoint === 'IN' ? '扫码签到' : '扫码签退'}
              </DialogDescription>
            </div>

            <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
              <div className="flex rounded-xl border border-slate-300 bg-white p-1" aria-label="检查点">
                {(['IN', 'OUT'] as const).map(value => (
                  <button key={value} type="button" aria-pressed={checkpoint === value} onClick={() => setCheckpoint(value)} className={`rounded-lg px-5 py-2 text-sm font-medium transition-colors ${checkpoint === value ? 'bg-blue-700 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                    {value === 'IN' ? '签到 IN' : '签退 OUT'}
                  </button>
                ))}
              </div>
              {activity.venueBindings.length > 1 && (
                <select aria-label="签到地点" className="h-11 max-w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900" value={venueVersionId} onChange={event => setVenueVersionId(event.target.value)}>
                  {activity.venueBindings.map(option => <option key={option.venueVersionId} value={option.venueVersionId}>{option.venueVersion.venue.name} {option.venueVersion.room}</option>)}
                </select>
              )}
            </div>

            <div className="qr-board-code-frame">
              <div className="qr-board-code flex items-center justify-center rounded-lg bg-white p-3 text-slate-800 sm:p-4">
                {visibleQr ? (
                  <img src={qr.dataUrl} alt="现场活动码" width={512} height={512} className="size-full object-contain" />
                ) : (
                  <div className="flex flex-col items-center gap-4 px-4 text-sm leading-6" role="status">
                    {windowClosed ? <ScanLineIcon className="size-10 text-slate-500" aria-hidden="true" /> : <LoaderCircleIcon className={`size-8 text-blue-700 ${online ? 'animate-spin' : ''}`} aria-hidden="true" />}
                    <p>{!online ? '网络已断开，恢复后自动更新' : windowClosed ? (closeAt ? '当前签到窗口已结束' : '尚未配置此检查点窗口') : windowPending ? `窗口将于 ${formatDateTime(openAt!)} 开放` : error ?? '正在签发现场码…'}</p>
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-base font-medium text-slate-900 sm:text-lg">{checkpoint === 'IN' ? '打开成员工作台，扫描二维码签到' : '打开成员工作台，扫描二维码签退'}</p>
              <p className="text-sm text-slate-500 tabular-nums">{visibleQr ? `有效期剩余 ${countdown} 秒 · 现场码自动更新` : '请以现场工作人员的安排为准'}</p>
            </div>
          </section>

          <aside className="flex min-h-0 min-w-0 flex-col gap-5">
            <div className="text-center lg:text-right">
              <time dateTime={clock.toISOString()} className="qr-board-clock block font-medium tracking-tight tabular-nums">{timeFormatter.format(clock)}</time>
              <p className="mt-2 text-sm tracking-wider text-slate-500">{dateFormatter.format(clock)} · 北京时间</p>
            </div>
            <div className="grid grid-cols-2 gap-3" aria-label="现场出勤统计">
              <div className="rounded-lg border border-slate-200 bg-white p-5">
                <p className="text-sm text-slate-600">已签到</p>
                <p className="mt-3 text-4xl font-semibold text-blue-700 tabular-nums xl:text-5xl" data-slot="board-checked-in">{attendance.data?.checkedIn ?? '—'}<span className="ml-2 text-sm font-normal text-slate-500">人</span></p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-5">
                <p className="text-sm text-slate-600">已签退</p>
                <p className="mt-3 text-4xl font-semibold text-slate-900 tabular-nums xl:text-5xl" data-slot="board-checked-out">{attendance.data?.checkedOut ?? '—'}<span className="ml-2 text-sm font-normal text-slate-500">人</span></p>
              </div>
            </div>
            <section className="flex min-h-0 flex-1 flex-col rounded-lg border border-slate-200 bg-white" aria-label="已签到成员">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-4">
                <h2 className="text-base font-medium">已签到成员 <span className="ml-1 text-xs font-normal text-slate-500">最近 24 位</span></h2>
                <span className={`flex items-center gap-2 text-xs ${syncStale ? 'text-amber-700' : 'text-blue-700'}`} role="status"><span className={`size-1.5 rounded-full ${syncStale ? 'bg-amber-600' : 'bg-blue-700'}`} />{syncStale ? '更新暂停' : attendance.isPending ? '正在连接' : '每 3 秒更新'}</span>
              </div>
              <div className="qr-board-members min-h-0 flex-1 overflow-y-auto p-3">
                {attendance.data?.recentCheckins.length ? (
                  <ul className="divide-y divide-slate-100">
                    {attendance.data.recentCheckins.map(member => (
                      <li key={member.userId} className="flex items-center gap-3 px-2 py-3.5">
                        <CheckIcon className="size-4 shrink-0 text-blue-700" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-base text-slate-900">{member.name}</span>
                        <time dateTime={member.acceptedAt} className="shrink-0 text-sm text-slate-500 tabular-nums">{timeFormatter.format(new Date(member.acceptedAt))}</time>
                      </li>
                    ))}
                  </ul>
                ) : <p className="px-3 py-10 text-center text-sm text-slate-500" role={attendance.isError ? 'alert' : undefined}>{!online ? attendanceError : attendance.isPending ? '正在加载签到名单…' : attendance.isError ? attendanceError : '等待第一位成员签到'}</p>}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-5 py-3 text-xs text-slate-500">
                <span>{!online ? '网络恢复后自动重试' : attendance.isError ? attendanceError : syncStale ? '正在重新获取签到记录' : attendance.data ? `更新于 ${timeFormatter.format(new Date(attendance.data.updatedAt))}` : '正在获取现场记录'}</span>
                <button type="button" className="flex items-center gap-1.5 text-slate-600 hover:text-slate-900 disabled:opacity-50" disabled={attendance.isFetching || !online} onClick={() => void attendance.refetch()}><RefreshCwIcon className={`size-3.5 ${attendance.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />刷新名单</button>
              </div>
            </section>
          </aside>
        </main>
        {fullscreenError && <p role="status" className="relative px-4 pb-3 text-center text-xs text-amber-700">{fullscreenError}</p>}
      </DialogContent>
    </Dialog>
  );
}
