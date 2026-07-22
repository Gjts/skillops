export function flags(values) {
  const result = {}
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index]
    if (!option.startsWith('--')) continue
    const separator = option.indexOf('=')
    if (separator > 2) {
      result[option.slice(2, separator)] = option.slice(separator + 1)
      continue
    }
    const next = values[index + 1]
    result[option.slice(2)] = next === undefined || next.startsWith('--') ? true : values[++index]
  }
  return result
}
