import { sanitizeEvaluationCases, sanitizeEvaluationRunSummary } from './evaluation-store.mjs'

export function createEvaluationReport(summary, cases) {
  return {
    schemaVersion: 1,
    summary: sanitizeEvaluationRunSummary(summary),
    cases: sanitizeEvaluationCases(cases),
  }
}

function html(value) {
  return String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function field(label, value) {
  return `<dt>${html(label)}</dt><dd>${html(value)}</dd>`
}

export function renderEvaluationHtmlReport(summary, cases) {
  const report = createEvaluationReport(summary, cases)
  const run = report.summary
  const rows = report.cases.map((item) => `<tr><td>${html(item.caseId)}</td><td>${html(item.repeat)}</td><td>${html(item.baseline.pass ? 'Pass' : 'Fail')}</td><td>${html(item.baseline.score)}</td><td>${html(item.candidate.pass ? 'Pass' : 'Fail')}</td><td>${html(item.candidate.score)}</td></tr>`).join('')
  const gates = run.gates.map((gate) => `<li><strong>${html(gate.id)}</strong>: ${html(gate.status)}${gate.blocking ? ' (blocking)' : ''}</li>`).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SkillOps Evaluation ${html(run.id)}</title><style>body{font:14px system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 20px;color:#172033}h1,h2{margin:0 0 16px}section{margin:28px 0}dl{display:grid;grid-template-columns:180px 1fr;gap:8px 16px}dt{font-weight:700}dd{margin:0;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccd3df;padding:8px;text-align:left}th{background:#f2f5f9}pre{white-space:pre-wrap;background:#f6f8fa;padding:16px;border-radius:6px}.notice{color:#566173}</style></head><body>
<h1>SkillOps Evaluation Report</h1><p class="notice">Sanitized, read-only evidence. Prompt bodies, task text, provider output, credentials, and source code are excluded.</p>
<section><h2>Run</h2><dl>${field('Run ID', run.id)}${field('Status', run.status)}${field('Suite', `${run.suiteId || '—'} ${run.suiteVersion || ''}`.trim())}${field('Baseline', `${run.baseline.artifactId}@${run.baseline.version}`)}${field('Candidate', `${run.candidate.artifactId}@${run.candidate.version}`)}${field('Engine', `${run.engine.name}@${run.engine.version}`)}${field('Provider', `${run.provider.id}/${run.provider.model}`)}${field('Gate result', run.gateResult)}${field('Evidence hash', run.evidenceHash)}</dl></section>
<section><h2>Metrics</h2><pre>${html(JSON.stringify(run.metrics, null, 2))}</pre></section>
<section><h2>Gates</h2>${gates ? `<ul>${gates}</ul>` : '<p>None.</p>'}</section>
<section><h2>Cases</h2><table><thead><tr><th>Case</th><th>Repeat</th><th>Baseline</th><th>Score</th><th>Candidate</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table></section>
</body></html>`
}
