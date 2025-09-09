// worker.js
import { Worker } from 'bullmq';
import Twilio from 'twilio';

const client = Twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

new Worker('callQueue', async (job) => {
  console.log(`Processing job for ${job.data.phone}`);
  
  await client.calls.create({
    to: job.data.phone,
    from: process.env.TWILIO_PHONE_NUMBER,
    url: `https://your-domain.com/twilio-ivr?meetingTime=${encodeURIComponent(job.data.meetingTime)}`
  });
}, {
  connection: { url: process.env.UPSTASH_REDIS_URL }
});
