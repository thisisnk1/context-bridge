import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });
export const uploadDir = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'context-bridge.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS handoffs (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL,
    agenda TEXT NOT NULL DEFAULT '', participants TEXT NOT NULL DEFAULT '[]',
    raw_text TEXT NOT NULL, source_label TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
    decisions TEXT NOT NULL DEFAULT '[]', questions TEXT NOT NULL DEFAULT '[]',
    ai_mode TEXT NOT NULL DEFAULT 'fallback', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
    title TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','blocked','done')),
    outcome TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '', source_label TEXT NOT NULL DEFAULT '',
    carried_from TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS knowledge_items (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS knowledge_attachments (
    id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    name TEXT NOT NULL, mime_type TEXT NOT NULL, file_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, mime_type TEXT NOT NULL, file_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL, transcript TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'stored',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
    knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    score REAL NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(handoff_id, knowledge_id)
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL, message TEXT NOT NULL, correlation_id TEXT NOT NULL, created_at TEXT NOT NULL
  );
`);

export const now = () => new Date().toISOString();
export const id = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
export function one(sql, ...params) { return db.prepare(sql).get(...params); }
export function all(sql, ...params) { return db.prepare(sql).all(...params); }
export function run(sql, ...params) { return db.prepare(sql).run(...params); }
export function transaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function json(value, fallback = []) {
  try { return JSON.parse(value ?? JSON.stringify(fallback)); } catch { return fallback; }
}
export function event(type, entityType, entityId, message, correlationId) {
  const createdAt = now();
  run('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)', id('evt'), type, entityType, entityId, message, correlationId, createdAt);
}
