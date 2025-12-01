import IORedis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// Get Redis URL from environment variables (check both UPSTASH_REDIS_URL and REDIS_CLOUD_URL)
const REDIS_URL = process.env.UPSTASH_REDIS_URL || process.env.REDIS_CLOUD_URL;

let redisConnection = null;

if (REDIS_URL) {
  try {
    // Parse the Redis URL to extract connection details
    const url = new URL(REDIS_URL);
    const host = url.hostname;
    const port = parseInt(url.port) || 6379;
    const username = url.username;
    const password = url.password;
    const useTLS = url.protocol === 'rediss:';

    // Render Redis may not support ACL-style AUTH (username:password)
    // Try password-only authentication first
    // If that doesn't work, we'll need to use a different approach
    redisConnection = new IORedis({
      host,
      port,
      // Use password-only auth (no username) to avoid ACL AUTH command
      // Render Redis might use password-only even if URL has username
      password: password || undefined,
      tls: useTLS ? {} : undefined,
      // Required by BullMQ to avoid throwing on blocking ops in serverless/managed redis
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: false,
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

