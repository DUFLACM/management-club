import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 协会 logo：32×32，两枚蓝色角括号 + 中间一条短光标。
 * 纯 SVG 线稿，默认 aria-hidden（装饰图形不抢 Tab 焦点）；
 * 需要语义时传 role="img" 与 aria-label。
 */
export function ClubMark({
  className,
  labeled = false,
  ...props
}: React.SVGProps<SVGSVGElement> & { labeled?: boolean }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width="32"
      height="32"
      fill="none"
      aria-hidden={labeled ? undefined : true}
      className={cn('shrink-0 text-primary', className)}
      {...props}
    >
      {/* 左角括号 */}
      <path
        d="M11.5 7.5H8.5A1.5 1.5 0 0 0 7 9v14a1.5 1.5 0 0 0 1.5 1.5h3"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 右角括号 */}
      <path
        d="M20.5 7.5h3A1.5 1.5 0 0 1 25 9v14a1.5 1.5 0 0 1-1.5 1.5h-3"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 短光标 */}
      <rect x="14.75" y="11.5" width="2.5" height="9" rx="1.25" fill="currentColor" />
    </svg>
  );
}
