import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { GripVerticalIcon, XIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Drawer：手机底部抽屉（基于 Radix Dialog 自写，不引入 vaul）。
 * - 手机：从底部滑出（自适应内容高度，上限 90dvh），顶部保留 8px 拖动示意与关闭按钮，
 *   内容区滚动，底部动作固定，预留安全区（env(safe-area-inset-bottom)）；
 * - ≥768px 桌面：自动退化为居中 Dialog 卡片样式。
 */

const Drawer = DialogPrimitive.Root;
const DrawerTrigger = DialogPrimitive.Trigger;
const DrawerClose = DialogPrimitive.Close;

function DrawerOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn('fixed inset-0 z-50 bg-[rgb(17_26_44_/_48%)]', className)}
      {...props}
    />
  );
}

function DrawerContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      <DrawerOverlay />
      <DialogPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          // 手机底部抽屉：自适应内容高度，上限 90dvh，圆角 20px 只在顶部
          'fixed inset-x-0 bottom-0 z-50 flex h-auto max-h-[90dvh] flex-col overflow-y-auto rounded-t-[20px] border-t border-border bg-card text-card-foreground shadow-overlay',
          // 桌面退化为居中卡片
          'md:inset-0 md:m-auto md:h-fit md:max-h-[min(calc(100dvh-64px),760px)] md:w-[calc(100%-32px)] md:max-w-[560px] md:rounded-2xl md:border',
          className,
        )}
        {...props}
      >
        {/* 手机顶部拖动示意（纯装饰，不承担关闭手势） */}
        <div
          aria-hidden="true"
          className="flex justify-center pt-2 md:hidden"
        >
          <GripVerticalIcon className="size-4 text-muted-foreground/60" />
        </div>
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="drawer-close"
            className="absolute top-3 right-3 rounded-md p-1.5 text-muted-foreground outline-none transition-[color,background-color] duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <XIcon className="size-4" aria-hidden="true" />
            <span className="sr-only">关闭</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-header"
      className={cn('flex flex-col gap-1.5 border-b border-border px-4 pt-3 pb-4 pr-12', className)}
      {...props}
    />
  );
}

function DrawerBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-body"
      className={cn('min-h-0 flex-1 overflow-y-auto p-4', className)}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn(
        'border-t border-border px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))]',
        className,
      )}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="drawer-title"
      className={cn('text-base leading-6 font-semibold', className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="drawer-description"
      className={cn('text-sm leading-[22px] text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerBody,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
};
