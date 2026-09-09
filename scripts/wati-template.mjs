/**
 * Manage WATI WhatsApp templates from the backend instead of the WATI dashboard.
 *
 *   node scripts/wati-template.mjs list                    # every template, with buttons
 *   node scripts/wati-template.mjs show <name>             # full raw record
 *   node scripts/wati-template.mjs dump <name> [outfile]   # existing template -> create payload
 *   node scripts/wati-template.mjs create <file.json>      # DRY RUN, prints the payload
 *   node scripts/wati-template.mjs create <file.json> --apply    # actually submits to Meta
 *
 * Endpoint: POST {WATI_API_BASE_URL}/{WATI_TENANT_ID}/api/v1/whatsApp/templates
 * Verified present on tenant 1033833 (GET returns 405 Method Not Allowed, so the
 * route exists and is POST-only). Note the docs index advertises a hyphenated
 * /api/v1/whatsapp-templates path — that one 404s; this camelCase path is the real one,
 * and the tenant segment is required.
 *
 * `dump` is the fast way to make a variant of something already approved: dump the
 * closest existing template, edit the JSON, then create. Field shapes come out
 * matching a template Meta has already accepted, which is most of the battle.
 *
 * Creating a template files it with Meta for review under your WhatsApp Business
 * Account. It comes back status PENDING and is not sendable until approved. Junk
 * submissions count against account quality, so --apply is deliberately opt-in.
 */
import dotenv from 'dotenv';
import fs from 'node:fs';

dotenv.config({ quiet: true });

const BASE = (process.env.WATI_API_BASE_URL || '').replace(/\/+$/, '');
const TENANT = process.env.WATI_TENANT_ID;
const TOKEN = (process.env.WATI_API_TOKEN || '').replace(/^Bearer\s+/i, '').trim();

if (!BASE || !TOKEN || !TENANT) {
  console.error('Missing WATI_API_BASE_URL, WATI_API_TOKEN or WATI_TENANT_ID in .env');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const [cmd, arg, arg2] = process.argv.slice(2).filter(a => a !== '--apply');
const APPLY = process.argv.includes('--apply');

async function fetchTemplates() {
  const r = await fetch(`${BASE}/${TENANT}/api/v1/getMessageTemplates?pageSize=200`, { headers });
  if (!r.ok) throw new Error(`getMessageTemplates failed: HTTP ${r.status}`);
  return (await r.json()).messageTemplates || [];
}

const findTemplate = (list, name) => list.find(t => t.elementName === name);

/** Reshape an existing template record into a create-endpoint payload. */
function toCreatePayload(t) {
  const buttons = (t.buttons || []).map(b => {
    const p = b.parameter || {};
    if (b.type === 'url') {
      return {
        type: 'url',
        parameter: {
          text: p.text,
          // urlOriginal keeps the real variable index ({{6}}, {{7}}); `url` is WATI's
          // per-button renumbered copy and is not what you submit.
          url: p.urlOriginal || p.url,
          urlType: p.urlType || 'static',
        },
      };
    }
    if (b.type === 'call') {
      return { type: 'call', parameter: { text: p.text, phoneNumber: p.phoneNumber } };
    }
    return { type: 'quick_reply', parameter: { text: p.text } };
  });

  const types = new Set(buttons.map(b => b.type));
  let buttonsType = 'NONE';
  if (buttons.length) {
    const hasQr = types.has('quick_reply');
    const hasCta = types.has('url') || types.has('call');
    buttonsType = hasQr && hasCta ? 'quick_reply_and_call_to_action' : hasQr ? 'quick_reply' : 'call_to_action';
  }

  return {
    type: 'template',
    category: t.category,
    subCategory: t.subCategory || 'STANDARD',
    elementName: t.elementName,
    language: t.language?.value || 'en_US',
    body: t.bodyOriginal || t.body,
    footer: t.footer || '',
    header: t.header || { type: 'none' },
    customParams: t.customParams || [],
    buttonsType,
    buttons,
  };
}

function printTemplate(t) {
  console.log(`${t.elementName}  [${t.status}]  ${t.category}  ${(t.customParams || []).length} vars  ${t.language?.value || ''}`);
  for (const b of t.buttons || []) {
    const p = b.parameter || {};
    const target = p.urlOriginal || p.url || p.phoneNumber || '(sends a text reply back)';
    console.log(`    ${String(b.type).padEnd(12)} ${JSON.stringify(p.text).padEnd(16)} ${target}`);
  }
}

switch (cmd) {
  case 'list': {
    const list = await fetchTemplates();
    const approved = list.filter(t => t.status === 'APPROVED');
    const pending = list.filter(t => t.status !== 'APPROVED' && t.status !== 'DELETED');
    console.log(`=== APPROVED (${approved.length}) ===`);
    for (const t of approved.sort((a, b) => a.elementName.localeCompare(b.elementName))) printTemplate(t);
    if (pending.length) {
      console.log(`\n=== PENDING / OTHER (${pending.length}) ===`);
      for (const t of pending) printTemplate(t);
    }
    console.log(`\n(${list.filter(t => t.status === 'DELETED').length} deleted templates hidden)`);
    break;
  }

  case 'show': {
    if (!arg) { console.error('usage: show <elementName>'); process.exit(1); }
    const t = findTemplate(await fetchTemplates(), arg);
    if (!t) { console.error(`No template named "${arg}"`); process.exit(1); }
    console.log(JSON.stringify(t, null, 2));
    break;
  }

  case 'dump': {
    if (!arg) { console.error('usage: dump <elementName> [outfile.json]'); process.exit(1); }
    const t = findTemplate(await fetchTemplates(), arg);
    if (!t) { console.error(`No template named "${arg}"`); process.exit(1); }
    const payload = toCreatePayload(t);
    const json = JSON.stringify(payload, null, 2);
    if (arg2) {
      fs.writeFileSync(arg2, json + '\n');
      console.log(`Wrote ${arg2}`);
      console.log('Edit elementName (must be unique) and whatever else you need, then:');
      console.log(`  node scripts/wati-template.mjs create ${arg2}`);
    } else {
      console.log(json);
    }
    break;
  }

  case 'create': {
    if (!arg) { console.error('usage: create <file.json> [--apply]'); process.exit(1); }
    const payload = JSON.parse(fs.readFileSync(arg, 'utf8'));

    const existing = findTemplate(await fetchTemplates(), payload.elementName);
    if (existing && existing.status !== 'DELETED') {
      console.error(`A template named "${payload.elementName}" already exists with status ${existing.status}.`);
      console.error('Template names are unique — pick a new elementName.');
      process.exit(1);
    }

    const url = `${BASE}/${TENANT}/api/v1/whatsApp/templates`;
    console.log(`POST ${url}\n`);
    console.log(JSON.stringify(payload, null, 2));

    // Cheap shape checks before spending a Meta review on an obvious mistake.
    const varsInBody = [...new Set((payload.body || '').match(/\{\{(\d+)\}\}/g) || [])];
    const varsInButtons = [...new Set(
      (payload.buttons || []).flatMap(b => (b.parameter?.url || '').match(/\{\{(\d+)\}\}/g) || [])
    )];
    const declared = (payload.customParams || []).length;
    const needed = new Set([...varsInBody, ...varsInButtons].map(v => Number(v.replace(/\D/g, ''))));
    const maxNeeded = needed.size ? Math.max(...needed) : 0;
    console.log(`\nbody vars: ${varsInBody.join(' ') || 'none'}`);
    console.log(`button vars: ${varsInButtons.join(' ') || 'none'}`);
    console.log(`customParams declared: ${declared}, highest variable used: {{${maxNeeded}}}`);
    if (declared < maxNeeded) {
      console.error(`\nRefusing: {{${maxNeeded}}} is used but only ${declared} customParams are declared.`);
      console.error('WATI requires a sample value for every variable.');
      process.exit(1);
    }
    const urlButtons = (payload.buttons || []).filter(b => b.type === 'url').length;
    if (urlButtons > 2) {
      console.error(`\nRefusing: ${urlButtons} URL buttons. Meta allows at most 2.`);
      process.exit(1);
    }

    if (!APPLY) {
      console.log('\nDRY RUN — nothing submitted. Re-run with --apply to file this with Meta.');
      break;
    }

    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await r.text();
    console.log(`\nHTTP ${r.status}`);
    try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
    if (r.ok) {
      console.log('\nSubmitted. It sits in PENDING review and cannot be sent until Meta approves.');
      console.log(`Check with: node scripts/wati-template.mjs list`);
    }
    break;
  }

  default:
    console.log(`usage:
  node scripts/wati-template.mjs list
  node scripts/wati-template.mjs show <name>
  node scripts/wati-template.mjs dump <name> [outfile.json]
  node scripts/wati-template.mjs create <file.json> [--apply]`);
}
