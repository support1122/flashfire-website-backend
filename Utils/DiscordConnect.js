import dotenv from 'dotenv'
dotenv.config();

// const webhookURL = process.env.DISCORD_WEB_HOOK_URL;

export const DiscordConnect = async (url, message, usePrefix = true) => {
  try {
    // Check if URL is provided
    if (!url) {
      console.warn('⚠️ Discord webhook URL not provided. Message not sent:', message?.substring(0, 100));
      return;
    }

    const content = usePrefix ? `🚨 App Update: ${message}` : message;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: content,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Discord webhook failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    console.log('✅ Message sent to Discord!',message?.substring(0, 100));
  } catch (error) {
    console.error('❌ Error sending message to Discord:', error.message || error);
  }
};

// Convenience wrapper for meet/webhook notifications (avoids importing the server entry file and causing circular deps)
export const DiscordConnectForMeet = async (message) => {
  return DiscordConnect(process.env.DISCORD_MEET_WEB_HOOK_URL, message);
};

// Usage

