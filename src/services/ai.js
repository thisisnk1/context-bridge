import '../config.js';
import { all } from '../db.js';
import { log } from '../logger.js';

const MAX_RAW = 18000;
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_VOICE_MODEL = process.env.GEMINI_VOICE_MODEL || GEMINI_MODEL;
const usingGemini = Boolean(GEMINI_API_KEY);

export function aiStatus() {
  return usingGemini
    ? { provider: 'gemini', model: GEMINI_MODEL, voice_model: GEMINI_VOICE_MODEL, label: 'Gemini', detail: 'Google AI API · text and voice' }
    : { provider: 'none', model: '', voice_model: '', label: 'Gemini not configured', detail: 'deterministic review drafts only' };
}
function clip(value, size) { return String(value || '').trim().slice(0, size); }
function sentence(text) { return clip(String(text || '').replace(/\s+/g, ' '), 280) || 'Review the original source for the complete context.'; }
function evidenceFor(raw, needle) {
  const chunks = String(raw).split(/(?<=[.!?\n])/).map((part) => part.trim()).filter(Boolean);
  return clip(chunks.find((part) => needle && part.toLowerCase().includes(String(needle).toLowerCase())) || chunks[0] || raw, 240);
}
function normalizeArray(values) { return Array.isArray(values) ? values.filter(Boolean).map((value) => typeof value === 'string' ? value : String(value)) : []; }
function activeMode() { return usingGemini ? 'gemini' : 'fallback'; }

export function relevantKnowledge(raw) {
  const tokens = new Set((String(raw).toLowerCase().match(/[a-z]{4,}/g) || []).slice(0, 200));
  return all('SELECT * FROM knowledge_items ORDER BY created_at DESC LIMIT 40').map((item) => {
    const haystack = (item.title + ' ' + item.content).toLowerCase();
    const hits = [...tokens].filter((token) => haystack.includes(token));
    return { ...item, score: hits.length, reason: hits.slice(0, 4).join(', ') };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
}

function fallback(raw, sourceLabel, titleHint) {
  const lines = String(raw).split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const actionLines = lines.filter((line) => /\b(action|todo|to do|follow ?up|owner|will |please |by \w+day|due)\b/i.test(line));
  const decisionLines = lines.filter((line) => /\b(decided|decision|approved|agreed|confirm|will use|chosen)\b/i.test(line));
  const participants = [...new Set(lines.map((line) => line.match(/^([A-Z][a-z]{1,20})\s*[:\-]/)?.[1]).filter(Boolean))].slice(0, 8);
  const toAction = (line, index) => {
    const owner = line.match(/(?:owner|@)\s*[:\-]?\s*([A-Za-z][\w .-]{1,35})/i)?.[1]?.trim() || '';
    const due = line.match(/(?:due|by)\s*[:\-]?\s*(\d{4}-\d{2}-\d{2})/i)?.[1] || '';
    return { title: sentence(line), owner, due_date: due, evidence: evidenceFor(raw, line), source_label: sourceLabel, key: index };
  };
  return {
    title: clip(titleHint, 90) || clip(lines[0]?.replace(/^.{0,35}[:\-]\s*/, ''), 90) || 'Untitled work transfer',
    summary: 'Draft recap: ' + sentence(lines.slice(0, 3).join(' ')),
    participants,
    decisions: (decisionLines.length ? decisionLines : lines.filter((line) => /\bwe\b/i.test(line)).slice(0, 3)).slice(0, 5).map((line) => ({ text: sentence(line), evidence: evidenceFor(raw, line), source_label: sourceLabel })),
    actions: (actionLines.length ? actionLines : lines.slice(1, 3)).slice(0, 8).map(toAction),
    questions: lines.filter((line) => line.includes('?')).slice(0, 5),
    mode: 'fallback'
  };
}

function parseModel(jsonText, raw, sourceLabel, titleHint, mode) {
  const fence = String.fromCharCode(96).repeat(3);
  let clean = String(jsonText).trim();
  if (clean.toLowerCase().startsWith(fence + 'json')) clean = clean.slice((fence + 'json').length).trim();
  if (clean.endsWith(fence)) clean = clean.slice(0, -fence.length).trim();
  const parsed = JSON.parse(clean);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.summary !== 'string') throw new Error('Model did not return a recap object');
  const actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 12).map((action, index) => ({
    title: sentence(action?.title || action?.text || ('Action ' + (index + 1))),
    owner: clip(action?.owner, 50), due_date: /^\d{4}-\d{2}-\d{2}$/.test(action?.due_date || '') ? action.due_date : '',
    evidence: clip(action?.evidence, 240) || evidenceFor(raw, action?.title || action?.text), source_label: sourceLabel, key: index
  })) : [];
  return {
    title: clip(parsed.title, 90) || clip(titleHint, 90) || 'Untitled work transfer',
    summary: clip(parsed.summary, 1000), participants: normalizeArray(parsed.participants).slice(0, 20),
    decisions: (Array.isArray(parsed.decisions) ? parsed.decisions : []).slice(0, 12).map((decision) => ({
      text: sentence(typeof decision === 'string' ? decision : decision?.text), evidence: clip(decision?.evidence, 240) || evidenceFor(raw, typeof decision === 'string' ? decision : decision?.text), source_label: sourceLabel
    })), actions, questions: normalizeArray(parsed.questions).slice(0, 8), mode
  };
}

async function geminiRequest(model, contents, options = {}) {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      contents,
      generationConfig: { temperature: options.temperature ?? 0.15, ...(options.json ? { responseMimeType: 'application/json' } : {}) }
    }),
    signal: AbortSignal.timeout(60000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('Gemini returned ' + response.status + ': ' + clip(body?.error?.message || 'request failed', 160));
  const output = body?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();
  if (!output) throw new Error('Gemini returned no text');
  return output;
}
async function geminiGenerate(prompt, options = {}) {
  return geminiRequest(GEMINI_MODEL, [{ role: 'user', parts: [{ text: prompt }] }], options);
}

export async function transcribeAudio(audioBase64, mimeType) {
  if (!usingGemini) throw new Error('Gemini voice transcription is not configured. Set GEMINI_API_KEY in .env.');
  return geminiRequest(GEMINI_VOICE_MODEL, [{
    role: 'user',
    parts: [
      { inlineData: { mimeType, data: audioBase64 } },
      { text: 'Transcribe this recording exactly. Keep speaker changes and meaningful dates or action items. Return only the transcript text, with no commentary.' }
    ]
  }], { temperature: 0 });
}

async function generate(prompt, options) {
  if (!usingGemini) throw new Error('Gemini is not configured. Set GEMINI_API_KEY in .env.');
  return geminiGenerate(prompt, options);
}

export async function analyse(raw, sourceLabel, titleHint, correlationId) {
  const knowledge = relevantKnowledge(raw);
  const context = knowledge.map((item) => '- ' + item.title + ': ' + clip(item.content, 420)).join('\n') || '(No related local knowledge yet.)';
  const prompt = 'You are a careful knowledge-transfer analyst. Return ONLY valid JSON, no markdown. Do not invent facts, owners or dates. If unknown, use an empty string.\nSchema: {"title":"","summary":"","participants":[""],"decisions":[{"text":"","evidence":"exact short source quote"}],"actions":[{"title":"","owner":"","due_date":"YYYY-MM-DD or empty","evidence":"exact short source quote"}],"questions":[""]}.\nRaw source (' + sourceLabel + '):\n' + clip(raw, MAX_RAW) + '\n\nRelated team knowledge (may be irrelevant):\n' + context;
  const started = Date.now(); const status = aiStatus();
  try {
    const output = await generate(prompt, { json: true, temperature: 0.1 });
    const result = parseModel(output, raw, sourceLabel, titleHint, activeMode());
    log('info', 'ai_analysis', { correlation_id: correlationId, outcome: 'success', latency_ms: Date.now() - started, provider: status.provider, model: status.model });
    return { result, knowledge };
  } catch (error) {
    log('warn', 'ai_analysis', { correlation_id: correlationId, outcome: 'fallback', latency_ms: Date.now() - started, provider: status.provider, model: status.model, reason: String(error.message).slice(0, 160) });
    return { result: fallback(raw, sourceLabel, titleHint), knowledge };
  }
}

export async function createBrief(handoff, actions, correlationId) {
  const open = actions.filter((action) => action.status !== 'done').map((action) => action.title + ' [owner: ' + (action.owner || 'unassigned') + '; due: ' + (action.due_date || 'unset') + ']').join('\n');
  const prompt = 'Create a short, practical catch-up brief for someone taking over this work. Mention decisions, current state, risks and next actions. Do not invent facts. Keep under 180 words.\nTitle: ' + handoff.title + '\nSummary: ' + handoff.summary + '\nDecisions: ' + JSON.stringify(handoff.decisions) + '\nOpen actions:\n' + (open || 'None');
  const started = Date.now(); const status = aiStatus();
  try {
    const brief = clip(await generate(prompt, { temperature: 0.15 }), 1600);
    if (!brief) throw new Error('Model returned an empty brief');
    log('info', 'ai_brief', { correlation_id: correlationId, outcome: 'success', latency_ms: Date.now() - started, provider: status.provider, model: status.model });
    return { brief, mode: activeMode() };
  } catch (error) {
    const decisions = handoff.decisions.map((decision) => 'Decision: ' + decision.text).slice(0, 3).join(' ');
    const brief = (handoff.summary + ' ' + decisions + ' Next: ' + (open || 'No open action items.')).trim();
    log('warn', 'ai_brief', { correlation_id: correlationId, outcome: 'fallback', latency_ms: Date.now() - started, provider: status.provider, model: status.model, reason: String(error.message).slice(0, 160) });
    return { brief: clip(brief, 1600), mode: 'fallback' };
  }
}
