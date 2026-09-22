// Fixed request shapes for the idle-cost live run (Appendix A section 0 of
// .omo/plans/idle-experiments-live-run.md). SITES, rng and filler are a verbatim copy of
// quota-test/2026-09-19/run.mjs so every prompt byte matches the 09-19 capture that the
// priors come from. Pure: no I/O, no clock, no ambient randomness.
import { createHash } from "node:crypto"

// Benign, deterministic, non-repeating filler: a synthetic measurement table (avoids safeguard refusals on nonsense text).
export const SITES = "Aberdeen Bristol Cardiff Dundee Exeter Falmouth Glasgow Hull Inverness Jarrow Kendal Leeds Margate Norwich Oxford Plymouth Reading Swansea Truro York".split(" ");
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function filler(seed, lines) {
  const r = rng(seed); const out = ["Weather station log (synthetic test data, seed " + seed + ")", "id,site,date,temp_c,humidity,wind_kph,pressure_hpa"];
  for (let i = 0; i < lines; i++) {
    const d = new Date(Date.UTC(2020, 0, 1) + Math.floor(r() * 2000) * 86400000).toISOString().slice(0, 10);
    out.push(`${i + 1},${SITES[Math.floor(r() * SITES.length)]},${d},${(r() * 35 - 5).toFixed(1)},${Math.floor(r() * 100)},${(r() * 80).toFixed(1)},${(980 + r() * 60).toFixed(1)}`);
  }
  return out.join("\n");
}
export { rng, filler }

export const NULLP = "Hi! Quick connectivity check of my CLI setup. Please respond with just the word OK."
export const outp = (n) => `Please list the integers from 1 to ${n}, one per line, with no other text before or after.`
export const OUTP = outp(2000)

// Token estimates for the cap gate: 29.4 tokens per filler line (09-19: 142,620 tokens for
// 4800 lines incl. the system prompt), chars/3.4 for every other text.
export const FILLER_TOKENS_PER_LINE = 29.4
export const CHARS_PER_TOKEN = 3.4

export const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex")

// The prompt object every StepRequest carries. Only the hash is written to the evidence.
export function promptOf(text, { fillerLines = 0, fillerChars = 0 } = {}) {
  return {
    text,
    sha256: sha256(text),
    chars: text.length,
    tokensEst: Math.round(fillerLines * FILLER_TOKENS_PER_LINE + (text.length - fillerChars) / CHARS_PER_TOKEN),
    fillerLines,
  }
}

// WRITE-n / TTL prefix shape: n filler lines with the NULLP suffix, deterministic per seed.
export function fillerPrompt(seed, lines) {
  const body = filler(seed, lines)
  return promptOf(body + "\n\n" + NULLP, { fillerLines: lines, fillerChars: body.length })
}

// rf-emulation shape: a hot prefix's exact bytes with new text appended after a blank line.
export function appendPrompt(base, text) {
  const full = base.text + "\n\n" + text
  return {
    text: full,
    sha256: sha256(full),
    chars: full.length,
    tokensEst: base.tokensEst + Math.round((2 + text.length) / CHARS_PER_TOKEN),
    fillerLines: base.fillerLines,
  }
}
