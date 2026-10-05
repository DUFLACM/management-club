/**
 * 管理端 · 规则参数（只读）。
 * 暂无专用读取接口：展示当前默认参数与 R01–R13 未决口径清单（内容与
 * @acm/scoring-core rule-params 的注册表一致）；规则版本由 CLI / 数据库管理。
 */
import { PanelHeader } from '@/components/club/PanelHeader';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';

const RULE_GAPS: ReadonlyArray<{ id: string; text: string }> = [
  { id: 'R01', text: 'M 取整策略：逐项/月末、四舍五入口径未确认' },
  { id: 'R02', text: '初始积分中位数 80% 上限与取整方式未确认' },
  { id: 'R03', text: '迟到/早退 1 分与 -2 扣分叠加、半场比较口径未确认' },
  { id: 'R04', text: '“有效提交”判题状态集合未定义' },
  { id: 'R05', text: '社内并列、团队 S/R、X 排名范围口径未确认' },
  { id: 'R06', text: '满意度 V 分子分母、有效投票门槛未确认' },
  { id: 'R07', text: '月度评定取用时点与并列裁决未确认' },
  { id: 'R08', text: '一般材料 7 日与赛后材料 3/7 日的任务拆分未确认' },
  { id: 'R09', text: '网络赛奖项替代模式是否含参与分未确认' },
  { id: 'R10', text: '理论最高分引用与跨类别上限入账顺序未确认' },
  { id: 'R11', text: 'Q 归一化、综测标准化与零样本口径未确认' },
  { id: 'R12', text: '月内身份变化与冻结资格的统计月口径未确认' },
  { id: 'R13', text: '目录认定与备案条款的专项映射未确认' },
];

const DEFAULT_PARAMS: ReadonlyArray<{ name: string; value: string }> = [
  { name: '有效积分权重（当月起往前 6 个月）', value: '×1 / ×0.85 / ×0.7 / ×0.55 / ×0.4 / ×0.25' },
  { name: '必到活动准时到场', value: '+2' },
  { name: '迟到/早退 >15 分钟（未超半场）', value: '+1（扣分单列）' },
  { name: '超过半场到场/提前离场', value: '0 参与分（按纪律制度单列扣分）' },
  { name: '普通宣讲/分享/复盘参会', value: '+1.5（小数口径待 R01）' },
  { name: '无故缺席必到活动', value: '扣分候选 -4（由审核确认）' },
  { name: '月度取整策略', value: 'pending（R01 未决，正式月结算被阻塞）' },
  { name: '公示期', value: '≥ 48 小时' },
  { name: '双人复核', value: '两名不同且无利益冲突负责人同意' },
];

export default function RulesPanel() {
  return <RulesBody />;
}

function RulesBody() {
  return (
    <div className="flex flex-col gap-4">
      <PanelHeader
        title="规则参数"
        description="制度默认参数参考与未决口径（只读）。"
      />
      <Alert>
        <AlertTitle>规则版本由 CLI / 数据库管理</AlertTitle>
        <AlertDescription>
          规则版本的发布、参数修改与回滚通过 CLI 或数据库维护，工作台不提供在线编辑；
          本页展示代码内的制度默认参数参考与 R01–R13 未决口径，未读取数据库中的生效版本。
          审核与公示请以记录附带的规则版本为准。
        </AlertDescription>
      </Alert>

      <Card>
        <CardContent className="flex flex-col gap-3 p-5">
          <h2 className="text-sm font-semibold text-foreground">制度默认参数参考（本地只读）</h2>
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
            {DEFAULT_PARAMS.map((item) => (
              <div key={item.name} className="contents">
                <dt className="text-muted-foreground">{item.name}</dt>
                <dd className="tabular-nums">{item.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 p-5">
          <h2 className="text-sm font-semibold text-foreground">未决口径（R01–R13）</h2>
          <ul className="flex flex-col divide-y divide-border">
            {RULE_GAPS.map((gap) => (
              <li key={gap.id} className="flex items-baseline gap-3 py-2 text-sm">
                <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground/80">
                  {gap.id}
                </span>
                <span className="text-foreground/90">{gap.text}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs leading-5 text-muted-foreground">
            未决口径不擅自取默认值：受影响的正式结算会被阻塞并转人工复核，宁可「待复核」
            也不填虚假数据。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
