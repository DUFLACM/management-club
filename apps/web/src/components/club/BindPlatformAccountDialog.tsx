import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpenIcon, ChevronDownIcon, LoaderCircleIcon } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownView } from '@/components/club/MarkdownView';
import { cn } from '@/lib/utils';
import bindingGuide from '@/content/platform-binding-guide.md?raw';

interface BindPlatformAccountDialogProps {
  principalId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  /** 预选平台（如从平台赛报名入口打开） */
  defaultPlatform?: string;
}

/** 提交绑定申请；成功后刷新「我的平台账号」与概览缓存（弹窗与登录绑定门共用） */
export function useBindPlatformAccount(principalId: string, onSuccess?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { platform: string; externalId: string; proofNote: string }) =>
      (await api.post<{ accountId: string }>('/me/platform-accounts', input)).data,
    onSuccess: async () => {
      onSuccess?.();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me', 'platform-accounts'] }),
        queryClient.invalidateQueries({ queryKey: ['principal', principalId, 'me', 'dashboard'] }),
      ]);
    },
  });
}

export function BindPlatformAccountDialog({
  principalId,
  open,
  onOpenChange,
  onSuccess,
  defaultPlatform,
}: BindPlatformAccountDialogProps) {
  const mutation = useBindPlatformAccount(principalId, () => {
    onOpenChange(false);
    onSuccess?.();
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!mutation.isPending) mutation.reset();
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-h-[90dvh] gap-5 overflow-y-auto p-5 sm:max-w-lg sm:p-6">
        <DialogHeader>
          <DialogTitle>绑定平台账号</DialogTitle>
          <DialogDescription>管理员核验后，比赛成绩会自动同步。</DialogDescription>
        </DialogHeader>
        <BindingGuide />
        <BindForm
          key={defaultPlatform ?? 'any'}
          defaultPlatform={defaultPlatform}
          submitting={mutation.isPending}
          onSubmit={(input) => mutation.mutate(input)}
          onCancel={() => {
            if (!mutation.isPending) mutation.reset();
            onOpenChange(false);
          }}
          error={mutation.isError ? (mutation.error as ApiError).message : null}
        />
      </DialogContent>
    </Dialog>
  );
}

export function BindForm({
  defaultPlatform,
  submitting,
  onSubmit,
  onCancel,
  cancelLabel = '取消',
  error,
}: {
  defaultPlatform?: string;
  submitting: boolean;
  onSubmit: (input: { platform: string; externalId: string; proofNote: string }) => void;
  onCancel: () => void;
  cancelLabel?: string;
  error: string | null;
}) {
  const [platform, setPlatform] = useState(defaultPlatform ?? 'nowcoder');
  const [externalId, setExternalId] = useState('');
  const [proofNote, setProofNote] = useState('');

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!submitting && externalId.trim().length >= 2) {
          onSubmit({ platform, externalId: externalId.trim(), proofNote: proofNote.trim() });
        }
      }}
    >
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="bind-platform">平台</Label>
        <Select value={platform} onValueChange={setPlatform} disabled={submitting}>
          <SelectTrigger id="bind-platform">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="nowcoder">牛客</SelectItem>
            <SelectItem value="codeforces">Codeforces</SelectItem>
            <SelectItem value="atcoder">AtCoder</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="bind-external">{platform === 'nowcoder' ? '账号 UID' : '用户名 / handle'}</Label>
        <Input
          id="bind-external"
          value={externalId}
          onChange={(event) => setExternalId(event.target.value)}
          placeholder={platform === 'nowcoder' ? '如 529537' : '如 tourist'}
          required
          minLength={2}
          maxLength={64}
          disabled={submitting}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="bind-proof">持有说明（可选）</Label>
        <Textarea
          id="bind-proof"
          className="min-h-16 resize-y"
          value={proofNote}
          onChange={(event) => setProofNote(event.target.value)}
          rows={2}
          maxLength={500}
          placeholder="如：主页昵称已改为我的校园编号"
          disabled={submitting}
        />
      </div>
      <DialogFooter className="flex-row justify-end border-t border-border pt-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button type="submit" disabled={submitting || externalId.trim().length < 2}>
          {submitting && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          {submitting ? '提交中…' : '提交绑定'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** 绑定教程（src/content/platform-binding-guide.md，Markdown 渲染）：弹窗里默认收起，登录绑定门默认展开 */
export function BindingGuide({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-border bg-muted/30">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BookOpenIcon className="size-4 text-primary" aria-hidden="true" />
        不知道填什么？查看绑定教程
        <ChevronDownIcon className={cn('ml-auto size-4 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && <MarkdownView source={bindingGuide} className="border-t border-border px-4 pt-2 pb-3" />}
    </div>
  );
}
