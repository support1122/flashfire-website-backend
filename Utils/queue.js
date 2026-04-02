// Redis / BullMQ has been removed.
// All scheduling is handled by MongoDB-based schedulers:
//   - UnifiedScheduler   → calls, WhatsApp reminders, Discord reminders
//   - JobScheduler       → email/WhatsApp campaigns
//   - CallScheduler      → Twilio call polling

export const redisConnection = null;
export const callQueue = null;
export const emailQueue = null;
export const whatsappQueue = null;
export const getRedisUrl = () => null;
export const createRedisOptions = () => ({});
export const createRedisClient = () => null;
