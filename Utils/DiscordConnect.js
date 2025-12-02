import dotenv from 'dotenv'
dotenv.config();

// const webhookURL = process.env.DISCORD_WEB_HOOK_URL;

export const DiscordConnect = async (url,message) => {
  try {
    // Check if URL is provided
    if (!url) {
      console.warn('⚠️ Discord webhook URL not provided. Message not sent:', message?.substring(0, 100));
      return;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: `🚨 App Update: ${message}`,
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

// Usage

