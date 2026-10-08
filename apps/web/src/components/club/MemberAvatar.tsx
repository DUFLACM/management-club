import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

/** 无头像时的首字底色：按名字稳定取色，同一个人在各处颜色一致（浅深主题都可读） */
const FALLBACK_TONES = [
  'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
  'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300',
  'bg-teal-100 text-teal-700 dark:bg-teal-500/20 dark:text-teal-300',
  'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300',
];

function toneOf(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return FALLBACK_TONES[hash % FALLBACK_TONES.length]!;
}

const SIZES = {
  xs: { box: 'size-6', text: 'text-[10px]', variant: 64 },
  sm: { box: 'size-8', text: 'text-xs', variant: 64 },
  md: { box: 'size-10', text: 'text-sm', variant: 128 },
  lg: { box: 'size-14', text: 'text-lg', variant: 128 },
} as const;

/**
 * 成员头像：有头像读授权媒体入口的对应尺寸变体，加载失败或没设头像时显示彩色首字。
 * name 传成员显示名（如「Alice（张三）」），取第一个字作缩写、并作为取色种子。
 */
export function MemberAvatar({
  assetId,
  name,
  size = 'sm',
  className,
}: {
  assetId?: string | null;
  name: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const spec = SIZES[size];
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '?';
  return (
    <Avatar className={cn(spec.box, 'border-0 ring-2 ring-background', className)}>
      {assetId && <AvatarImage src={`/api/v1/me/avatar/${assetId}?size=${spec.variant}`} alt="" loading="lazy" />}
      <AvatarFallback className={cn('font-semibold', spec.text, toneOf(name))}>{initial}</AvatarFallback>
    </Avatar>
  );
}
