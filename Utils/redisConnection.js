import IORedis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// Get Redis URL from environment variables (check both UPSTASH_REDIS_URL and REDIS_CLOUD_URL)
const REDIS_URL = process.env.UPSTASH_REDIS_URL || process.env.REDIS_CLOUD_URL;

let redisConnection = null;

if (REDIS_URL) {
  try {
    // Parse URL to extract components for explicit ACL authentication
    // This ensures Render Redis ACL (username:password) works correctly
    const url = new URL(REDIS_URL);
    const host = url.hostname;
    const port = parseInt(url.port) || 6379;
    const username = url.username;
    const password = url.password;
    const useTLS = url.protocol === 'rediss:';

    // Create connection with explicit username and password for ACL authentication
    // This forces IORedis to use AUTH username password (ACL) instead of just AUTH password
    redisConnection = new IORedis({
      host,
      port,
      username: username || undefined, // Explicitly pass username for ACL
      password: password || undefined, // Explicitly pass password for ACL
      tls: useTLS ? {} : undefined,
      // Required by BullMQ to avoid throwing on blocking ops in serverless/managed redis
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
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

