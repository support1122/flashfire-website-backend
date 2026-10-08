import mongoose from 'mongoose';

// Names the BDA matcher could not resolve, so an admin can add an alias (plan 2.8 admin screen).
// A normal collection with a TTL instead of a capped one: capped collections cannot grow a document,
// and we update counts in place. The admin list only ever reads the newest 20.
const BdaUnknownNameSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // foldName(name)
  name: { type: String, required: true }, // newest raw spelling
  source: { type: String, default: null },
  count: { type: Number, default: 0 },
  lastRef: { type: String, default: null }, // booking or call that last reported it; stops a poll loop inflating count
  lastSeenAt: { type: Date, required: true },
});

BdaUnknownNameSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const BdaUnknownNameModel =
  mongoose.models.BdaUnknownName || mongoose.model('BdaUnknownName', BdaUnknownNameSchema);
