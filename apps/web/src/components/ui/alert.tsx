import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/** Alert：标题、事实原因、下一步；关键错误持续可见。 */

const alertVariants = cva(
  'relative grid w-full grid-cols-[0_1fr] items-start gap-y-1 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-2 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        info: 'border-border bg-info-subtle text-info-foreground [&>svg]:text-info-foreground',
        success:
          'border-border bg-success-subtle text-success-foreground [&>svg]:text-success-foreground',
        warning:
          'border-border bg-warning-subtle text-warning-foreground [&>svg]:text-warning-foreground',
        destructive:
          'border-destructive/40 bg-destructive-subtle text-destructive [&>svg]:text-destructive',
        neutral: 'border-border bg-muted text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'info',
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn('col-start-2 min-h-4 font-medium leading-[22px]', className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'col-start-2 grid justify-items-start gap-1 text-sm leading-[22px] opacity-90 [&_p]:leading-[22px]',
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, alertVariants };
