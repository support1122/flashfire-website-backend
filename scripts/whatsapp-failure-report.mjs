// Run the 12h WhatsApp failure check once, outside the cron.
//   node scripts/whatsapp-failure-report.mjs          -> print the report only (no Discord post)
//   node scripts/whatsapp-failure-report.mjs --send   -> also post to DISCORD_WHATSAPP_FAILURE_WEBHOOK_URL
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { runWhatsAppFailureCheck } from '../Utils/WhatsAppFailureAlert.js';

const send = process.argv.includes('--send');

await mongoose.connect(process.env.MONGODB_URI);
try {
  const result = await runWhatsAppFailureCheck({ dryRun: !send });
  console.log(result.message);
  console.log(`\n${result.failures} failure(s): ${result.sentAnyway} sent anyway, ${result.notSent} not sent. Posted to Discord: ${result.posted}`);
} finally {
  await mongoose.disconnect();
}
