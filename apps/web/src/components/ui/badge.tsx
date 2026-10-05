import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/** Badge 圆角 6px（--radius-sm），水平 padding 8px。 */
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-medium leading-[18px] whitespace-nowrap [&>svg]:size-3 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        neutral: 'border-transparent bg-muted text-muted-foreground',
        info: 'border-transparent bg-info-subtle text-info-foreground',
        success: 'border-transparent bg-success-subtle text-success-foreground',
        warning: 'border-transparent bg-warning-subtle text-warning-foreground',
        destructive: 'border-transparent bg-destructive-subtle text-destructive',
        lilac: 'border-transparent bg-lilac-subtle text-lilac-foreground',
        outline: 'border-border bg-transparent text-foreground',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
);

export interface BadgeProps
  extends React.ComponentProps<'span'>,
    VariantProps<typeof badgeVariants> {
  asChild?: boolean;
}

function Badge({ className, variant, asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot.Root : 'span';
  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
