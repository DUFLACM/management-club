import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 训练室线稿（晴空训练室）。
 *
 * - viewBox 180×120：桌面、带 </> 的笔记本屏幕、笔记本、三节点图；
 * - 背景为圆角窗框与两块很淡的天空色面，角落一个四角星；
 * - 主线 1.5px 蓝灰（currentColor，默认 text-input）；色块最多蓝/薄荷/淡紫三色；
 * - 留白至少一半；整幅未压缩 < 8KB；装饰图形默认 aria-hidden。
 * - 认证页可放大到 320×214（同一 SVG，不引入另一套人物风格）。
 */
export function TrainingRoomArt({
  className,
  width = 180,
  height = 120,
  labeled = false,
  ...props
}: React.SVGProps<SVGSVGElement> & { labeled?: boolean }) {
  return (
    <svg
      viewBox="0 0 180 120"
      width={width}
      height={height}
      fill="none"
      aria-hidden={labeled ? undefined : true}
      className={cn('shrink-0 text-input', className)}
      {...props}
    >
      {/* 圆角窗框 */}
      <rect
        x="18"
        y="10"
        width="66"
        height="52"
        rx="9"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="var(--card)"
      />
      {/* 两块很淡的天空色面：蓝 / 薄荷 */}
      <rect x="24" y="16" width="25" height="15" rx="3.5" fill="var(--secondary)" />
      <rect x="53" y="16" width="25" height="15" rx="3.5" fill="var(--success-subtle)" />
      {/* 四角星（角落装饰，淡紫） */}
      <path
        d="M160 11.5 161.8 16.2 166.5 18 161.8 19.8 160 24.5 158.2 19.8 153.5 18 158.2 16.2Z"
        fill="var(--lilac-foreground)"
        opacity="0.75"
      />
      {/* 三节点图 */}
      <path
        d="M128 36 150 28M150 28 158 48M128 36 158 48"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="128" cy="36" r="5" stroke="currentColor" strokeWidth="1.5" fill="var(--secondary)" />
      <circle cx="150" cy="28" r="5" stroke="currentColor" strokeWidth="1.5" fill="var(--card)" />
      <circle cx="158" cy="48" r="5" stroke="currentColor" strokeWidth="1.5" fill="var(--card)" />
      {/* 桌面与桌腿 */}
      <path
        d="M10 90H170"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M26 90V106M154 90V106"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* 笔记本电脑：屏幕 + 底座 */}
      <rect
        x="48"
        y="55"
        width="44"
        height="29"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="var(--card)"
      />
      <text
        x="70"
        y="73.5"
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, Consolas, monospace"
        fontSize="9"
        fill="currentColor"
      >
        {'</>'}
      </text>
      <path
        d="M44 90H96L92 84H48Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="var(--secondary)"
      />
      {/* 笔记本 */}
      <rect
        x="112"
        y="74"
        width="34"
        height="16"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        fill="var(--card)"
      />
      <path
        d="M118 79.5H140M118 84H136"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
