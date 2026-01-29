import mongoose from "mongoose";

const ScheduledDiscordMeetReminderSchema = new mongoose.Schema(
  {
    reminderId: {
      type: String,
      unique: true,
      required: true,
      index: true,
    },

    bookingId: {
      type: String,
      default: null,
      index: true,
    },

    clientName: {
      type: String,
      required: true,
    },

    clientEmail: {
      type: String,
      default: null,
      index: true,
    },

    meetingStartISO: {
      type: Date,
      required: true,
      index: true,
    },

    scheduledFor: {
      type: Date,
      required: true,
      index: true,
    },

    meetingLink: {
      type: String,
      default: null,
    },

    inviteeTimezone: {
      type: String,
      default: null,
    },

    // Reminder status
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "cancelled"],
      default: "pending",
      index: true,
    },

    attempts: {
      type: Number,
      default: 0,
    },
    maxAttempts: {
      type: Number,
      default: 3,
    },

    errorMessage: {
      type: String,
      default: null,
    },

    processedAt: {
      type: Date,
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    source: {
      type: String,
      enum: ["calendly", "manual", "reschedule"],
      default: "calendly",
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

ScheduledDiscordMeetReminderSchema.index({ status: 1, scheduledFor: 1 });

export const ScheduledDiscordMeetReminderModel = mongoose.model(
  "ScheduledDiscordMeetReminder",
  ScheduledDiscordMeetReminderSchema
);

