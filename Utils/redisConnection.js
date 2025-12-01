import IORedis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// Get Redis URL from environment variables (check both UPSTASH_REDIS_URL and REDIS_CLOUD_URL)
const REDIS_URL = process.env.UPSTASH_REDIS_URL || process.env.REDIS_CLOUD_URL;

let redisConnection = null;

if (REDIS_URL) {
  try {
    redisConnection = new IORedis(REDIS_URL, {
      // Required by BullMQ to avoid throwing on blocking ops in serverless/managed redis
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      // Enable TLS for rediss:// URLs
      tls: REDIS_URL.startsWith('rediss://') ? {} : undefined,
    });

    redisConnection.on('error', (err) => {
      console.error('[Redis] Connection error:', err.message);
    });

    redisConnection.on('connect', () => {
      console.log('[Redis] ✅ Connected to Redis');
    });

    redisConnection.on('ready', () => {
      console.log('[Redis] ✅ Redis connection ready');
    });
  } catch (error) {
    console.error('[Redis] ❌ Failed to create Redis connection:', error.message);
  }
} else {
  console.warn('[Redis] ⚠️ Redis URL not configured. Queue features will not work.');
}

export default redisConnection;

