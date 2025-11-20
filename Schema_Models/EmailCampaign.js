import mongoose from 'mongoose';

export const EmailCampaignSchema = new mongoose.Schema({
    templateName: {
        type: String,
        default: ''
    },
    domainName: {
        type: String,
        required: true
    },
    templateId: {
        type: String,
        required: true
    },
    total: {
        type: Number,
        required: true
    },
    success: {
        type: Number,
        default: 0
    },
    failed: {
        type: Number,
        default: 0
    },
    successfulEmails: [{
        email: String,
        sentAt: {
            type: Date,
            default: Date.now
        },
        sendDay: Number,
        scheduledSendDate: Date
    }],
    failedEmails: [{
        email: String,
        error: String,
        failedAt: {
            type: Date,
            default: Date.now
        },
        sendDay: Number,
        scheduledSendDate: Date
    }],
    status: {
        type: String,
        enum: ['SUCCESS', 'PARTIAL', 'FAILED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED'],
        default: 'SUCCESS'
    },
    provider: {
        type: String,
        enum: ['sendgrid'],
        default: 'sendgrid'
    },
    isScheduled: {
        type: Boolean,
        default: false
    },
    scheduledCampaignId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ScheduledEmailCampaign',
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

export const EmailCampaignModel = mongoose.model('EmailCampaign', EmailCampaignSchema);

