import mongoose from 'mongoose';

// Keys for machine-to-machine integrations that must work without an env var (bsc's call for the Calendly recap
// Apps Script). Only a SHA-256 hash is stored, never the key. The first valid-looking key a caller presents is
// enrolled ("trust on first use"); after that only that key is accepted. To rotate: delete the document (or set
// the integration's env var, which always wins), then let the script call again.
const IntegrationKeySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    keyHash: { type: String, required: true },
    enrolledAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

export const IntegrationKeyModel = mongoose.models.IntegrationKey || mongoose.model('IntegrationKey', IntegrationKeySchema);
