import { defaultRuleParams, ruleParamsSchema, type RuleParams } from '@acm/scoring-core'

/** 旧版本参数经默认值合并补齐（R01–R13 拍板后的新字段对历史版本同样生效） */
export function mergeRuleParams(stored: unknown): RuleParams {
  const base = defaultRuleParams() as Record<string, unknown>
  const overlay = (stored ?? {}) as Record<string, unknown>
  return ruleParamsSchema.parse({ ...base, ...overlay })
}
