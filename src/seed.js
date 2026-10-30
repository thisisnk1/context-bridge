import { db, id, now, run } from './db.js';

if (db.prepare('SELECT COUNT(*) AS count FROM handoffs').get().count > 0) {
  console.log('Database already has data; seed skipped.');
  process.exit(0);
}
const stamp = now();
const handoffId = id('hnd');
run('INSERT INTO knowledge_items VALUES (?, ?, ?, ?, ?)', id('knw'), 'Release checklist', 'Before a customer-facing release: confirm owner, rollback contact, status-page wording, monitoring and approval.', JSON.stringify(['release', 'ops']), stamp);
run('INSERT INTO handoffs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', handoffId, 'Mobile release handover', 'meeting', 'Release readiness and incident ownership', JSON.stringify(['Asha', 'Rohan', 'Meera']), 'Asha: We approved the mobile release for Friday. Rohan will validate the rollback plan by 2026-11-02. Meera: monitoring needs an owner before launch.', 'Demo meeting notes', 'The Friday mobile release is approved pending a rollback-plan validation and named monitoring owner.', JSON.stringify([{ text: 'The mobile release is approved for Friday.', evidence: 'We approved the mobile release for Friday.', source_label: 'Demo meeting notes' }]), JSON.stringify(['Who owns monitoring during launch?']), 'fallback', stamp, stamp);
run('INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id('act'), handoffId, 'Validate the rollback plan', 'Rohan', '2026-11-02', 'in_progress', '', 'Rohan will validate the rollback plan by 2026-11-02.', 'Demo meeting notes', '', stamp, stamp);
run('INSERT INTO actions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id('act'), handoffId, 'Assign a monitoring owner', '', '', 'open', '', 'monitoring needs an owner before launch.', 'Demo meeting notes', '', stamp, stamp);
console.log('Demo data seeded.');
