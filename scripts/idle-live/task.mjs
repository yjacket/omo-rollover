// Synthetic restore/policy task with deterministic ground truth (Appendix A section 4 of
// .omo/plans/idle-experiments-live-run.md). The same seed always yields the same bytes, so
// both paths of an experiment work on identical prompts and the scorer needs no model.
// Pure: no I/O, no clock, no ambient randomness.
import { filler, rng, NULLP, promptOf } from "./filler.mjs"

export const CTX_LINES = 4800
const WINDOW = 40
const HEADER = "id,site,date,temp_c,humidity,wind_kph,pressure_hpa"

export const PARK_PROMPT = "I have to hand this session over to a fresh session. Write a handoff note for your successor: goal, key facts (ticket, record id, site, date, threshold, decision, next step), what has been done, what to do next. Under 1,200 words, do not paste the log."
export const R2_PROMPT = "Before we continue: what is the next step, and is there anything you are missing that you would need to ask me about?"
export const GUARD_PROMPT = "Quick check: which record id is under investigation, at which site, and what is the alert threshold? Answer as 'id, site, threshold'."
export const r1Prompt = (handoff) => promptOf(`You are taking over an interrupted session. Here is the handoff:\n${handoff}\nConfirm by listing the key facts, one per line.`)
const R2 = promptOf(R2_PROMPT)
const R3 = promptOf(GUARD_PROMPT)
const GUARD_RAW = promptOf("I'm back. " + GUARD_PROMPT)

const cols = (line) => line.split(",")
const trueIds = (lines, site, threshold) => lines.filter((l) => cols(l)[1] === site && Number(cols(l)[3]) > threshold).map((l) => cols(l)[0])

// Work windows: 40 consecutive log lines with 0-3 true ids, non-overlapping, seed-chosen.
function chooseWindows(rows, site, threshold, steps, pick) {
  const starts = []
  const fits = (a) => trueIds(rows.slice(a - 1, a - 1 + WINDOW), site, threshold).length <= 3 && starts.every((b) => Math.abs(a - b) >= WINDOW)
  for (let attempt = 0; attempt < 2000 && starts.length < steps; attempt++) {
    const a = 1 + Math.floor(pick() * (rows.length - WINDOW))
    if (fits(a)) starts.push(a)
  }
  for (let a = 1; a + WINDOW - 1 <= rows.length && starts.length < steps; a += WINDOW) if (fits(a)) starts.push(a)
  return starts
}

export function makeTask(seed, { steps = 6 } = {}) {
  const log = filler(seed, CTX_LINES)
  const rows = log.split("\n").slice(2)
  const pick = rng((seed ^ 0xa5a5a5a5) >>> 0)
  const target = cols(rows[Math.floor(pick() * rows.length)])
  const ticket = `WX-${1000 + Math.floor(pick() * 9000)}`
  const threshold = 12 + Math.floor(pick() * 7)
  const guardAnswer = { id: target[0], site: target[1], threshold, date: target[2] }
  const decision = `Treat any ${target[1]} reading with temp_c above ${threshold}.0 as a confirmed alert for this ticket.`
  const nextStep = `Scan the log windows I send for ${target[1]} readings above the threshold and list their ids.`
  const brief = [
    `Ticket ${ticket}: anomalous station reading under investigation.`,
    `Context: the station network flagged record ${target[0]} at ${target[1]} on ${target[2]}; we are checking whether neighbouring readings in the same log support the alert before escalating to the site lead.`,
    `Record under investigation: id ${target[0]}, site ${target[1]}, date ${target[2]}.`,
    `Alert threshold: temp_c above ${threshold}.0 C.`,
    `Log columns: ${HEADER}.`,
    `Decision: ${decision}`,
    `Next step: ${nextStep}`,
  ].join("\n")
  const workSteps = chooseWindows(rows, target[1], threshold, steps, pick).map((a, i) => {
    const lines = rows.slice(a - 1, a - 1 + WINDOW)
    const body = lines.join("\n")
    const text = `Step ${i + 1}: here are log lines ${a}..${a + WINDOW - 1}:\n${HEADER}\n${body}\nFrom these lines, list the ids at site ${target[1]} whose temp_c exceeds the alert threshold from the brief, comma-separated, or 'none'.`
    return { k: i + 1, a, lines, truth: trueIds(lines, target[1], threshold), prompt: promptOf(text, { fillerLines: WINDOW, fillerChars: body.length }) }
  })
  return {
    seed,
    ticket,
    brief,
    decision,
    nextStep,
    guardAnswer,
    ctxPrompt: promptOf(`[BRIEF]\n${brief}\n\n[LOG]\n${log}\n\n${NULLP}`, { fillerLines: CTX_LINES, fillerChars: log.length }),
    parkPrompt: PARK_PROMPT,
    restorePrompts: { R1: r1Prompt, R2, R3 },
    guardPromptRaw: GUARD_RAW,
    workSteps,
  }
}

// ------------------------------------------------------------------ scoring

const byNumber = (xs) => [...xs].map(String).sort((a, b) => Number(a) - Number(b))

// Exact match on the id set: every listed integer token must be a true id and vice versa.
export function scoreWork(answerText, truth) {
  const expected = Array.isArray(truth) ? byNumber(truth) : []
  if (typeof answerText !== "string" || !Array.isArray(truth)) return { correct: false, answered: [], expected }
  const text = answerText.trim()
  const answered = /^\W*none\W*$/i.test(text) ? [] : byNumber(new Set(text.split(/[\s,;]+/).filter((t) => /^\d+$/.test(t))))
  const correct = answered.length === expected.length && answered.every((v, i) => v === expected[i])
  return { correct, answered, expected }
}

const idPattern = (id) => new RegExp(`(^|[^\\d])${String(id)}([^\\d]|$)`)

export function scoreGuard(answerText, guardAnswer) {
  if (typeof answerText !== "string" || !guardAnswer) return { correct: false, id: false, site: false, threshold: false }
  const id = idPattern(guardAnswer.id).test(answerText)
  const site = answerText.toLowerCase().includes(String(guardAnswer.site).toLowerCase())
  const threshold = (answerText.match(/\d+(?:\.\d+)?/g) ?? []).some((n) => Number(n) === Number(guardAnswer.threshold))
  return { correct: id && site && threshold, id, site, threshold }
}

// R2 counts as a re-explanation request when the answer asks the user to (re)supply the log or
// data. Merely mentioning the log ("the windows you send") is not a request, so the patterns
// are anchored on a request verb aimed at the user or on a stated lack of the data.
const DATA = "(?:the\\s+|your\\s+|those\\s+|these\\s+|any\\s+)?(?:actual\\s+|raw\\s+|full\\s+|original\\s+)?(?:logs?|lines|data|records?|file|table|readings)"
const REEXPLAIN = [
  /\b(?:could|can|would|will|please)\s+you\s+(?:re-?send|send|share|provide|paste|attach|forward|give|show)\b/i,
  /\b(?:please|kindly)\s+(?:re-?send|send|share|provide|paste|attach|forward)\b/i,
  /\bi\s+(?:would\s+|will\s+|'d\s+)?need\s+you\s+to\s+(?:re-?send|send|share|provide|paste|attach|forward)\b/i,
  new RegExp(`\\b(?:i\\s+(?:would\\s+|will\\s+|'d\\s+)?need|i\\s+am\\s+missing|i'm\\s+missing|missing)\\s+${DATA}\\b`, "i"),
  new RegExp(`\\b(?:do\\s+not|don't|no\\s+longer|never)\\s+have\\s+(?:access\\s+to\\s+)?${DATA}\\b`, "i"),
  new RegExp(`\\b(?:need|require)\\s+(?:access\\s+to\\s+)?${DATA}\\b`, "i"),
]
export function reexplainNeeded(text) {
  if (typeof text !== "string") return false
  return REEXPLAIN.some((re) => re.test(text))
}

// A handoff that does not carry the record id cannot restore the investigation.
export function handoffLossy(handoffText, guardAnswer) {
  return typeof handoffText !== "string" || !idPattern(guardAnswer.id).test(handoffText)
}
