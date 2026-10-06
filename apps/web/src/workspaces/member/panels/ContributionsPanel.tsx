/**
 * 成员端 · 贡献申报（原「竞赛与贡献」的 claims 子页，已拆为独立 section）。
 * 类别卡片 → 申报表单；提交后进入人工审核队列，通过后按规则计入贡献类积分。
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileSignatureIcon, ImagePlusIcon, LoaderCircleIcon, XIcon } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { usePrincipal } from '@/lib/session';
import { CLAIM_CATEGORIES } from '@/lib/format';
import { PanelHeader } from '@/components/club/PanelHeader';
import { MemberGate } from '@/components/club/QueryBoundary';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/** 佐证图：与后端 /me/claim-evidence 的白名单和体积上限保持一致 */
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_ACCEPT = ['image/jpeg', 'image/png', 'image/webp'];

interface EvidenceImage {
  localId: string;
  fileName: string;
  /** 本地预览用的 object URL，卸载时需释放 */
  previewUrl: string;
  assetId: string | null;
  status: 'uploading' | 'ready' | 'failed';
  error?: string;
}

export default function ContributionsPanel() {
  const principal = usePrincipal();
  return (
    <MemberGate principal={principal}>
      {(principalId) => <ContributionsBody principalId={principalId} />}
    </MemberGate>
  );
}

function ContributionsBody({ principalId }: { principalId: string }) {
  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="贡献申报"
        description="讲题、题解、出题与服务工作的成果申报，经审核后计入贡献类积分。"
      />
      <ClaimForm principalId={principalId} />
    </div>
  );
}

function ClaimForm({ principalId }: { principalId: string }) {
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [evidenceNote, setEvidenceNote] = useState('');
  const [images, setImages] = useState<EvidenceImage[]>([]);

  // 卸载时释放预览 URL（提交成功后的清理在 onSuccess 里单独做）
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(
    () => () => {
      for (const item of imagesRef.current) URL.revokeObjectURL(item.previewUrl);
    },
    [],
  );

  const uploading = images.some((item) => item.status === 'uploading');
  const readyAssetIds = images
    .filter((item) => item.status === 'ready' && item.assetId != null)
    .map((item) => item.assetId as string);

  const mutation = useMutation({
    mutationFn: async (input: {
      category: string;
      title: string;
      description: string;
      evidenceNote?: string;
      evidenceAssetIds?: string[];
    }) => (await api.post<{ claimId: string }>('/me/claims', input)).data,
    onSuccess: () => {
      setCategory(null);
      setTitle('');
      setDescription('');
      setEvidenceNote('');
      for (const item of images) URL.revokeObjectURL(item.previewUrl);
      setImages([]);
      void queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me'] });
    },
  });

  if (category == null) {
    return (
      <div className="flex flex-col gap-4">
        <Alert>
          <AlertTitle>选择申报类别</AlertTitle>
          <AlertDescription>
            一次申报对应一项成果；审核通过后分数计入积分流水，可在「积分」查看。
          </AlertDescription>
        </Alert>
        {mutation.isSuccess && (
          <Alert>
            <AlertTitle>已提交</AlertTitle>
            <AlertDescription>
              申报已进入审核队列，审核通过后按规则计入贡献类积分。
            </AlertDescription>
          </Alert>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {CLAIM_CATEGORIES.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setCategory(item.value)}
              className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-5 text-left transition-colors hover:border-primary/50"
            >
              <FileSignatureIcon className="size-5 text-input" aria-hidden="true" />
              <span className="text-sm font-semibold text-foreground">{item.title}</span>
              <span className="text-xs leading-5 text-muted-foreground">{item.description}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const meta = CLAIM_CATEGORIES.find((item) => item.value === category);
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">
            贡献申报 · {meta?.title ?? category}
          </h2>
          <Button size="sm" variant="ghost" onClick={() => setCategory(null)}>
            返回类别
          </Button>
        </div>
        {mutation.isError && (
          <Alert variant="destructive">
            <AlertTitle>提交失败</AlertTitle>
            <AlertDescription>{(mutation.error as ApiError).message}</AlertDescription>
          </Alert>
        )}
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate({
              category,
              title: title.trim(),
              description: description.trim(),
              evidenceNote: evidenceNote.trim() || undefined,
              evidenceAssetIds: readyAssetIds.length > 0 ? readyAssetIds : undefined,
            });
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="claim-title">标题（2-120 字）</Label>
            <Input
              id="claim-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              minLength={2}
              maxLength={120}
              placeholder="如：10-12 例会讲题 CF1234E"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="claim-desc">说明（5-2000 字）</Label>
            <Textarea
              id="claim-desc"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              required
              minLength={5}
              maxLength={2000}
              rows={5}
              placeholder="做了什么、在哪可以看到、涉及哪场比赛或活动"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="claim-evidence">佐证说明（可选）</Label>
            <Input
              id="claim-evidence"
              value={evidenceNote}
              onChange={(event) => setEvidenceNote(event.target.value)}
              maxLength={500}
              placeholder="如博客链接、仓库链接"
            />
          </div>
          <EvidencePicker images={images} setImages={setImages} disabled={mutation.isPending} />
          <Button
            type="submit"
            disabled={
              mutation.isPending
              || uploading
              || title.trim().length < 2
              || description.trim().length < 5
            }
          >
            {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
            {uploading ? '佐证图上传中…' : '提交申报'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * 佐证图选择器：选图后立即上传换取 assetId，提交申报时只带 ID。
 * 服务端会重编码为 WebP 并剥除 EXIF/GPS，截图里的定位信息不会留存。
 */
function EvidencePicker({
  images,
  setImages,
  disabled,
}: {
  images: EvidenceImage[];
  setImages: React.Dispatch<React.SetStateAction<EvidenceImage[]>>;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [skipped, setSkipped] = useState<string[]>([]);

  const handleFiles = (fileList: FileList | null) => {
    if (fileList == null || fileList.length === 0) return;
    const rejected: string[] = [];
    const accepted: File[] = [];
    let room = MAX_IMAGES - images.length;
    for (const file of Array.from(fileList)) {
      if (room <= 0) rejected.push(`${file.name}（最多 ${MAX_IMAGES} 张）`);
      else if (!IMAGE_ACCEPT.includes(file.type)) rejected.push(`${file.name}（仅支持 JPG / PNG / WebP）`);
      else if (file.size > MAX_IMAGE_BYTES) rejected.push(`${file.name}（超过 5 MiB）`);
      else {
        accepted.push(file);
        room -= 1;
      }
    }
    setSkipped(rejected);

    for (const file of accepted) {
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const previewUrl = URL.createObjectURL(file);
      setImages((previous) => [
        ...previous,
        { localId, fileName: file.name, previewUrl, assetId: null, status: 'uploading' },
      ]);
      void (async () => {
        const form = new FormData();
        form.append('file', file);
        try {
          const { data } = await api.upload<{ assetId: string }>('/me/claim-evidence', form);
          setImages((previous) =>
            previous.map((item) =>
              item.localId === localId ? { ...item, assetId: data.assetId, status: 'ready' } : item,
            ),
          );
        } catch (error) {
          setImages((previous) =>
            previous.map((item) =>
              item.localId === localId
                ? {
                  ...item,
                  status: 'failed',
                  error: error instanceof ApiError ? error.message : '上传失败，请重试',
                }
                : item,
            ),
          );
        }
      })();
    }
    // 允许再次选择同一张图
    if (inputRef.current) inputRef.current.value = '';
  };

  const removeImage = (localId: string) => {
    setImages((previous) => {
      const target = previous.find((item) => item.localId === localId);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return previous.filter((item) => item.localId !== localId);
    });
  };

  return (
    <div className="grid gap-2">
      <Label htmlFor="claim-evidence-images">佐证图片（可选，最多 {MAX_IMAGES} 张）</Label>
      <input
        ref={inputRef}
        id="claim-evidence-images"
        type="file"
        accept={IMAGE_ACCEPT.join(',')}
        multiple
        className="sr-only"
        disabled={disabled || images.length >= MAX_IMAGES}
        onChange={(event) => handleFiles(event.target.files)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || images.length >= MAX_IMAGES}
          onClick={() => inputRef.current?.click()}
        >
          <ImagePlusIcon aria-hidden="true" />
          选择图片
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">
          {images.length}/{MAX_IMAGES} · 单张不超过 5 MiB
        </span>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        支持 JPG / PNG / WebP，如讲题现场照、题解页面截图。图片会重新编码并剥除 EXIF/GPS 等位置信息，仅本人与审核方可查看。
      </p>

      {skipped.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>部分图片未加入</AlertTitle>
          <AlertDescription>{skipped.join('；')}</AlertDescription>
        </Alert>
      )}

      {images.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
          {images.map((item) => (
            <li key={item.localId} className="relative">
              <span className="block aspect-square overflow-hidden rounded-xl border border-border bg-muted">
                <img
                  src={item.previewUrl}
                  alt={item.fileName}
                  className="size-full object-cover"
                />
              </span>
              {item.status !== 'ready' && (
                <span
                  className="absolute inset-0 flex items-center justify-center rounded-xl bg-background/70 text-xs font-medium"
                  role="status"
                >
                  {item.status === 'uploading' ? (
                    <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <span className="px-1 text-center text-destructive">上传失败</span>
                  )}
                </span>
              )}
              <button
                type="button"
                onClick={() => removeImage(item.localId)}
                disabled={disabled}
                aria-label={`移除 ${item.fileName}`}
                className="absolute -top-1.5 -right-1.5 flex size-7 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <XIcon className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {images.some((item) => item.status === 'failed') && (
        <p className="text-xs text-destructive">
          失败的图片不会随申报提交，请移除后重试。
        </p>
      )}
    </div>
  );
}
