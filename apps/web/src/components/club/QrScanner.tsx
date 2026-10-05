/** 相机扫码取景器：原生 BarcodeDetector 优先，按需加载 jsQR 解码回退。 */
import { useEffect, useRef, useState } from 'react';

import { parseQrToken } from '@/lib/qr';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

export interface QrScannerProps {
  onToken: (token: string) => void;
  onCameraError?: (message: string) => void;
  purpose?: 'attendance' | 'invitation';
  /** 解析扫码原文；返回 null 时留在取景器并显示说明。 */
  parseValue?: (raw: string) => string | null;
}

export default function QrScanner({ onToken, onCameraError, purpose = 'attendance', parseValue = parseQrToken }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const stopCameraRef = useRef<() => void>(() => undefined);
  const detectedRef = useRef(false);
  const callbacks = useRef({ onToken, onCameraError, parseValue, purpose });
  callbacks.current = { onToken, onCameraError, parseValue, purpose };
  const [mode, setMode] = useState<'starting' | 'scanning' | 'manual' | 'denied'>('starting');
  const [manualValue, setManualValue] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const invitation = purpose === 'invitation';
  const codeLabel = invitation ? '邀请码' : '活动码';

  useEffect(() => {
    let cancelled = false;
    let decoding = false;
    const stopCamera = () => {
      if (timerRef.current != null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.srcObject = null;
      }
    };
    stopCameraRef.current = stopCamera;
    const cameraError = (message: string, denied = false) => {
      if (cancelled) return;
      stopCamera();
      setMode(denied ? 'denied' : 'manual');
      setNotice(message);
      callbacks.current.onCameraError?.(message);
    };
    const label = callbacks.current.purpose === 'invitation' ? '邀请码' : '活动码';
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraError(`当前浏览器无法调用相机，请手动输入${label}。`);
      return;
    }

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) { stopCamera(); return; }
        video.srcObject = stream;
        await video.play();
        if (cancelled) { stopCamera(); return; }

        let detector: BarcodeDetectorLike | null = null;
        const detectorCtor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
        if (typeof detectorCtor === 'function') {
          try { detector = new detectorCtor({ formats: ['qr_code'] }); } catch { /* 采用解码回退 */ }
        }
        const jsQr = detector ? null : (await import('jsqr')).default;
        if (cancelled) { stopCamera(); return; }
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!detector && (!jsQr || !context)) throw new Error('QR decoder unavailable');
        setMode('scanning');
        timerRef.current = window.setInterval(async () => {
          const el = videoRef.current;
          if (cancelled || decoding || !el || detectedRef.current || el.readyState < 2) return;
          decoding = true;
          try {
            let raw: string | undefined;
            if (detector) {
              raw = (await detector.detect(el))[0]?.rawValue;
            } else if (jsQr && context && el.videoWidth && el.videoHeight) {
              const scale = Math.min(1, 640 / Math.max(el.videoWidth, el.videoHeight));
              canvas.width = Math.max(1, Math.round(el.videoWidth * scale));
              canvas.height = Math.max(1, Math.round(el.videoHeight * scale));
              context.drawImage(el, 0, 0, canvas.width, canvas.height);
              const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
              raw = jsQr(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })?.data;
            }
            if (cancelled || !raw) return;
            const token = callbacks.current.parseValue(raw);
            if (!token) {
              setNotice(callbacks.current.purpose === 'invitation'
                ? '这不是本站邀请二维码，请对准协会提供的邀请二维码，或手动输入邀请码。'
                : '未识别为活动码，请对准现场活动二维码。');
              return;
            }
            detectedRef.current = true;
            stopCamera();
            callbacks.current.onToken(token);
          } catch { /* 单帧识别失败时继续扫描，不记录敏感二维码内容。 */ }
          finally { decoding = false; }
        }, 350);
      } catch (cause) {
        const name = (cause as { name?: string })?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          cameraError(`相机权限被拒绝。可允许相机后重新扫码，或手动输入${label}。`, true);
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          cameraError(`未找到可用相机，请手动输入${label}。`);
        } else {
          cameraError(`相机暂时无法启动，请重新打开扫码或手动输入${label}。`);
        }
      }
    }
    const onVisibility = () => {
      if (document.hidden) {
        cancelled = true;
        stopCamera();
        setMode('manual');
        setNotice(`相机已暂停。请重新打开扫码，或手动输入${label}。`);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    void start();
    return () => {
      cancelled = true;
      stopCamera();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const submitManual = () => {
    const token = callbacks.current.parseValue(manualValue);
    if (!token) {
      setNotice(invitation ? '请输入有效的 12 位邀请码或本站邀请链接。' : '请输入有效的活动码。');
      return;
    }
    detectedRef.current = true;
    stopCameraRef.current();
    callbacks.current.onToken(token);
  };

  const manualInput = (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Input
        value={manualValue}
        onChange={(event) => setManualValue(event.target.value)}
        aria-label={`手动输入${codeLabel}`}
        placeholder={invitation ? '粘贴邀请码或本站邀请链接' : '粘贴活动码（club://att#… 或裸码）'}
        autoComplete="off"
        spellCheck={false}
      />
      <Button type="button" variant="outline" onClick={submitManual} disabled={!manualValue.trim()}>
        {invitation ? '确认邀请码' : '提交'}
      </Button>
    </div>
  );

  if (mode === 'manual' || mode === 'denied') {
    return <div className="flex flex-col gap-3 p-4">
      <p role="status" className="text-sm leading-[22px] text-muted-foreground">{notice ?? `请手动输入${codeLabel}。`}</p>
      {manualInput}
    </div>;
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="relative mx-auto aspect-square w-full max-w-[320px] overflow-hidden rounded-2xl bg-neutral-950">
        <video ref={videoRef} className="size-full object-cover" playsInline muted autoPlay aria-label={invitation ? '邀请码扫码取景器' : '扫码取景器'} />
        {['left-3 top-3 border-l-2 border-t-2 rounded-tl-lg', 'right-3 top-3 border-r-2 border-t-2 rounded-tr-lg', 'left-3 bottom-3 border-l-2 border-b-2 rounded-bl-lg', 'right-3 bottom-3 border-r-2 border-b-2 rounded-br-lg'].map(cls => (
          <span key={cls} aria-hidden="true" className={`pointer-events-none absolute size-8 border-white/90 ${cls}`} />
        ))}
        {mode === 'starting' && <div role="status" className="absolute inset-0 flex items-center justify-center bg-neutral-950/70 text-sm text-white/80">正在启动相机…</div>}
      </div>
      <p className="text-center text-sm text-muted-foreground">{invitation ? '对准协会邀请二维码，识别后自动验证邀请码。' : '对准现场屏幕上的黑白活动码；识别成功会自动提交。'}</p>
      {notice && <p role="alert" className="text-sm leading-6 text-destructive">{notice}</p>}
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer select-none">无法扫码？手动输入{codeLabel}</summary>
        <div className="mt-2">{manualInput}</div>
      </details>
    </div>
  );
}
