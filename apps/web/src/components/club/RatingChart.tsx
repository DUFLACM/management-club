/**
 * RatingChart：单平台 rating/成绩趋势折线（懒加载 chunk，进入可见区才 import）。
 *
 * 规范（dataviz）：单系列 2px 折线（--primary），数据点 r=4.5 + 2px 表面色描边环；
 * 面积为 10% 透明度 wash；hairline 网格；终点与极值直接标注；
 * 指针移动时显示最近点的悬浮卡（日期 + 分值）。缺失数据不补 0（由父级显示「暂无数据」）。
 */
import { useMemo, useRef, useState } from 'react';

import { formatDateTime } from '@/lib/format';

export interface RatingPoint {
  occurredAt: string;
  old: number | null;
  new: number | null;
  snapshot: number | null;
}

interface NearestPoint {
  index: number;
  x: number;
  y: number;
  point: RatingPoint;
}

export default function RatingChart({
  points,
  height = 260,
}: {
  points: RatingPoint[];
  height?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<NearestPoint | null>(null);

  const geometry = useMemo(() => {
    const width = 640;
    const padding = { top: 20, right: 16, bottom: 26, left: 40 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const value = (p: RatingPoint) => p.new ?? p.snapshot ?? p.old ?? null;
    const values = points.map(value).filter((v): v is number => v != null);
    if (values.length === 0) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || Math.max(40, max * 0.1);
    const lo = min - span * 0.12;
    const hi = max + span * 0.12;
    const stepX = points.length > 1 ? plotWidth / (points.length - 1) : 0;
    const coords = points.map((p, i) => {
      const v = value(p);
      return {
        x: padding.left + (points.length > 1 ? stepX * i : plotWidth / 2),
        y: v == null ? null : padding.top + plotHeight - ((v - lo) / (hi - lo)) * plotHeight,
        v,
      };
    });
    const linePath = coords
      .filter((c) => c.y != null)
      .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x!.toFixed(1)},${c.y!.toFixed(1)}`)
      .join(' ');
    const filled = coords.filter((c) => c.y != null);
    const areaPath =
      filled.length > 1
        ? `${linePath} L${filled[filled.length - 1]!.x!.toFixed(1)},${(padding.top + plotHeight).toFixed(1)} L${filled[0]!.x!.toFixed(1)},${(padding.top + plotHeight).toFixed(1)} Z`
        : '';
    const gridValues = [lo, (lo + hi) / 2, hi];
    return { width, padding, plotWidth, plotHeight, coords, linePath, areaPath, gridValues, min, max };
  }, [points, height]);

  if (!geometry) {
    return (
      <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
        暂无数据
      </div>
    );
  }

  const { width, padding, plotHeight, coords, linePath, areaPath, gridValues, min, max } =
    geometry;
  const [gridLo, , gridHi] = gridValues as [number, number, number];
  const scaleYForGrid = (v: number) =>
    padding.top + plotHeight - ((v - gridLo) / (gridHi - gridLo)) * plotHeight;

  const handleMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    const svgX = ratio * width;
    let nearest: NearestPoint | null = null;
    coords.forEach((c, index) => {
      if (c.y == null) return;
      const distance = Math.abs(c.x - svgX);
      if (!nearest || distance < Math.abs(nearest.x - svgX)) {
        nearest = { index, x: c.x, y: c.y, point: points[index]! };
      }
    });
    setHover(nearest);
  };

  const firstIdx = coords.findIndex((c) => c.y != null);
  const lastIdx = coords.reduce((acc, c, i) => (c.y != null ? i : acc), -1);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full touch-none text-input"
      role="img"
      aria-label="rating 走势折线图"
      onPointerMove={handleMove}
      onPointerLeave={() => setHover(null)}
    >
      {gridValues.map((v) => (
        <g key={v}>
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={scaleYForGrid(v)}
            y2={scaleYForGrid(v)}
            stroke="currentColor"
            strokeOpacity={0.12}
            strokeWidth={1}
          />
          <text
            x={padding.left - 6}
            y={scaleYForGrid(v) + 4}
            textAnchor="end"
            fontSize="10"
            fill="currentColor"
            className="tabular-nums"
          >
            {Math.round(v)}
          </text>
        </g>
      ))}
      {areaPath && <path d={areaPath} fill="var(--primary)" opacity={0.1} />}
      <path d={linePath} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {coords.map((c, i) =>
        c.y == null ? null : (
          <circle
            key={i}
            cx={c.x}
            cy={c.y}
            r={4.5}
            fill="var(--primary)"
            stroke="var(--card)"
            strokeWidth={2}
          />
        ),
      )}
      {[firstIdx, lastIdx].map((i) => {
        const c = coords[i];
        if (c == null || c.y == null || c.v == null) return null;
        const anchor = i === firstIdx ? 'start' : 'end';
        return (
          <text
            key={i}
            x={c.x + (i === firstIdx ? 8 : -8)}
            y={c.y - 8}
            textAnchor={anchor}
            fontSize="11"
            fill="var(--foreground)"
            className="tabular-nums"
          >
            {Math.round(c.v)}
          </text>
        );
      })}
      {hover && hover.y != null && (
        <g>
          <line
            x1={hover.x}
            x2={hover.x}
            y1={padding.top}
            y2={padding.top + plotHeight}
            stroke="var(--primary)"
            strokeOpacity={0.35}
            strokeWidth={1}
          />
          <circle cx={hover.x} cy={hover.y} r={5.5} fill="var(--primary)" stroke="var(--card)" strokeWidth={2} />
          <g
            transform={`translate(${Math.min(Math.max(hover.x - 70, 4), width - 148)}, ${Math.max(hover.y - 52, 2)})`}
          >
            <rect width="144" height="42" rx="8" fill="var(--popover)" stroke="var(--border)" />
            <text x="8" y="17" fontSize="10.5" fill="var(--muted-foreground)">
              {formatDateTime(hover.point.occurredAt)}
            </text>
            <text x="8" y="33" fontSize="12" fill="var(--foreground)" className="tabular-nums">
              {hover.point.new ?? hover.point.snapshot ?? hover.point.old ?? '—'}
            </text>
          </g>
        </g>
      )}
      <text x={width - padding.right} y={height - 6} textAnchor="end" fontSize="10" fill="currentColor" opacity={0.7}>
        极值 {min}–{max}
      </text>
    </svg>
  );
}
