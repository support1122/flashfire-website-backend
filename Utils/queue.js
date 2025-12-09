import { Queue } from 'bullmq';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import { URL } from 'url';

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

// Unified function to create Redis client with Render-specific fixes
const createRedisClient = (urlStr, name = 'Redis') => {
  if (!urlStr) return null;

  try {
    const url = new URL(urlStr);
    const host = url.hostname;
    const isSSL = url.protocol === 'rediss:';

    // Check if this is a Render external URL
    const isRenderExternal = host.includes('keyvalue.render.com') || host.includes('render.com');

    const options = createRedisOptions();

    // Check if URL uses SSL (rediss://)
    if (isSSL) {
      console.log(`🔒 [${name}] Detected SSL/TLS Redis connection (rediss://)`);
      options.tls = {
        rejectUnauthorized: false // Allow self-signed certificates
      };
    }

    let connectionUrl = urlStr;

    // Fix for Render Redis: It requires password-only auth (no username)
    // But standard URLs usually look like rediss://username:password@...
    // We strip the username to make it rediss://:password@...
    if (isRenderExternal && url.username) {
      console.log(`🔧 [${name}] Detected Render Redis - stripping username for compatibility`);
      url.username = '';
      connectionUrl = url.toString();
    }

    return new Redis(connectionUrl, options);
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
