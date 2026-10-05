import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 括号小助手：36×32，左右括号 + 两个小眼点 + 8px 光标。
 * 仅适合欢迎卡或普通空状态；不配对话气泡、不加动作动画。
 */
export function BracketBuddy({
  className,
  labeled = false,
  ...props
}: React.SVGProps<SVGSVGElement> & { labeled?: boolean }) {
  return (
    <svg
      viewBox="0 0 36 32"
      width="36"
      height="32"
      fill="none"
      aria-hidden={labeled ? undefined : true}
      className={cn('shrink-0 text-input', className)}
      {...props}
    >
      {/* 左括号 */}
      <path
        d="M12 6C8.5 8.5 6.5 12 6.5 16s2 7.5 5.5 10"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
      />
      {/* 右括号 */}
      <path
        d="M24 6c3.5 2.5 5.5 6 5.5 10s-2 7.5-5.5 10"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
      />
      {/* 两个小眼点 */}
      <circle cx="15" cy="16" r="1.6" fill="currentColor" />
      <circle cx="21" cy="16" r="1.6" fill="currentColor" />
      {/* 8px 光标 */}
      <rect x="17" y="21" width="2.4" height="8" rx="1.2" fill="var(--primary)" />
    </svg>
  );
}
