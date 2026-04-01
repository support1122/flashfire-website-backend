import dotenv from 'dotenv'
dotenv.config();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Optional spacing before POST; default 0 (no self-throttling). Set DISCORD_WEBHOOK_DELAY_MS if needed. */
const DEFAULT_DELAY_MS = Number(process.env.DISCORD_WEBHOOK_DELAY_MS) || 0;
const MAX_ATTEMPTS = Math.min(8, Math.max(1, Number(process.env.DISCORD_WEBHOOK_MAX_RETRIES) || 3));

function parseRetryAfterMs(response) {
  const ra = response.headers?.get?.('retry-after');
  if (!ra) return null;
  const sec = parseInt(ra, 10);
  if (Number.isFinite(sec)) return sec * 1000;
  const date = Date.parse(ra);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * POST to a Discord webhook. Optional DISCORD_WEBHOOK_DELAY_MS (ms) before send.
 * Retries on 429/5xx only when Discord or the network errors (not “rate limiting” we add).
 * @returns {{ ok: boolean, error?: string }}
 */
export const DiscordConnect = async (url, message, usePrefix = true) => {
  if (!url) {
    console.warn('⚠️ Discord URL not provided. Message not sent:', message?.substring(0, 100));
    return { ok: false, error: 'no_url' };
  }

  const DISCORD_MAX_CHARS = 2000;
  let content = usePrefix ? `🚨 App Update: ${message}` : message;
  if (typeof content === 'string' && content.length > DISCORD_MAX_CHARS) {
    content = content.slice(0, DISCORD_MAX_CHARS - 15) + '\n…[truncated]';
  }
  const preview = typeof message === 'string' ? message.substring(0, 120) : '[non-string]';
  console.log('📤 Sending Discord webhook:', preview);

  if (DEFAULT_DELAY_MS > 0) {
    await sleep(DEFAULT_DELAY_MS);
  }

  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: content,
        }),
      });

      if (response.status === 429 || response.status >= 500) {
        const retryMs =
          parseRetryAfterMs(response) ?? 2000 * (attempt + 1);
        lastError = new Error(`Discord webhook ${response.status}, will retry`);
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(retryMs);
        }
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Discord webhook failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      console.log('✅ Message sent to Discord!', preview);
      return { ok: true };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(2000 * (attempt + 1));
      }
    }
  }

  console.error('❌ Error sending message to Discord (after retries):', lastError?.message || lastError);
  return { ok: false, error: lastError?.message || String(lastError) };
};

// Convenience wrapper for meet/webhook notifications (avoids importing the server entry file and causing circular deps)
export const DiscordConnectForMeet = async (message) => {
  return DiscordConnect(process.env.DISCORD_MEET_WEB_HOOK_URL, message);
};

// Usage

