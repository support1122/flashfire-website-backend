import mongoose from 'mongoose';

// One Calendly Notetaker recap email, sent here by the Gmail Apps Script (BDA attendance/apps-script). The raw text
// is kept so a better parser can re-read old recaps; the parsed fields and the booking link are what the CRM shows.
const CalendlyRecapSchema = new mongoose.Schema(
  {
    /** Gmail message id: the idempotency key. The script may send the same message more than once. */
    messageId: { type: String, required: true, unique: true, trim: true },
    threadId: { type: String, default: null },
    /** The Gmail account the script runs in (whose inbox the recap landed in). */
    account: { type: String, default: null, lowercase: true, trim: true },
    from: { type: String, default: null },
    subject: { type: String, default: '' },
    sentAt: { type: Date, required: true },
    plainBody: { type: String, default: '' },
    links: { type: [String], default: [] },

    summary: { type: String, default: '' },
    sections: { type: mongoose.Schema.Types.Mixed, default: {} },
    recapUrl: { type: String, default: null },
    attendees: { type: [String], default: [] },
    inviteeNames: { type: [String], default: [] },

    bookingId: { type: String, default: null, index: true },
    matchStatus: { type: String, enum: ['matched', 'ambiguous', 'unmatched', 'manual'], required: true },
    matchScore: { type: Number, default: 0 },
    matchWhy: { type: [String], default: [] },
    linkedBy: { type: String, default: null },
    linkedAt: { type: Date, default: null },
    discordPostedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

CalendlyRecapSchema.index({ matchStatus: 1, sentAt: -1 });

export const CalendlyRecapModel = mongoose.models.CalendlyRecap || mongoose.model('CalendlyRecap', CalendlyRecapSchema);
