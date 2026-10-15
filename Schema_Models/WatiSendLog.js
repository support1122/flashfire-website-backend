import mongoose from 'mongoose';

// One row per template message WATI accepted. WATI has no billing API, so the daily cost report
// counts these and prices them from a rate card. Rows expire after 120 days.
const WatiSendLogSchema = new mongoose.Schema({
  to: { type: String, required: true },            // digits only, country code included
  templateName: { type: String, default: null },
  source: { type: String, default: 'reminder' },   // 'reminder' | 'campaign/workflow'
  createdAt: { type: Date, default: Date.now, index: true, expires: 60 * 60 * 24 * 120 },
});

export const WatiSendLogModel = mongoose.models.WatiSendLog || mongoose.model('WatiSendLog', WatiSendLogSchema);
