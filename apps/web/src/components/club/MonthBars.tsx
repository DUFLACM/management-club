/**
 * MonthBars：近六个月积分构成柱状图（轻量 SVG，随主题 token 变色）。
 *
 * 规范（dataviz）：单系列单色 --primary；柱厚 ≤24px、顶端 4px 圆角、基线端直角；
 * 相邻柱之间保留表面空隙；网格线 1px hairline；只对最大值与最新月份做直接标注，
 * 其余数值由悬浮 title 与等价数据表承载；文本用文本色而非系列色。
 */
import { formatDecimal, monthLabel } from '@/lib/format';

export interface MonthBarDatum {
  month: string;
  /** 当月原始积分（raw M） */
  raw: number;
  /** 有效系数（0-1）；缺省视为 1 */
  weight?: number | null;
}

export function MonthBars({
  data,
  height = 200,
  showWeights = true,
  ariaLabel = '近六个月积分柱状图',
}: {
  data: MonthBarDatum[];
  height?: number;
  showWeights?: boolean;
  ariaLabel?: string;
}) {
  const chartHeight = showWeights ? height : height + 16;
  const width = 560;
  const padding = { top: 24, right: 8, bottom: showWeights ? 34 : 20, left: 8 };
  const plotHeight = Math.max(40, chartHeight - padding.top - padding.bottom);
  const values = data.map((d) => d.raw);
  const max = Math.max(0, ...values);
  const niceMax = max <= 0 ? 10 : Math.ceil(max / 5) * 5 || 5;
  const slot = data.length > 0 ? (width - padding.left - padding.right) / data.length : 0;
  const barWidth = Math.min(24, Math.max(10, slot * 0.55));
  const maxIndex = values.indexOf(max);
  const latestIndex = data.length - 1;

  const scaleY = (value: number) =>
    padding.top + plotHeight - (value / niceMax) * plotHeight;

  return (
    <svg
      viewBox={`0 0 ${width} ${chartHeight}`}
      className="h-auto w-full text-input"
      role="img"
      aria-label={ariaLabel}
    >
      {/* hairline 网格（0 / 半值 / 顶值） */}
      {[0, niceMax / 2, niceMax].map((tick) => (
        <line
          key={tick}
          x1={padding.left}
          x2={width - padding.right}
          y1={scaleY(tick)}
          y2={scaleY(tick)}
          stroke="currentColor"
          strokeOpacity={tick === 0 ? 0.35 : 0.12}
          strokeWidth={1}
        />
      ))}
      {data.map((datum, index) => {
        const center = padding.left + slot * index + slot / 2;
        const barHeight = Math.max(datum.raw > 0 ? 2 : 0, plotHeight - (scaleY(datum.raw) - padding.top));
        const top = padding.top + plotHeight - barHeight;
        const radius = Math.min(4, barWidth / 2);
        const isMax = index === maxIndex && max > 0;
        const isLatest = index === latestIndex;
        return (
          <g key={datum.month}>
            <rect
              x={center - slot * 0.42}
              y={padding.top}
              width={slot * 0.84}
              height={plotHeight}
              fill="transparent"
            >
              <title>{`${monthLabel(datum.month)}：${formatDecimal(datum.raw)}${
                showWeights && datum.weight != null ? `（系数 ×${datum.weight}）` : ''
              }`}</title>
            </rect>
            {barHeight > 0 && (
              <path
                d={
                  `M${center - barWidth / 2},${padding.top + plotHeight} ` +
                  `V${top + radius} Q${center - barWidth / 2},${top} ${center - barWidth / 2 + radius},${top} ` +
                  `H${center + barWidth / 2 - radius} Q${center + barWidth / 2},${top} ${center + barWidth / 2},${top + radius} ` +
                  `V${padding.top + plotHeight} Z`
                }
                fill="var(--primary)"
                opacity={isLatest || isMax ? 1 : 0.82}
              />
            )}
            {(isMax || isLatest) && datum.raw > 0 && (
              <text
                x={center}
                y={top - 6}
                textAnchor="middle"
                fontSize="12"
                fill="var(--foreground)"
                className="tabular-nums"
              >
                {formatDecimal(datum.raw)}
              </text>
            )}
            <text
              x={center}
              y={chartHeight - (showWeights ? 18 : 5)}
              textAnchor="middle"
              fontSize="11"
              fill="currentColor"
            >
              {monthLabel(datum.month)}
            </text>
            {showWeights && (
              <text
                x={center}
                y={chartHeight - 5}
                textAnchor="middle"
                fontSize="10"
                fill="currentColor"
                opacity={0.65}
                className="tabular-nums"
              >
                {datum.weight != null ? `×${datum.weight}` : ''}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
