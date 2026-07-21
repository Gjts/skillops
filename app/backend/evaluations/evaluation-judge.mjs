import { EvaluationError } from './errors.mjs'

export function parseBlindJudgeResult(text) {
  const normalized = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const objectText = normalized.match(/\{[\s\S]*\}/)?.[0] || normalized
  let parsed
  try { parsed = JSON.parse(objectText) } catch { throw new EvaluationError('The judge model did not return valid JSON. Try another model or rerun the evaluation.', 502) }
  const scoreA = Number(parsed.scoreA)
  const scoreB = Number(parsed.scoreB)
  if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB) || !['A', 'B', 'tie'].includes(parsed.winner)) {
    throw new EvaluationError('The judge model returned an invalid score payload.', 502)
  }
  const normalizedScoreA = Math.max(0, Math.min(100, Math.round(scoreA)))
  const normalizedScoreB = Math.max(0, Math.min(100, Math.round(scoreB)))
  const scoreWinner = normalizedScoreA === normalizedScoreB ? 'tie' : normalizedScoreA > normalizedScoreB ? 'A' : 'B'
  if (parsed.winner !== scoreWinner) throw new EvaluationError('The judge winner contradicts its normalized scores. Rerun the evaluation.', 502)
  return {
    scoreA: normalizedScoreA,
    scoreB: normalizedScoreB,
    winner: scoreWinner,
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 800) : 'No judge rationale was returned.',
  }
}

export function stableBlindSwap(value) {
  return [...String(value || '')].reduce((total, char) => total + char.charCodeAt(0), 0) % 2 === 1
}

export function blindJudgeMessages(task, criteria, answerA, answerB) {
  return [
    {
      role: 'system',
      content: 'You are an impartial A/B evaluator. Score both answers against the stated task and acceptance criteria. Ignore answer order and writing style unless the criteria require it. Return only JSON with keys winner (A, B, or tie), scoreA (0-100), scoreB (0-100), and reason.',
    },
    {
      role: 'user',
      content: `Task:\n${task}\n\nAcceptance criteria:\n${criteria}\n\nAnswer A:\n${answerA}\n\nAnswer B:\n${answerB}`,
    },
  ]
}
