import mongoose from 'mongoose';

// One document per person who can be a BDA (plan 2.8). The email is the identity key everywhere.
// `tracked` defaults to false on purpose: a new profile must never start earning deductions by accident.

const LEAVE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const BdaProfileSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    displayName: { type: String, required: true, trim: true },
    firstName: { type: String, required: true, trim: true, lowercase: true },
    lastName: { type: String, default: '', trim: true, lowercase: true },
    aliases: { type: [String], default: [] },
    calendlyUserUri: { type: String, default: null, trim: true },
    zoomUserId: { type: String, default: null, trim: true },
    googleUserId: { type: String, default: null, trim: true },
    discordUserId: { type: String, default: null, trim: true },
    // Approved leave dates, 'YYYY-MM-DD' in IST (plan 2.1).
    leaveDays: {
      type: [String],
      default: [],
      validate: {
        validator: (days) => days.every((d) => LEAVE_DAY_RE.test(d)),
        message: 'leaveDays must be YYYY-MM-DD strings',
      },
    },
    active: { type: Boolean, default: true },
    tracked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const BdaProfileModel =
  mongoose.models.BdaProfile || mongoose.model('BdaProfile', BdaProfileSchema);
