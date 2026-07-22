import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve('dist')

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map((entry) => {
    const location = path.join(directory, entry.name)
    return entry.isDirectory() ? files(location) : [location]
  }))).flat()
}

try {
  await stat(path.join(root, 'index.html'))
} catch {
  throw new Error('Build artifact is missing dist/index.html. Run npm run build first.')
}

const built = await files(root)
if (!built.some((file) => file.endsWith('.js')) || !built.some((file) => file.endsWith('.css'))) {
  throw new Error('Build artifact must contain JavaScript and CSS assets.')
}

const forbidden = built.filter((file) => /(?:^|[\\/])(?:data|\.git)(?:[\\/]|$)|(?:^|[\\/])\.env|\.(?:jsonl|pem|key|map)$/i.test(path.relative(root, file)))
if (forbidden.length) throw new Error(`Unsafe build artifacts:\n${forbidden.map((file) => path.relative(root, file)).join('\n')}`)

console.log(`Build artifact is complete and sanitized (${built.length} files).`)
