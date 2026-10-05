/**
 * ResponsiveDetail：详情承载容器。
 * ≥768px 右侧 Sheet（560–640px、圆角 20px）；<768px 全高底部 Drawer。
 * 头部标题区 + 可滚动正文 + 固定底部动作区，两种形态共享同一内容。
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/lib/hooks';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from '@/components/ui/drawer';

export interface ResponsiveDetailProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** 固定底部动作区 */
  footer?: ReactNode;
  /** 桌面 Sheet 最大宽度（默认 600px） */
  desktopWidth?: 560 | 600 | 640;
}

function DetailBody({
  title,
  description,
  children,
  footer,
  bodyClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-border px-5 py-4 md:px-6">
          <div className="text-base leading-6 font-semibold text-foreground">{title}</div>
          {description != null && (
            <div className="mt-1 text-sm leading-[22px] text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4 md:px-6', bodyClassName)}>
          {children}
        </div>
      </div>
      {footer != null && (
        <div className="shrink-0 border-t border-border px-5 py-3 pb-[calc(12px+env(safe-area-inset-bottom))] md:px-6">
          {footer}
        </div>
      )}
    </>
  );
}

export function ResponsiveDetail({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  desktopWidth = 600,
}: ResponsiveDetailProps) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  if (isDesktop) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="sm:max-w-[var(--detail-width)]"
          style={{ ['--detail-width' as string]: `${desktopWidth}px` }}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{typeof title === 'string' ? title : '详情'}</SheetTitle>
            {description != null && <SheetDescription>{description}</SheetDescription>}
          </SheetHeader>
          <DetailBody title={title} description={description} footer={footer}>
            {children}
          </DetailBody>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="md:hidden">
        <DrawerHeader className="sr-only">
          <DrawerTitle>{typeof title === 'string' ? title : '详情'}</DrawerTitle>
          {description != null && <DrawerDescription>{description}</DrawerDescription>}
        </DrawerHeader>
        <DetailBody title={title} description={description} footer={footer}>
          {children}
        </DetailBody>
      </DrawerContent>
    </Drawer>
  );
}
