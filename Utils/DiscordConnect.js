import dotenv from 'dotenv'
dotenv.config();

// const webhookURL = process.env.DISCORD_WEB_HOOK_URL;

export const DiscordConnect = async (url,message) => {
  try {
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
      throw new Error(`Failed to send: ${response.statusText}, ${message}`);
    }

    console.log('✅ Message sent to Discord!',message);
  } catch (error) {
    console.error('❌ Error sending message:', error);
  }
};

// Usage

