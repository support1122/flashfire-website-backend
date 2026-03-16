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

    leftAt: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      enum: ["present", "absent", "manual"],
      required: true,
      index: true,
    },

    source: {
      type: String,
      enum: ["auto", "manual", "scheduler"],
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

    notes: {
      type: String,
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
