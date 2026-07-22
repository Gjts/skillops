import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const skippedDirectories = new Set(['.git', '.gitnexus', 'data', 'dist', 'node_modules'])

async function markdownFiles(directory = root) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const location = path.join(directory, entry.name)
    if (entry.isDirectory()) return skippedDirectories.has(entry.name) ? [] : markdownFiles(location)
    return entry.isFile() && entry.name.endsWith('.md') ? [location] : []
  }))).flat()
}

async function exists(location) {
  try {
    await stat(location)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

const broken = []
for (const file of await markdownFiles()) {
  const text = await readFile(file, 'utf8')
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim().replace(/^<|>$/g, '')
    if (!target || /^(?:[a-z]+:|#)/i.test(target)) continue
    target = target.split(/\s+["']/)[0].split('#')[0].split('?')[0]
    try { target = decodeURIComponent(target) } catch { /* Invalid encoding is reported as a missing target. */ }
    const resolved = target.startsWith('/') ? path.join(root, target) : path.resolve(path.dirname(file), target)
    if (!await exists(resolved)) broken.push(`${path.relative(root, file)} -> ${match[1]}`)
  }
}

if (broken.length) {
  throw new Error(`Broken Markdown links:\n${broken.join('\n')}`)
}
console.log('Markdown links are valid.')
