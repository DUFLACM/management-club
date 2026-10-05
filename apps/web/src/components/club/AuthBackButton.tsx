import { useNavigate } from 'react-router';
import { ArrowLeftIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';

/** 只返回 React Router 的站内历史；直达认证页时回到工作台欢迎入口。 */
export function AuthBackButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const navigate = useNavigate();
  return (
    <Button
      type="button"
      variant="ghost"
      className={iconOnly ? 'size-11 shrink-0 rounded-xl border border-border bg-card px-0 text-muted-foreground' : 'h-11 gap-2 px-3 text-muted-foreground'}
      aria-label="返回"
      onClick={() => {
        if (typeof window.history.state?.idx === 'number' && window.history.state.idx > 0) {
          navigate(-1);
        } else {
          navigate('/app', { replace: true });
        }
      }}
    >
      <ArrowLeftIcon aria-hidden="true" />
      <span className={iconOnly ? 'sr-only' : undefined}>返回</span>
    </Button>
  );
}
