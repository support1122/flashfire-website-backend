import { Queue } from 'bullmq';
import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// Use REDIS_CLOUD_URL exclusively (same as flashfire-website-backend)
const REDIS_URL = process.env.REDIS_CLOUD_URL;

let redisConnection = null;
let callQueue = null;
let emailQueue = null;

if (!REDIS_URL) {
  console.error('❌ [CallQueue] No Redis URL configured! Set REDIS_CLOUD_URL in your .env file');
  console.warn('⚠️  [CallQueue] Queue features will be disabled without Redis');
} else {
  console.log('🔄 [CallQueue] Creating ioredis connection:', REDIS_URL.substring(0, 30) + '...');

  // Create ioredis connection instance
  // BullMQ requires maxRetriesPerRequest to be null for blocking operations
  redisConnection = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null, // Required by BullMQ for blocking operations
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      console.log(`🔄 [CallQueue] Redis retry attempt ${times}, waiting ${delay}ms...`);
      return delay;
    },
    reconnectOnError: (err) => {
      const targetError = 'READONLY';
      if (err.message.includes(targetError)) {
        console.error('❌ [CallQueue] Redis is in readonly mode');
        return false; // Don't reconnect
      }
      return true; // Reconnect for other errors
    }
  });

  // Add event listeners for ioredis connection
  redisConnection.on('connect', () => {
    console.log('✅ [CallQueue] ioredis connected successfully');
  });

  redisConnection.on('ready', () => {
    console.log('✅ [CallQueue] ioredis ready to accept commands');
  });

  redisConnection.on('error', (err) => {
    console.error('❌ [CallQueue] ioredis connection error:', err.message);
  });

  redisConnection.on('close', () => {
    console.warn('⚠️  [CallQueue] ioredis connection closed');
  });

  redisConnection.on('reconnecting', (delay) => {
    console.log(`🔄 [CallQueue] ioredis reconnecting in ${delay}ms...`);
  });

  // Create queues with ioredis connection
  callQueue = new Queue('callQueue', { connection: redisConnection });
  emailQueue = new Queue('emailQueue', { connection: redisConnection });

  // Add event listeners for queue connection status
  callQueue.on('error', (err) => {
    console.error('❌ [CallQueue] Queue error:', err.message);
  });

  emailQueue.on('error', (err) => {
    console.error('❌ [EmailQueue] Queue error:', err.message);
  });

  // Log successful connection
  console.log('✅ [CallQueue] Call reminder queue initialized with ioredis');
  console.log('✅ [EmailQueue] Email queue initialized with ioredis');
}

// Export redis connection and queues
export { redisConnection, callQueue, emailQueue };
