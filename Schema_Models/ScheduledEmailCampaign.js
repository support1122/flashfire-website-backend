import mongoose from 'mongoose';

export const ScheduledEmailCampaignSchema = new mongoose.Schema({
    campaignName: {
        type: String,
        required: true
    },
    templateName: {
        type: String,
        required: true
    },
    domainName: {
        type: String,
        required: true
    },
    templateId: {
        type: String,
        required: true
    },
    recipientEmails: [{
        type: String,
        required: true
    }],
    totalRecipients: {
        type: Number,
        required: true
    },
    sendSchedule: [{
        day: {
            type: Number,
            required: true
        },
        scheduledDate: {
            type: Date,
            required: true
        },
        status: {
            type: String,
            enum: ['pending', 'processing', 'completed', 'skipped', 'failed'],
            default: 'pending'
        },
        sentCount: {
            type: Number,
            default: 0
        },
        failedCount: {
            type: Number,
            default: 0
        },
        skippedCount: {
            type: Number,
            default: 0
        },
        completedAt: Date,
        jobIds: [String]
    }],
    status: {
        type: String,
        enum: ['active', 'paused', 'completed', 'cancelled'],
        default: 'active'
    },
    startedAt: {
        type: Date,
        default: Date.now
    },
    completedAt: Date,
    logs: [{
        timestamp: {
            type: Date,
            default: Date.now
        },
        level: {
            type: String,
            enum: ['info', 'warning', 'error', 'success'],
            required: true
        },
        message: {
            type: String,
            required: true
        },
        details: mongoose.Schema.Types.Mixed
    }]
}, {
    timestamps: true
});

ScheduledEmailCampaignSchema.index({ status: 1, startedAt: -1 });
ScheduledEmailCampaignSchema.index({ 'sendSchedule.scheduledDate': 1 });

export const ScheduledEmailCampaignModel = mongoose.model('ScheduledEmailCampaign', ScheduledEmailCampaignSchema);

