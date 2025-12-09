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

// Helper function to create Redis connection options with SSL/TLS support
const createRedisOptions = () => {
  const baseOptions = {
    maxRetriesPerRequest: null, // Required by BullMQ
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    reconnectOnError: (err) => {
      const targetError = 'READONLY';
      if (err.message.includes(targetError)) {
        console.error('❌ [Redis] Redis is in readonly mode');
        return false;
      }
      return true;
    }
  };

  return baseOptions;
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
  
  // Check if URL uses SSL (rediss://)
  const isSSL = REDIS_URL.startsWith('rediss://');
  if (isSSL) {
    console.log('🔒 [CallQueue] Detected SSL/TLS Redis connection (rediss://)');
  }

  const redisOptions = createRedisOptions();
  
  // ioredis automatically handles rediss:// URLs and enables TLS
  // But we can explicitly configure TLS for better compatibility
  if (isSSL) {
    redisOptions.tls = {
      rejectUnauthorized: false // Allow self-signed certificates (common in managed Redis services)
    };
  }

  redisConnection = new Redis(REDIS_URL, redisOptions);

  redisConnection.on('connect', () => console.log('✅ [CallQueue] Shared Redis connection established'));
  redisConnection.on('ready', () => console.log('✅ [CallQueue] ioredis ready to accept commands'));
  redisConnection.on('error', (err) => console.error('❌ [CallQueue] Shared Redis error:', err.message));
  redisConnection.on('close', () => console.warn('⚠️  [CallQueue] ioredis connection closed'));
  redisConnection.on('reconnecting', (delay) => console.log(`🔄 [CallQueue] ioredis reconnecting in ${delay}ms...`));

  // Initialize Queues with the shared connection
  callQueue = new Queue('callQueue', { connection: redisConnection });
  emailQueue = new Queue('emailQueue', { connection: redisConnection });
  whatsappQueue = new Queue('whatsappQueue', { connection: redisConnection });

  console.log('✅ [CallQueue] Queues initialized');
}

export { redisConnection, callQueue, emailQueue, whatsappQueue, getRedisUrl, createRedisOptions };
