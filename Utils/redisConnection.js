import IORedis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// Get Redis URL from environment variables
// Priority: Check for Render internal URL first, then external URLs
// Render internal URLs don't require authentication and work better for same-region services
const REDIS_URL = process.env.REDIS_INTERNAL_URL || process.env.UPSTASH_REDIS_URL || process.env.REDIS_CLOUD_URL;

let redisConnection = null;

// Debug logging to see what URL we're getting
console.log('[Redis] Environment variables check:', {
  REDIS_INTERNAL_URL: process.env.REDIS_INTERNAL_URL ? 'Set' : 'Not set',
  UPSTASH_REDIS_URL: process.env.UPSTASH_REDIS_URL ? 'Set' : 'Not set',
  REDIS_CLOUD_URL: process.env.REDIS_CLOUD_URL ? 'Set' : 'Not set',
  selectedUrl: REDIS_URL ? REDIS_URL.substring(0, 20) + '...' : 'None'
});

if (REDIS_URL) {
  try {
    // Check if this is a Render internal URL (no auth required)
    // Internal URL format: redis://red-xxxxx:6379 (no @ symbol, no password)
    // External URL format: rediss://username:password@host:port (has @ symbol)
    const isInternalUrl = !REDIS_URL.includes('@') && 
                         (REDIS_URL.includes('red-') || REDIS_URL.includes('keyvalue'));
    
    if (isInternalUrl) {
      // Render internal URL - no authentication needed, pass URL directly
      console.log('[Redis] ✅ Using Render internal URL (no authentication required)');
      redisConnection = new IORedis(REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        retryStrategy: () => null, // Never retry - stop on first failure
        lazyConnect: false,
      });
    } else {
      // External URL - parse and handle based on provider
      console.log('[Redis] Parsing external URL...');
      const url = new URL(REDIS_URL);
      const protocol = url.protocol; // rediss: or redis:
      const host = url.hostname;
      const port = url.port || '6379';
      const password = url.password;
      const username = url.username;
      
      console.log('[Redis] Parsed URL details:', {
        protocol,
        host,
        port,
        hasPassword: !!password,
        hasUsername: !!username
      });
      
      // Check if this is a Render external URL
      const isRenderExternal = host.includes('keyvalue.render.com') || host.includes('render.com');
      
      if (isRenderExternal) {
        // Render Redis uses password-only authentication (Redis 5 style)
        // Strip the username and use only password
        // Format: rediss://:password@host:port (note the leading colon with empty username)
        const passwordOnlyUrl = `${protocol}//:${password}@${host}:${port}`;
        console.log('[Redis] Using Render Redis with password-only authentication');
        console.log('[Redis] Connecting to:', `${protocol}//:***@${host}:${port}`);
        redisConnection = new IORedis(passwordOnlyUrl, {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          retryStrategy: () => null,
          lazyConnect: false,
        });
      } else {
        // Other providers (Upstash, etc.) - use URL as-is
        console.log('[Redis] Using external Redis URL as-is');
        console.log('[Redis] Host:', host);
        redisConnection = new IORedis(REDIS_URL, {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          retryStrategy: () => null,
          lazyConnect: false,
        });
      }
    }

    // Suppress common errors to reduce log spam
    redisConnection.on('error', (err) => {
      const errorMsg = err.message?.toLowerCase() || '';
      const errorCode = err.code?.toLowerCase() || '';
      // Only log significant errors, suppress auth/DNS/retry spam
      if (!errorMsg.includes('auth') && 
          !errorMsg.includes('too many requests') && 
          !errorMsg.includes('internal error') &&
          !errorMsg.includes('eai_again') &&
          !errorCode.includes('eai_again') &&
          !errorMsg.includes('enotfound')) {
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

