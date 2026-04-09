/**
 * Centralized workflow configuration.
 * All previously hardcoded values are now configurable via environment variables.
 */
export const WorkflowConfig = {
  timezone: process.env.WORKFLOW_TIMEZONE || 'Asia/Kolkata',

  sendWindows: {
    whatsapp: {
      hour: parseInt(process.env.WA_SEND_HOUR || '23', 10),
      minute: parseInt(process.env.WA_SEND_MINUTE || '0', 10)
    },
    email: {
      startHour: parseInt(process.env.EMAIL_START_HOUR || '20', 10),
      endHour: parseInt(process.env.EMAIL_END_HOUR || '22', 10)
    },
    campaign: {
      hour: parseInt(process.env.CAMPAIGN_SEND_HOUR || '19', 10),
      minute: parseInt(process.env.CAMPAIGN_SEND_MINUTE || '30', 10)
    }
  },

  rateLimits: {
    emailConcurrency: parseInt(process.env.EMAIL_CONCURRENCY || '3', 10),
    whatsappRateLimit: parseInt(process.env.WA_RATE_LIMIT || '10', 10),
    whatsappDelayMs: parseInt(process.env.WA_DELAY_MS || '1000', 10),
    batchSize: parseInt(process.env.BATCH_SIZE || '10', 10),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '10000', 10),
    timeSpreadWindowMs: parseInt(process.env.TIME_SPREAD_WINDOW_MS || '3600000', 10)
  },

  defaults: {
    senderEmail: process.env.DEFAULT_SENDER_EMAIL || 'elizabeth@flashfirehq.com',
    domain: process.env.DEFAULT_DOMAIN || 'flashfiremails.com',
    schedulingLink: process.env.DEFAULT_SCHEDULING_LINK || 'https://calendly.com/feedback-flashfire/15min'
  },

  retry: {
    maxAttempts: parseInt(process.env.RETRY_MAX_ATTEMPTS || '3', 10),
    baseDelayMs: parseInt(process.env.RETRY_BASE_DELAY_MS || '300000', 10)
  }
};
