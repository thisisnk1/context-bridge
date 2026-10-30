import test from 'node:test';
import assert from 'node:assert/strict';
import { relevantKnowledge } from '../src/services/ai.js';

test('local knowledge retrieval is safe with empty text', () => {
  assert.deepEqual(relevantKnowledge(''), []);
});

test('database schema is available', async () => {
  const { one } = await import('../src/db.js');
  assert.ok(one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'handoffs'"));
});
