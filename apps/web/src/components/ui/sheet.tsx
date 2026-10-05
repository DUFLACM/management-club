import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { XIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Sheet：桌面右侧抽屉（详情用，宽 560–640px、圆角 20px、全高）。
 * 手机上的全高底部抽屉请使用 drawer.tsx。
 */

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

function SheetOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn('fixed inset-0 z-50 bg-[rgb(17_26_44_/_48%)]', className)}
      {...props}
    />
  );
}

type SheetSide = 'right' | 'left' | 'top' | 'bottom';

function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  side?: SheetSide;
  showCloseButton?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      <SheetOverlay />
      <DialogPrimitive.Content
        data-slot="sheet-content"
        className={cn(
          'fixed z-50 flex flex-col gap-4 bg-card text-card-foreground shadow-overlay',
          // 大 Drawer 圆角 20px
          'rounded-[20px]',
          side === 'right' &&
            'inset-y-0 right-0 h-full w-full max-w-none border-l border-border p-0 sm:max-w-[640px]',
          side === 'left' &&
            'inset-y-0 left-0 h-full w-full max-w-none border-r border-border p-0 sm:max-w-[640px]',
          side === 'top' && 'inset-x-0 top-0 border-b border-border',
          side === 'bottom' && 'inset-x-0 bottom-0 border-t border-border',
          className,
        )}
        {...props}
      >
        {side === 'right' || side === 'left' ? (
          <div className="flex h-full min-h-0 flex-col">{children}</div>
        ) : (
          children
        )}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="sheet-close"
            className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground outline-none transition-[color,background-color] duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none"
          >
            <XIcon className="size-4" aria-hidden="true" />
            <span className="sr-only">关闭</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-1.5 border-b border-border p-5 pr-12', className)}
      {...props}
    />
  );
}

function SheetBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-body"
      className={cn('min-h-0 flex-1 overflow-y-auto p-5', className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        'flex flex-col-reverse gap-2 border-t border-border p-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn('text-base leading-6 font-semibold', className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm leading-[22px] text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
