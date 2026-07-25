const sensitiveSetting = /(token|secret|password|authorization|api[-_]?key|credential)/i

export function redactConfigForDisplay(value, parentKey = '') {
  if (Array.isArray(value)) return value.map((item) => redactConfigForDisplay(item, parentKey))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    parentKey === 'env' || sensitiveSetting.test(key)
      ? '[REDACTED]'
      : redactConfigForDisplay(nested, key),
  ]))
}
