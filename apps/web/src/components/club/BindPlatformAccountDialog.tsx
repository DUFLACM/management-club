import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';

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

interface BindPlatformAccountDialogProps {
  principalId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function BindPlatformAccountDialog({
  principalId,
  open,
  onOpenChange,
  onSuccess,
}: BindPlatformAccountDialogProps) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (input: { platform: string; externalId: string; proofNote: string }) =>
      (await api.post<{ accountId: string }>('/me/platform-accounts', input)).data,
    onSuccess: () => {
      onOpenChange(false);
      onSuccess?.();
      void queryClient.invalidateQueries({
        queryKey: ['principal', principalId, 'me', 'platform-accounts'],
      });
      void queryClient.invalidateQueries({
        queryKey: ['principal', principalId, 'me', 'dashboard'],
      });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!mutation.isPending) mutation.reset();
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="gap-5 p-5 sm:max-w-md sm:p-6">
        <DialogHeader>
          <DialogTitle>绑定平台账号</DialogTitle>
          <DialogDescription>管理员核验后，比赛成绩会自动同步。</DialogDescription>
        </DialogHeader>
        <BindForm
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

function BindForm({
  submitting,
  onSubmit,
  onCancel,
  error,
}: {
  submitting: boolean;
  onSubmit: (input: { platform: string; externalId: string; proofNote: string }) => void;
  onCancel: () => void;
  error: string | null;
}) {
  const [platform, setPlatform] = useState('nowcoder');
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
          取消
        </Button>
        <Button type="submit" disabled={submitting || externalId.trim().length < 2}>
          {submitting && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          {submitting ? '提交中…' : '提交绑定'}
        </Button>
      </DialogFooter>
    </form>
  );
}
