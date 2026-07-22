export function redactEvaluationText(value, rules = []) {
  if (typeof value !== 'string') return value
  return rules.reduce((text, rule) => text.replace(new RegExp(rule.pattern, 'gu'), () => rule.replacement), value)
}

export function redactEvaluationVariables(variables = {}, rules = []) {
  return Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, redactEvaluationText(value, rules)]))
}
