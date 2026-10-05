import { Component, Suspense, type ComponentType, type ReactNode } from 'react';

import { PanelSkeleton } from '@/components/club/PanelSkeleton';
import { ErrorState } from '@/components/club/ErrorState';

/**
 * SectionRouter：section 白名单解析 + 懒加载面板路由。
 * - 非法 section 值回退到工作台默认面板；
 * - 每次只挂载当前面板（切换即卸载旧面板，避免加载多余代码/请求/监听器）；
 * - Suspense 骨架与最终面板尺寸相近；懒加载 chunk 失败由错误边界承接并可重试。
 */

/** 白名单解析：非法值回默认。 */
export function resolveSection<S extends string>(
  value: string | null | undefined,
  whitelist: readonly S[],
  fallback: S,
): S {
  return whitelist.includes(value as S) ? (value as S) : fallback;
}

interface PanelErrorBoundaryProps {
  children: ReactNode;
}

interface PanelErrorBoundaryState {
  error: Error | null;
  /** 重试计数：改变 key 触发懒加载组件重新挂载（重新发起 chunk import） */
  retryCount: number;
}

class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  state: PanelErrorBoundaryState = { error: null, retryCount: 0 };

  static getDerivedStateFromError(error: Error): Partial<PanelErrorBoundaryState> {
    return { error };
  }

  private retry = () => {
    this.setState((state) => ({ error: null, retryCount: state.retryCount + 1 }));
  };

  render() {
    if (this.state.error) {
      return (
        <ErrorState
          title="面板加载失败"
          description="可能是网络原因导致页面资源未加载完成，请重试。"
          onRetry={this.retry}
        />
      );
    }
    return (
      <div key={this.state.retryCount} className="min-w-0">
        {this.props.children}
      </div>
    );
  }
}

export interface SectionRouterProps {
  /** 当前 section（未白名单校验的原始值或已校验值均可） */
  currentSection: string;
  /** 白名单 + 面板映射 */
  panels: Readonly<Record<string, ComponentType>>;
  defaultSection: string;
  /** 自定义加载骨架 */
  fallback?: ReactNode;
}

export function SectionRouter({
  currentSection,
  panels,
  defaultSection,
  fallback,
}: SectionRouterProps) {
  const section = resolveSection(
    currentSection,
    Object.keys(panels),
    defaultSection,
  );
  const Panel = panels[section]!;

  return (
    <PanelErrorBoundary key={section}>
      <Suspense fallback={fallback ?? <PanelSkeleton />}>
        <Panel />
      </Suspense>
    </PanelErrorBoundary>
  );
}
