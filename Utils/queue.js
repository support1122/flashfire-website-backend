import { Queue } from 'bullmq';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import { URL } from 'url';

dotenv.config();

// Flag to disable Redis completely (use MongoDB-based JobScheduler instead)
// Set to true to avoid Redis rate limiting issues
const DISABLE_REDIS = process.env.DISABLE_REDIS === 'true' || false;

// Determine Redis URL in order of preference
const getRedisUrl = () => {
  if (DISABLE_REDIS) {
    console.log('⚠️ [Queue] Redis disabled via DISABLE_REDIS env var - using MongoDB-based JobScheduler');
    return null;
  }
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

// Unified function to create Redis client with Render-specific fixes
const createRedisClient = (urlStr, name = 'Redis') => {
  if (!urlStr) return null;

  try {
    const url = new URL(urlStr);
    const host = url.hostname;
    const port = url.port || 6379;
    const isSSL = url.protocol === 'rediss:';

    // Check if this is a Render Redis URL
    const isRender = host.includes('keyvalue.render.com') || host.includes('render.com');

    const options = createRedisOptions();

    if (isSSL) {
      console.log(`🔒 [${name}] Detected SSL/TLS Redis connection (rediss://)`);
      options.tls = {
        rejectUnauthorized: false // Allow self-signed certificates
      };
    }

    if (isRender && url.username && url.password) {
      console.log(`🔧 [${name}] Detected Render Redis - using ACL authentication (username + password)`);
      
      options.host = host;
      options.port = parseInt(port);
      options.username = url.username; // Redis 6+ ACL username
      options.password = url.password;
      
      console.log(`📡 [${name}] Connecting to ${host}:${port} with user: ${url.username}`);
      
      return new Redis(options);
    }

    return new Redis(urlStr, options);
  } catch (error) {
    console.error(`❌ [${name}] Invalid Redis URL provided:`, error.message);
    return null;
  }
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

  redisConnection = createRedisClient(REDIS_URL, 'CallQueue');

  if (redisConnection) {
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
}

export { redisConnection, callQueue, emailQueue, whatsappQueue, getRedisUrl, createRedisOptions, createRedisClient };
