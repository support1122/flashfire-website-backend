import { Queue } from 'bullmq';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// Determine Redis URL in order of preference
const getRedisUrl = () => {
  if (process.env.UPSTASH_REDIS_URL) return process.env.UPSTASH_REDIS_URL;
  if (process.env.REDIS_CLOUD_URL) return process.env.REDIS_CLOUD_URL;
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  return null;
};

const REDIS_URL = getRedisUrl();

let redisConnection = null;
let callQueue = null;
let emailQueue = null;
let whatsappQueue = null;

if (!REDIS_URL) {
  console.error('❌ [CallQueue] No Redis URL configured! Set UPSTASH_REDIS_URL or REDIS_CLOUD_URL in your .env');
  console.warn('⚠️  [CallQueue] Queue features will be disabled without Redis');
} else {
  console.log('🔄 [CallQueue] Creating shared ioredis connection (producer)...');

  const redisOptions = {
    maxRetriesPerRequest: null, // Required by BullMQ
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    reconnectOnError: (err) => {
      const targetError = 'READONLY';
      if (err.message.includes(targetError)) {
        console.error('❌ [CallQueue] Redis is in readonly mode');
        return false;
      }
      return true;
    }
  };

  redisConnection = new Redis(REDIS_URL, redisOptions);

  redisConnection.on('connect', () => console.log('✅ [CallQueue] Shared Redis connection established'));
  redisConnection.on('error', (err) => console.error('❌ [CallQueue] Shared Redis error:', err.message));

  // Initialize Queues with the shared connection
  callQueue = new Queue('callQueue', { connection: redisConnection });
  emailQueue = new Queue('emailQueue', { connection: redisConnection });
  whatsappQueue = new Queue('whatsappQueue', { connection: redisConnection });

  console.log('✅ [CallQueue] Queues initialized');
}

export { redisConnection, callQueue, emailQueue, whatsappQueue, getRedisUrl };
