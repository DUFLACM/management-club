/**
 * ResponsiveDetail：详情承载容器。
 * ≥768px 居中弹窗卡片（宽 560–640px、限高 85dvh / 760px）；<768px 底部抽屉。
 * 头部标题区 + 可滚动正文 + 固定底部动作区，两种形态共享同一内容。
 */
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/lib/hooks';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
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
  /** 桌面弹窗最大宽度（默认 600px） */
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
      <div className="flex min-h-0 flex-auto flex-col">
        <div className="shrink-0 border-b border-border px-5 py-4 pr-12 md:px-6 md:pr-14">
          <div className="text-base leading-6 font-semibold text-foreground">{title}</div>
          {description != null && (
            <div className="mt-1 text-sm leading-[22px] text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        <div className={cn('min-h-0 flex-auto overflow-y-auto px-5 py-4 md:px-6', bodyClassName)}>
          {children}
        </div>
      </div>
      {footer != null && (
        <div className="shrink-0 border-t border-border px-5 py-3 pb-[calc(12px+env(safe-area-inset-bottom))] md:px-6 md:py-3.5">
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
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="flex max-h-[min(85dvh,760px)] max-w-[var(--detail-width)] flex-col gap-0 overflow-hidden p-0"
          style={{ ['--detail-width' as string]: `${desktopWidth}px` }}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{typeof title === 'string' ? title : '详情'}</DialogTitle>
            {description != null && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <DetailBody title={title} description={description} footer={footer}>
            {children}
          </DetailBody>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="overflow-hidden md:hidden">
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
