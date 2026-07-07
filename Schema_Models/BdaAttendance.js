import mongoose from "mongoose";

const BdaAttendanceSchema = new mongoose.Schema(
  {
    attendanceId: {
      type: String,
      unique: true,
      required: true,
      default: () =>
        `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    },

    bdaName: {
      type: String,
      required: true,
      trim: true,
    },

    bdaEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },

    bookingId: {
      type: String,
      required: true,
      index: true,
    },

    meetLink: {
      type: String,
      default: null,
    },

    joinedAt: {
      type: Date,
      default: null,
    },

    // First-ever join time for this meeting. Unlike `joinedAt` (which is cleared
    // when a session closes), this is set once and never overwritten, so the
    // "In time" survives leave/rejoin and post-meeting review.
    firstJoinedAt: {
      type: Date,
      default: null,
    },

    leftAt: {
      type: Date,
      default: null,
    },

    status: {
      // "absent" is set ONLY when a BDA explicitly marks themselves absent.
      // "unmarked" = no response captured (scheduler / bad join URL) — the BDA
      // may have simply forgotten to mark, so it must NOT count as absent.
      type: String,
      enum: ["present", "absent", "manual", "unmarked"],
      required: true,
      index: true,
    },

    source: {
      // "meet_api" = written from Google's Meet REST API conference records
      // (server-side, authoritative). Wins over extension DOM detection.
      type: String,
      enum: ["auto", "manual", "scheduler", "meet_api"],
      required: true,
    },

    markedAt: {
      type: Date,
      default: Date.now,
    },

    meetingScheduledStart: {
      type: Date,
      required: true,
    },

    meetingScheduledEnd: {
      type: Date,
      default: null,
    },

    discordNotified: {
      type: Boolean,
      default: false,
    },

    /** Last Discord warn "BDA Not in Meeting" for this row (if any) */
    warnDiscordSentAt: {
      type: Date,
      default: null,
    },

    /** Sum of completed in-meet segments (ms) */
    cumulativeDurationMs: {
      type: Number,
      default: 0,
    },

    /** Total duration after last completed segment */
    durationMs: {
      type: Number,
      default: null,
    },

    notes: {
      type: String,
      default: null,
    },

    /** Last explicit end action (from extension / beacon) */
    lastEndSource: {
      type: String,
      default: null,
    },

    lastEndedAt: {
      type: Date,
      default: null,
    },

    lastEndMeetLink: {
      type: String,
      default: null,
    },

    // ---- Google Meet REST API fields (source: meet_api) ----

    /** conferenceRecords/{id} this attendance was reconciled against */
    conferenceRecordName: {
      type: String,
      default: null,
    },

    /** firstJoinedAt - scheduledStart (negative = joined early) */
    lateByMs: {
      type: Number,
      default: null,
    },

    /** Every join/leave segment from participantSessions (authoritative) */
    sessions: {
      type: [
        {
          _id: false,
          startTime: { type: Date, default: null },
          endTime: { type: Date, default: null },
          durationMs: { type: Number, default: 0 },
        },
      ],
      default: [],
    },

    /** Who was already in the call when the BDA first joined */
    participantsAtJoin: {
      type: [
        {
          _id: false,
          displayName: { type: String, default: null },
          kind: { type: String, default: null }, // signedin | anonymous | phone
        },
      ],
      default: [],
    },

    /** Last successful Meet API sync for this row */
    meetApiSyncedAt: {
      type: Date,
      default: null,
    },

    /** Set once the conference ended and final numbers were written */
    meetApiFinalizedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// One record per BDA per meeting
BdaAttendanceSchema.index({ bookingId: 1, bdaEmail: 1 }, { unique: true });
BdaAttendanceSchema.index({ bdaEmail: 1, meetingScheduledStart: -1 });
BdaAttendanceSchema.index({ status: 1, meetingScheduledStart: -1 });

export const BdaAttendanceModel = mongoose.model(
  "BdaAttendance",
  BdaAttendanceSchema
);
