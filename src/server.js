import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import './config.js';
import { all, db, event, id, json, now, one, run, transaction, uploadDir } from './db.js';
import { log } from './logger.js';
import { aiStatus, analyse, createBrief, relevantKnowledge, transcribeAudio } from './services/ai.js';

const PORT = Number(process.env.PORT || 3333);
const PUBLIC = path.resolve('public');
// Audio arrives base64-encoded from the browser, so permit the small encoding overhead.
const MAX_JSON = 28 * 1024 * 1024;
const audioTypes = new Set(['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm']);

function serializeHandoff(row) {
  if (!row) return null;
  const actions = all('SELECT * FROM actions WHERE handoff_id = ? ORDER BY CASE status WHEN \'done\' THEN 1 ELSE 0 END, due_date, created_at', row.id);
  const links = all('SELECT l.*, k.title, k.tags FROM links l JOIN knowledge_items k ON k.id = l.knowledge_id WHERE l.handoff_id = ? ORDER BY l.score DESC', row.id).map((l) => ({ ...l, tags: json(l.tags) }));
  const risks = [];
  if (row.ai_mode === 'fallback') risks.push('AI was unavailable: review this fallback recap before relying on it.');
  for (const action of actions.filter((a) => a.status !== 'done')) {
    if (!action.owner) risks.push(`Unassigned action: ${action.title}`);
    if (!action.due_date) risks.push(`No due date: ${action.title}`);
  }
  return { ...row, participants: json(row.participants), decisions: json(row.decisions), questions: json(row.questions), actions, links, risks };
}
function dashboard() {
  const handoffs = all('SELECT * FROM handoffs ORDER BY created_at DESC').map(serializeHandoff);
  const actions = all('SELECT a.*, h.title AS handoff_title, h.ai_mode AS handoff_ai_mode FROM actions a JOIN handoffs h ON h.id = a.handoff_id ORDER BY CASE a.status WHEN \'done\' THEN 1 ELSE 0 END, a.due_date, a.created_at');
  const knowledge = all('SELECT * FROM knowledge_items ORDER BY created_at DESC').map((k) => ({ ...k, tags: json(k.tags), attachments: all('SELECT id, name, mime_type, size_bytes, created_at FROM knowledge_attachments WHERE knowledge_id = ? ORDER BY created_at', k.id).map((attachment) => ({ ...attachment, url: `/api/knowledge/attachments/${attachment.id}` })) }));
  const recordings = all('SELECT * FROM recordings ORDER BY created_at DESC');
  const events = all('SELECT * FROM events ORDER BY created_at DESC LIMIT 20');
  return { handoffs, actions, knowledge, recordings, events, stats: { handoffs: handoffs.length, open_actions: actions.filter((a) => a.status !== 'done').length, knowledge: knowledge.length, transfer_risks: handoffs.reduce((sum, h) => sum + h.risks.length, 0) } };
}
function send(res, status, body, correlationId) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-correlation-id': correlationId });
  res.end(JSON.stringify({ ...body, correlation_id: correlationId }));
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_JSON) throw new Error('Payload exceeds the 25 MB local limit.'); chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Request body must be valid JSON.'); }
}
function requireText(value, name, min = 1) {
  const clean = String(value || '').trim();
  if (clean.length < min) throw new Error(`${name} is required.`);
  return clean;
}
function safeName(name) { return path.basename(String(name || 'recording')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 90) || 'recording'; }
function staticFile(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const file = path.resolve(PUBLIC, relative);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const ext = path.extname(file); const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-cache' }); fs.createReadStream(file).pipe(res); return true;
}
function createHandoffFromAnalysis({ raw, sourceLabel, title, kind, agenda, analysis, knowledge, correlationId }) {
  const handoffId = id('hnd'); const stamp = now();
  const result = analysis;
  transaction(() => {
    run('INSERT INTO handoffs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', handoffId, result.title, kind, agenda || '', JSON.stringify(result.participants), raw, sourceLabel, result.summary, JSON.stringify(result.decisions), JSON.stringify(result.questions), result.mode, stamp, stamp);
    for (const action of result.actions) run('INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id('act'), handoffId, action.title, action.owner, action.due_date, 'open', '', action.evidence, sourceLabel, '', stamp, stamp);
    for (const item of knowledge) run('INSERT OR IGNORE INTO links VALUES (?, ?, ?, ?, ?, ?)', id('lnk'), handoffId, item.id, item.score, `Shared terms: ${item.reason}`, stamp);
    event('handoff_created', 'handoff', handoffId, `Created ${result.title}`, correlationId);
  });
  log('info', 'handoff_created', { correlation_id: correlationId, handoff_id: handoffId, ai_mode: result.mode, source: sourceLabel });
  return serializeHandoff(one('SELECT * FROM handoffs WHERE id = ?', handoffId));
}

async function transcribe(recording, correlationId) {
  if (aiStatus().provider === 'gemini') {
    const transcript = requireText(await transcribeAudio((await fsp.readFile(recording.file_path)).toString('base64'), recording.mime_type), 'Transcription');
    run('UPDATE recordings SET transcript = ?, state = ? WHERE id = ?', transcript, 'transcribed', recording.id);
    event('recording_transcribed', 'recording', recording.id, `Transcribed ${recording.name} with Gemini`, correlationId);
    log('info', 'recording_transcribed', { correlation_id: correlationId, recording_id: recording.id, engine: 'gemini', model: aiStatus().voice_model });
    return transcript;
  }
  const cli = process.env.WHISPER_CLI; const model = process.env.WHISPER_MODEL;
  if (!cli || !model) throw new Error('Local transcription is not configured. Set WHISPER_CLI and WHISPER_MODEL in .env, or paste a transcript as a message dump.');
  if (!fs.existsSync(cli) || !fs.existsSync(model)) throw new Error('Configured Whisper executable or model cannot be found. Check the paths in .env.');
  const outputBase = path.join(uploadDir, `${recording.id}_transcript`);
  await new Promise((resolve, reject) => {
    const child = spawn(cli, ['-m', model, '-f', recording.file_path, '-otxt', '-of', outputBase], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Whisper exited with ${code}: ${stderr.slice(-180)}`)));
  });
  const transcriptPath = `${outputBase}.txt`;
  const transcript = requireText(await fsp.readFile(transcriptPath, 'utf8'), 'Transcription');
  run('UPDATE recordings SET transcript = ?, state = ? WHERE id = ?', transcript, 'transcribed', recording.id);
  event('recording_transcribed', 'recording', recording.id, `Transcribed ${recording.name} locally`, correlationId);
  log('info', 'recording_transcribed', { correlation_id: correlationId, recording_id: recording.id, engine: 'whisper_cli' });
  return transcript;
}

const server = http.createServer(async (req, res) => {
  const correlationId = String(req.headers['x-correlation-id'] || id('req')).slice(0, 80);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const method = req.method;
  try {
    if (!url.pathname.startsWith('/api/')) { if (!staticFile(req, res)) send(res, 404, { error: 'Not found' }, correlationId); return; }
    if (method === 'GET' && url.pathname === '/api/dashboard') return send(res, 200, dashboard(), correlationId);
    if (method === 'GET' && url.pathname === '/api/config') return send(res, 200, { ai: aiStatus() }, correlationId);
    const attachmentMatch = url.pathname.match(/^\/api\/knowledge\/attachments\/([^/]+)$/);
    if (method === 'GET' && attachmentMatch) {
      const attachment = one('SELECT * FROM knowledge_attachments WHERE id = ?', attachmentMatch[1]);
      if (!attachment || !fs.existsSync(attachment.file_path)) return send(res, 404, { error: 'Attachment not found.' }, correlationId);
      res.writeHead(200, { 'content-type': attachment.mime_type, 'content-length': attachment.size_bytes, 'content-disposition': `attachment; filename="${attachment.name.replace(/"/g, '')}"` });
      fs.createReadStream(attachment.file_path).pipe(res);
      return;
    }
    if (method === 'GET' && url.pathname.startsWith('/api/handoffs/')) {
      const handoff = serializeHandoff(one('SELECT * FROM handoffs WHERE id = ?', url.pathname.split('/')[3]));
      if (!handoff) return send(res, 404, { error: 'Handoff not found.' }, correlationId); return send(res, 200, { handoff }, correlationId);
    }
    if (method === 'POST' && url.pathname === '/api/intakes/text') {
      const payload = await body(req); const raw = requireText(payload.raw_text, 'Message dump or transcript', 12); const sourceLabel = requireText(payload.source_label, 'Source label');
      const { result, knowledge } = await analyse(raw, sourceLabel, payload.title, correlationId);
      const handoff = createHandoffFromAnalysis({ raw, sourceLabel, title: payload.title, kind: payload.kind === 'handover' ? 'handover' : 'meeting', agenda: String(payload.agenda || '').trim(), analysis: result, knowledge, correlationId });
      const provider = aiStatus();
      return send(res, 201, { handoff, notice: result.mode === 'fallback' ? 'Saved with an editable fallback recap because the AI provider was unavailable.' : 'Structured recap generated with ' + provider.label + '.' }, correlationId);
    }
    if (method === 'POST' && url.pathname === '/api/knowledge') {
      const payload = await body(req); const title = requireText(payload.title, 'Knowledge title'); const content = requireText(payload.content, 'Knowledge content', 10); const tags = String(payload.tags || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10); const attachments = Array.isArray(payload.attachments) ? payload.attachments.slice(0, 5) : []; const item = { id: id('knw'), title, content, tags, created_at: now() };
      const storedAttachments = [];
      let totalBytes = 0;
      for (const attachment of attachments) {
        const name = safeName(requireText(attachment.name, 'Attachment name'));
        const mimeType = String(attachment.mime_type || 'application/octet-stream').slice(0, 120);
        const bytes = Buffer.from(requireText(attachment.base64, 'Attachment data'), 'base64');
        totalBytes += bytes.length;
        if (!bytes.length || bytes.length > 10 * 1024 * 1024 || totalBytes > 20 * 1024 * 1024) throw new Error('Each attachment must be between 1 byte and 10 MB, with a 20 MB total limit.');
        const record = { id: id('att'), name, mime_type: mimeType, file_path: path.join(uploadDir, `${Date.now()}_${id('file')}_${name}`), size_bytes: bytes.length, created_at: item.created_at };
        await fsp.writeFile(record.file_path, bytes);
        storedAttachments.push(record);
      }
      transaction(() => {
        run('INSERT INTO knowledge_items VALUES (?, ?, ?, ?, ?)', item.id, item.title, item.content, JSON.stringify(item.tags), item.created_at);
        for (const attachment of storedAttachments) run('INSERT INTO knowledge_attachments VALUES (?, ?, ?, ?, ?, ?, ?)', attachment.id, item.id, attachment.name, attachment.mime_type, attachment.file_path, attachment.size_bytes, attachment.created_at);
      });
      event('knowledge_created', 'knowledge', item.id, `Added knowledge: ${item.title}`, correlationId); log('info', 'knowledge_created', { correlation_id: correlationId, knowledge_id: item.id });
      return send(res, 201, { knowledge: { ...item, attachments: storedAttachments.map((attachment) => ({ id: attachment.id, name: attachment.name, mime_type: attachment.mime_type, size_bytes: attachment.size_bytes, url: `/api/knowledge/attachments/${attachment.id}` })) } }, correlationId);
    }
    if (method === 'POST' && url.pathname === '/api/actions') {
      const payload = await body(req);
      const title = requireText(payload.title, 'Commitment', 2).slice(0, 240);
      const handoffId = requireText(payload.handoff_id, 'Handoff');
      const handoff = one('SELECT * FROM handoffs WHERE id = ?', handoffId);
      if (!handoff) return send(res, 404, { error: 'Handoff not found.' }, correlationId);
      const owner = String(payload.owner || '').trim().slice(0, 60);
      const due = String(payload.due_date || '').trim();
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('Due date must be YYYY-MM-DD.');
      const status = String(payload.status || 'open');
      if (!['open', 'in_progress', 'blocked', 'done'].includes(status)) throw new Error('Status must be open, in_progress, blocked or done.');
      const stamp = now();
      const actionId = id('act');
      run('INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', actionId, handoffId, title, owner, due, status, '', 'Added manually by the team.', 'Manual commitment', '', stamp, stamp);
      event('action_created', 'action', actionId, `Added commitment: ${title}`, correlationId);
      log('info', 'action_created', { correlation_id: correlationId, action_id: actionId, handoff_id: handoffId });
      return send(res, 201, { action: one('SELECT * FROM actions WHERE id = ?', actionId) }, correlationId);
    }
    if (method === 'POST' && url.pathname === '/api/recordings') {
      const payload = await body(req); const name = safeName(requireText(payload.name, 'Recording name')); const mime = String(payload.mime_type || 'audio/mpeg'); if (!audioTypes.has(mime)) throw new Error('Only MP3, M4A/MP4, WAV, OGG and WebM audio files are accepted.');
      const base64 = requireText(payload.base64, 'Recording data'); const bytes = Buffer.from(base64, 'base64'); if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('Audio must be between 1 byte and 20 MB.');
      const recording = { id: id('rec'), name, mime_type: mime, file_path: path.join(uploadDir, `${Date.now()}_${name}`), size_bytes: bytes.length, created_at: now() }; await fsp.writeFile(recording.file_path, bytes);
      run('INSERT INTO recordings VALUES (?, ?, ?, ?, ?, ?, ?, ?)', recording.id, recording.name, recording.mime_type, recording.file_path, recording.size_bytes, '', 'stored', recording.created_at);
      event('recording_stored', 'recording', recording.id, `Stored ${recording.name}`, correlationId); log('info', 'recording_stored', { correlation_id: correlationId, recording_id: recording.id, bytes: recording.size_bytes });
      return send(res, 201, { recording: { ...recording, transcript: '', state: 'stored' } }, correlationId);
    }
    const recordingMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)\/transcribe$/);
    if (method === 'POST' && recordingMatch) {
      const recording = one('SELECT * FROM recordings WHERE id = ?', recordingMatch[1]); if (!recording) return send(res, 404, { error: 'Recording not found.' }, correlationId);
      const transcript = await transcribe(recording, correlationId); return send(res, 200, { transcript, recording: one('SELECT * FROM recordings WHERE id = ?', recording.id) }, correlationId);
    }
    const briefMatch = url.pathname.match(/^\/api\/handoffs\/([^/]+)\/brief$/);
    if (method === 'POST' && briefMatch) {
      const handoff = serializeHandoff(one('SELECT * FROM handoffs WHERE id = ?', briefMatch[1])); if (!handoff) return send(res, 404, { error: 'Handoff not found.' }, correlationId);
      const result = await createBrief(handoff, handoff.actions, correlationId); event('brief_generated', 'handoff', handoff.id, `Generated catch-up brief (${result.mode})`, correlationId); return send(res, 200, result, correlationId);
    }
    const reanalyseMatch = url.pathname.match(/^\/api\/handoffs\/([^/]+)\/reanalyze$/);
    if (method === 'POST' && reanalyseMatch) {
      const current = serializeHandoff(one('SELECT * FROM handoffs WHERE id = ?', reanalyseMatch[1]));
      if (!current) return send(res, 404, { error: 'Handoff not found.' }, correlationId);
      const { result, knowledge } = await analyse(current.raw_text, current.source_label, current.title, correlationId);
      // Never overwrite a visible recap with another fallback. The user retains the
      // original until the configured model returns a validated response.
      if (result.mode === 'fallback') return send(res, 503, { error: 'The configured AI provider did not complete this run. The existing recap was left unchanged; try again shortly.' }, correlationId);
      const stamp = now();
      transaction(() => {
        run('UPDATE handoffs SET title = ?, participants = ?, summary = ?, decisions = ?, questions = ?, ai_mode = ?, updated_at = ? WHERE id = ?', result.title, JSON.stringify(result.participants), result.summary, JSON.stringify(result.decisions), JSON.stringify(result.questions), result.mode, stamp, current.id);
        const existingTitles = new Set(all('SELECT title FROM actions WHERE handoff_id = ?', current.id).map((action) => action.title.toLowerCase()));
        for (const action of result.actions) {
          if (!existingTitles.has(action.title.toLowerCase())) run('INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id('act'), current.id, action.title, action.owner, action.due_date, 'open', '', action.evidence, current.source_label, '', stamp, stamp);
        }
        for (const item of knowledge) run('INSERT OR IGNORE INTO links VALUES (?, ?, ?, ?, ?, ?)', id('lnk'), current.id, item.id, item.score, `Shared terms: ${item.reason}`, stamp);
        event('handoff_reanalyzed', 'handoff', current.id, `Re-analysed ${result.title} with ${aiStatus().label}`, correlationId);
      });
      log('info', 'handoff_reanalyzed', { correlation_id: correlationId, handoff_id: current.id, provider: aiStatus().provider, model: aiStatus().model });
      return send(res, 200, { handoff: serializeHandoff(one('SELECT * FROM handoffs WHERE id = ?', current.id)), notice: 'Re-analysed with ' + aiStatus().label + '.' }, correlationId);
    }
    const carryMatch = url.pathname.match(/^\/api\/handoffs\/([^/]+)\/carry-forward$/);
    if (method === 'POST' && carryMatch) {
      const source = serializeHandoff(one('SELECT * FROM handoffs WHERE id = ?', carryMatch[1])); if (!source) return send(res, 404, { error: 'Handoff not found.' }, correlationId);
      const openActions = source.actions.filter((a) => a.status !== 'done'); const created = now(); const targetId = id('hnd');
      transaction(() => { run('INSERT INTO handoffs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', targetId, `Follow-up: ${source.title}`, 'handover', `Carry-forward from ${source.title}`, JSON.stringify(source.participants), `Follow-up created from ${source.title}.`, `Carry-forward from ${source.title}`, `Open work carried forward from ${source.title}. Confirm status, owners and dates before the next meeting.`, '[]', '[]', source.ai_mode, created, created); for (const action of openActions) run('INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id('act'), targetId, action.title, action.owner, action.due_date, action.status, action.outcome, action.evidence, action.source_label, action.id, created, created); event('actions_carried_forward', 'handoff', targetId, `Carried ${openActions.length} open item(s) from ${source.title}`, correlationId); });
      log('info', 'actions_carried_forward', { correlation_id: correlationId, from_handoff_id: source.id, to_handoff_id: targetId, actions: openActions.length }); return send(res, 201, { handoff: serializeHandoff(one('SELECT * FROM handoffs WHERE id = ?', targetId)) }, correlationId);
    }
    const actionMatch = url.pathname.match(/^\/api\/actions\/([^/]+)$/);
    if (method === 'PATCH' && actionMatch) {
      const action = one('SELECT * FROM actions WHERE id = ?', actionMatch[1]); if (!action) return send(res, 404, { error: 'Action not found.' }, correlationId); const payload = await body(req);
      const owner = payload.owner === undefined ? action.owner : String(payload.owner).trim().slice(0, 60); const due = payload.due_date === undefined ? action.due_date : String(payload.due_date).trim(); if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('Due date must be YYYY-MM-DD.'); const status = payload.status === undefined ? action.status : String(payload.status); if (!['open', 'in_progress', 'blocked', 'done'].includes(status)) throw new Error('Status must be open, in_progress, blocked or done.'); const outcome = payload.outcome === undefined ? action.outcome : String(payload.outcome).trim().slice(0, 800); const stamp = now();
      run('UPDATE actions SET owner = ?, due_date = ?, status = ?, outcome = ?, updated_at = ? WHERE id = ?', owner, due, status, outcome, stamp, action.id); const changes = []; if (owner !== action.owner) changes.push('reassigned'); if (status !== action.status) changes.push(status === 'done' ? 'closed' : `status ${status}`); event(status === 'done' ? 'action_closed' : 'action_updated', 'action', action.id, `${action.title}: ${changes.join(', ') || 'updated'}`, correlationId); log('info', status === 'done' ? 'action_closed' : 'action_updated', { correlation_id: correlationId, action_id: action.id, changes }); return send(res, 200, { action: one('SELECT * FROM actions WHERE id = ?', action.id) }, correlationId);
    }
    return send(res, 404, { error: 'API route not found.' }, correlationId);
  } catch (error) {
    const safe = String(error.message || 'Unexpected error').slice(0, 300); log('error', 'request_failed', { correlation_id: correlationId, method, path: url.pathname, error: safe }); return send(res, /required|must be|Only |Payload|between 1 byte|configured|cannot be found/i.test(safe) ? 422 : 500, { error: safe }, correlationId);
  }
});

function seedDemoIfEmpty() {
  if (one('SELECT COUNT(*) AS count FROM handoffs').count > 0) return;
  const stamp = now(); const handoffId = id('hnd'); const knowledgeId = id('knw');
  transaction(() => {
    run('INSERT INTO knowledge_items VALUES (?, ?, ?, ?, ?)', knowledgeId, 'Release checklist', 'Before a customer-facing release: confirm owner, rollback contact, status-page wording, monitoring and approval.', JSON.stringify(['release', 'ops']), stamp);
    run('INSERT INTO handoffs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', handoffId, 'Mobile release handover', 'meeting', 'Release readiness and incident ownership', JSON.stringify(['Asha', 'Rohan', 'Meera']), 'Asha: We approved the mobile release for Friday. Rohan will validate the rollback plan by 2026-11-02. Meera: monitoring needs an owner before launch.', 'Demo meeting notes', 'The Friday mobile release is approved pending a rollback-plan validation and named monitoring owner.', JSON.stringify([{ text: 'The mobile release is approved for Friday.', evidence: 'We approved the mobile release for Friday.', source_label: 'Demo meeting notes' }]), JSON.stringify(['Who owns monitoring during launch?']), 'fallback', stamp, stamp);
    run('INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id('act'), handoffId, 'Validate the rollback plan', 'Rohan', '2026-11-02', 'in_progress', '', 'Rohan will validate the rollback plan by 2026-11-02.', 'Demo meeting notes', '', stamp, stamp);
    run('INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id('act'), handoffId, 'Assign a monitoring owner', '', '', 'open', '', 'monitoring needs an owner before launch.', 'Demo meeting notes', '', stamp, stamp);
  });
  log('info', 'demo_seeded', { service: 'context-bridge' });
}

seedDemoIfEmpty();
server.listen(PORT, () => { log('info', 'server_started', { port: PORT, service: 'context-bridge' }); console.log(`Context Bridge running at http://localhost:${PORT}`); });
