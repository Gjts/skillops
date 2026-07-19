const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1])
}

const skillIds = (args.get('--skill') || '').split(',').map((value) => value.trim()).filter(Boolean)
const runtime = args.get('--runtime') || 'codex'
const sessionId = args.get('--session')
const since = args.get('--since') ? Date.parse(args.get('--since')) : 0
const endpoint = args.get('--url') || 'http://127.0.0.1:5173/api/events'

if (!skillIds.length) {
  console.error('Usage: node scripts/check-skill-recording.mjs --skill <id[,id]> [--runtime codex] [--session id] [--since ISO] [--url endpoint]')
  process.exit(2)
}

const response = await fetch(endpoint)
if (!response.ok) throw new Error(`Event API returned ${response.status}.`)
const events = await response.json()
const matches = events.filter((event) =>
  skillIds.includes(event.skillId) &&
  event.runtime === runtime &&
  (!sessionId || event.sessionId === sessionId) &&
  event.event !== 'skill.discovered' &&
  Date.parse(event.timestamp) >= since)

if (!matches.length) {
  const sessionLabel = sessionId ? ` in session ${sessionId}` : ''
  console.error(`RED: no ${runtime} execution events for ${skillIds.join(' or ')}${sessionLabel} since ${new Date(since).toISOString()}.`)
  process.exit(1)
}

console.log(JSON.stringify({ verdict: 'GREEN', matches }, null, 2))
