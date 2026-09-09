/**
 * Repoint workflow steps at the *_demo WhatsApp templates.
 *
 *   node scripts/switch-workflow-templates.mjs            # dry run
 *   node scripts/switch-workflow-templates.mjs --apply
 *
 * Updates both templateName and templateId on each step. templateName is what the
 * send actually uses (WorkflowController falls back to templateId only when the name
 * is missing), but leaving a stale id behind would resolve to the old template if the
 * name were ever cleared, so both move together.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config({ quiet: true });

const APPLY = process.argv.includes('--apply');
const i = process.argv.indexOf('--uri');
const URI = i >= 0 ? process.argv[i + 1] : process.env.MONGODB_URI;
if (!URI) { console.error('No MONGODB_URI'); process.exit(1); }

// Targets come from config/watiTemplates.js, so the env is the single source of
// truth and this script cannot drift from what the backend believes.
//
// Note meta_2 maps to meta_2_demo_u, NOT meta_2_demo: Meta classified meta_2_demo as
// MARKETING (the original meta_2 is UTILITY) and marketing templates are dropped for
// anyone opted out of marketing. meta_2_demo_u is the reworded UTILITY replacement.
const { WatiWorkflowTemplates } = await import('../config/watiTemplates.js');
const RENAMES = {
  meta_1: WatiWorkflowTemplates.notScheduledImmediate,
  meta_2: WatiWorkflowTemplates.notScheduled8h,
  meta_31: WatiWorkflowTemplates.notScheduled2d,
  meta_41: WatiWorkflowTemplates.notScheduled7d,
};
// A no-op mapping (name unchanged) would churn the document for nothing.
for (const [from, to] of Object.entries(RENAMES)) if (from === to) delete RENAMES[from];

await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });

const BASE = (process.env.WATI_API_BASE_URL || '').replace(/\/+$/, '');
const TOKEN = (process.env.WATI_API_TOKEN || '').replace(/^Bearer\s+/i, '').trim();
const r = await fetch(`${BASE}/${process.env.WATI_TENANT_ID}/api/v1/getMessageTemplates?pageSize=200`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
const templates = (await r.json()).messageTemplates || [];
const byName = Object.fromEntries(templates.map(t => [t.elementName, t]));

for (const [from, to] of Object.entries(RENAMES)) {
  const t = byName[to];
  if (!t) { console.error(`Target template "${to}" not found in WATI — aborting.`); process.exit(1); }
  if (t.status !== 'APPROVED') { console.error(`Target template "${to}" is ${t.status}, not APPROVED — aborting.`); process.exit(1); }
  console.log(`${from.padEnd(12)} -> ${to.padEnd(16)} [${t.status}, ${t.category}, id ${t.id}]`);
}
console.log('');

const W = mongoose.connection.collection('workflows');
const workflows = await W.find({ 'steps.templateName': { $in: Object.keys(RENAMES) } }).toArray();

let changed = 0;
for (const w of workflows) {
  const steps = w.steps || [];
  const edits = [];
  for (const s of steps) {
    const to = RENAMES[s.templateName];
    if (!to) continue;
    edits.push(`order=${s.order} (d=${s.daysAfter ?? 0} h=${s.hoursAfter ?? 0})  ${s.templateName} -> ${to}`);
    if (APPLY) {
      s.templateName = to;
      s.templateId = byName[to].id;
    }
  }
  if (!edits.length) continue;
  console.log(`workflow ${w._id}${w.name ? ` (${w.name})` : ''}, active=${w.isActive}`);
  for (const e of edits) console.log(`   ${e}`);
  changed += edits.length;
  if (APPLY) {
    await W.updateOne({ _id: w._id }, { $set: { steps } });
    console.log('   -> saved');
  }
}

console.log(`\n${APPLY ? 'updated' : 'would update'} ${changed} step(s)`);
if (!APPLY) console.log('Dry run only. Re-run with --apply.');
await mongoose.disconnect();
