export function flags(values) {
  const result = {}
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith('--')) continue
    const next = values[index + 1]
    result[values[index].slice(2)] = next === undefined || next.startsWith('--') ? true : values[++index]
  }
  return result
}
