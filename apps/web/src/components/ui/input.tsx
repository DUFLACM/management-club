import * as React from 'react';

import { cn } from '@/lib/utils';

/** Input 圆角 10px；边界用 --input（可辨认），错误态同时变红并保留可读错误文字。 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-10 w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-sm leading-[22px] text-foreground transition-[color,box-shadow,border-color] duration-150 outline-none',
        'placeholder:text-muted-foreground/80 selection:bg-secondary selection:text-secondary-foreground',
        'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-0',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/30 aria-invalid:focus-visible:ring-destructive/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'file:border-0 file:bg-transparent file:text-sm file:font-medium',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
