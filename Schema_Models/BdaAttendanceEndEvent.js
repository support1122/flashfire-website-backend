import mongoose from "mongoose";

const END_SOURCES = [
  "meet_widget",
  "fallback_popup",
  "panel",
  "beacon",
  "auto_cleanup",
  "meet_call_ended",
  "api_leave",
];

const BdaAttendanceEndEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      unique: true,
      required: true,
      default: () =>
        `bda_end_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    },

    /** May be null when only meet link was known (unresolved booking) */
    bookingId: {
      type: String,
      default: null,
      index: true,
    },

    bdaEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },

    bdaName: {
      type: String,
      default: "",
      trim: true,
    },

    meetLink: {
      type: String,
      default: null,
    },

    meetCode: {
      type: String,
      default: null,
      index: true,
    },

    joinedAtSnapshot: {
      type: Date,
      default: null,
    },

    endedAt: {
      type: Date,
      required: true,
    },

    endSource: {
      type: String,
      enum: END_SOURCES,
      required: true,
    },

    /** Client-reported duration (ms) at click time; informational */
    durationMsSnapshot: {
      type: Number,
      default: null,
    },

    /** Server cumulative duration after session close (if session was closed) */
    durationMsAfterClose: {
      type: Number,
      default: null,
    },

    requestId: {
      type: String,
      required: true,
    },

    linkMismatch: {
      type: Boolean,
      default: false,
    },

    unresolvedBooking: {
      type: Boolean,
      default: false,
    },

    sessionClosed: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

BdaAttendanceEndEventSchema.index(
  { bdaEmail: 1, requestId: 1 },
  { unique: true }
);
BdaAttendanceEndEventSchema.index({ endedAt: -1 });
BdaAttendanceEndEventSchema.index({ meetLink: 1 });

export const BdaAttendanceEndEventModel =
  mongoose.models.BdaAttendanceEndEvent ||
  mongoose.model("BdaAttendanceEndEvent", BdaAttendanceEndEventSchema);

export { END_SOURCES };
