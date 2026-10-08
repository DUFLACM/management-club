import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/utils';

/**
 * Markdown 渲染（教程、公告等站内静态文案）：GFM（表格 / 删除线 / 任务列表），
 * 外链新窗口打开；图片懒加载，加载失败时隐藏，不留破图。
 */
const components: Components = {
  h1: ({ node: _node, ...props }) => <h2 className="mt-6 mb-2 text-lg font-semibold text-foreground first:mt-0" {...props} />,
  h2: ({ node: _node, ...props }) => (
    <h3
      className="mt-6 mb-2 flex items-center gap-2 text-[15px] font-semibold text-foreground first:mt-0 before:h-4 before:w-1 before:rounded-full before:bg-primary"
      {...props}
    />
  ),
  h3: ({ node: _node, ...props }) => <h4 className="mt-4 mb-1.5 text-sm font-semibold text-foreground" {...props} />,
  p: ({ node: _node, ...props }) => <p className="my-2 leading-7" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-2 flex list-disc flex-col gap-1 pl-5 marker:text-muted-foreground" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-2 flex list-decimal flex-col gap-1 pl-5 marker:text-muted-foreground" {...props} />,
  li: ({ node: _node, ...props }) => <li className="leading-7" {...props} />,
  strong: ({ node: _node, ...props }) => <strong className="font-semibold text-foreground" {...props} />,
  a: ({ node: _node, ...props }) => (
    <a className="font-medium text-primary underline-offset-2 hover:underline" target="_blank" rel="noreferrer" {...props} />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="my-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-foreground [&>p]:my-0" {...props} />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code className={cn('rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em] break-all text-foreground', className)} {...props} />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre className="my-3 overflow-x-auto rounded-xl bg-muted p-3 text-xs [&>code]:bg-transparent [&>code]:p-0" {...props} />
  ),
  hr: ({ node: _node, ...props }) => <hr className="my-5 border-border" {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="my-3 overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left text-xs" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => <th className="border-b border-border bg-muted/60 px-3 py-2 font-medium" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border-b border-border px-3 py-2" {...props} />,
  img: ({ node: _node, alt, ...props }) => (
    <img
      alt={alt ?? ''}
      loading="lazy"
      className="my-3 w-full rounded-xl border border-border bg-card shadow-sm"
      onError={(event) => {
        event.currentTarget.style.display = 'none';
      }}
      {...props}
    />
  ),
};

export function MarkdownView({ source, className }: { source: string; className?: string }) {
  return (
    <div className={cn('min-w-0 text-sm text-muted-foreground', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
