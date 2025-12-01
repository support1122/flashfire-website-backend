import IORedis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// Get Redis URL from environment variables (check both UPSTASH_REDIS_URL and REDIS_CLOUD_URL)
const REDIS_URL = process.env.UPSTASH_REDIS_URL || process.env.REDIS_CLOUD_URL;

let redisConnection = null;

if (REDIS_URL) {
  try {
    // Pass URL directly to IORedis - let it handle parsing and authentication
    // This matches the working client tracking system approach
    // IORedis will automatically handle the rediss://username:password@host:port format
    redisConnection = new IORedis(REDIS_URL, {
      // Required by BullMQ to avoid throwing on blocking ops in serverless/managed redis
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      // Prevent automatic reconnection to avoid multiple auth attempts
      retryStrategy: (times) => {
        // Only retry a few times, then stop to avoid rate limiting
        if (times > 3) {
          return null; // Stop retrying
        }
        return Math.min(times * 200, 2000); // Exponential backoff
      },
      // Disable lazy connect to ensure connection happens immediately
      lazyConnect: false,
    });

    redisConnection.on('error', (err) => {
      // Only log non-auth errors to avoid spam
      if (!err.message.includes('auth') && !err.message.includes('AUTH')) {
        console.error('[Redis] Connection error:', err.message);
      }
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

