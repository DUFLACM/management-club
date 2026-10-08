import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { LoaderCircleIcon } from 'lucide-react';

import { api, ApiError, fetchCsrfToken } from '@/lib/api';
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

const MIN_LENGTH = 6;
const MAX_LENGTH = 18;

/** 本地管理员修改自己的登录密码（PUT /admin/account/password）；成功后其它设备上的会话下线 */
export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [done, setDone] = useState(false);

  const lengthOk = newPassword.length >= MIN_LENGTH && newPassword.length <= MAX_LENGTH;
  const matches = newPassword === confirmPassword;

  const mutation = useMutation({
    mutationFn: async () => {
      const csrfToken = await fetchCsrfToken();
      if (!csrfToken) throw new ApiError('CSRF_UNAVAILABLE', '安全令牌获取失败，请刷新页面重试。');
      await api.put('/admin/account/password', { currentPassword, newPassword, csrfToken });
      return true;
    },
    onSuccess: () => setDone(true),
  });

  const reset = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setDone(false);
    mutation.reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (mutation.isPending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>修改管理员密码</DialogTitle>
          <DialogDescription>新密码 {MIN_LENGTH}–{MAX_LENGTH} 位。修改后其它设备上的登录会下线，当前页面保持登录。</DialogDescription>
        </DialogHeader>
        {done ? (
          <>
            <Alert variant="info">
              <AlertDescription>密码已修改，下次登录请使用新密码。</AlertDescription>
            </Alert>
            <DialogFooter>
              <Button onClick={() => { reset(); onOpenChange(false); }}>完成</Button>
            </DialogFooter>
          </>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (currentPassword && lengthOk && matches && !mutation.isPending) mutation.mutate();
            }}
          >
            {mutation.error && (
              <Alert variant="destructive">
                <AlertDescription>{(mutation.error as ApiError).message}</AlertDescription>
              </Alert>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="admin-current-password">当前密码</Label>
              <Input
                id="admin-current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="admin-new-password">新密码</Label>
              <Input
                id="admin-new-password"
                type="password"
                autoComplete="new-password"
                maxLength={MAX_LENGTH}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                aria-invalid={newPassword !== '' && !lengthOk}
                required
              />
              {newPassword !== '' && !lengthOk && (
                <p className="text-xs text-destructive">密码须为 {MIN_LENGTH}–{MAX_LENGTH} 位</p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="admin-confirm-password">确认新密码</Label>
              <Input
                id="admin-confirm-password"
                type="password"
                autoComplete="new-password"
                maxLength={MAX_LENGTH}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                aria-invalid={confirmPassword !== '' && !matches}
                required
              />
              {confirmPassword !== '' && !matches && <p className="text-xs text-destructive">两次输入不一致</p>}
            </div>
            <DialogFooter>
              <Button type="submit" disabled={!currentPassword || !lengthOk || !matches || mutation.isPending}>
                {mutation.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
                保存新密码
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
