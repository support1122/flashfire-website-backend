import dotenv from 'dotenv'
dotenv.config();

const webhookURL = process.env.DISCORD_WEB_HOOK_URL;

export const DiscordConnect = async (message) => {
  try {
    const response = await fetch(webhookURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: `🚨 App Update: ${message}`,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to send: ${response.statusText}`);
    }

    console.log('✅ Message sent to Discord!');
  } catch (error) {
    console.error('❌ Error sending message:', error);
  }
};

// Usage

