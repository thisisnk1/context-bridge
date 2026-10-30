import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.resolve('logs');
const LOG_FILE = path.join(LOG_DIR, 'app.jsonl');
fs.mkdirSync(LOG_DIR, { recursive: true });

export function log(level, event, fields = {}) {
  const entry = { timestamp: new Date().toISOString(), level, event, ...fields };
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  if (level === 'error') console.error(JSON.stringify(entry));
  return entry;
}
