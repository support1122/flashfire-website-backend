import IORedis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

// Get Redis URL from environment variables
// Priority: Check for Render internal URL first, then external URLs
// Render internal URLs don't require authentication and work better for same-region services
const REDIS_URL = process.env.REDIS_INTERNAL_URL || process.env.UPSTASH_REDIS_URL || process.env.REDIS_CLOUD_URL;

let redisConnection = null;

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
      // External URL (Upstash, Render external, etc.) - requires authentication
      // For Render external URLs, use password-only auth (no username)
      const url = new URL(REDIS_URL);
      const protocol = url.protocol; // rediss: or redis:
      const host = url.hostname;
      const port = url.port || '6379';
      const password = url.password;
      
      // Check if this is Render external URL (has username in URL)
      const isRenderExternal = host.includes('keyvalue.render.com') || host.includes('render.com');
      
      if (isRenderExternal && url.username) {
        // Render external URL with username - use password-only auth
        // Reconstruct URL without username: rediss://:password@host:port
        const passwordOnlyUrl = `${protocol}//:${password}@${host}:${port}`;
        console.log('[Redis] Using Render external URL with password-only authentication');
        redisConnection = new IORedis(passwordOnlyUrl, {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          retryStrategy: () => null,
          lazyConnect: false,
        });
      } else {
        // Other providers (Upstash, etc.) - use URL as-is
        console.log('[Redis] Using external Redis URL');
        redisConnection = new IORedis(REDIS_URL, {
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          retryStrategy: () => null,
          lazyConnect: false,
        });
      }
    }

    // Suppress auth errors to reduce log spam
    redisConnection.on('error', (err) => {
      const errorMsg = err.message?.toLowerCase() || '';
      // Only log non-auth errors
      if (!errorMsg.includes('auth') && 
          !errorMsg.includes('too many requests') && 
          !errorMsg.includes('internal error')) {
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

