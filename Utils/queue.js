import { Queue } from 'bullmq';
import dotenv from 'dotenv';

dotenv.config();

// ONLY use UPSTASH_REDIS_URL - no fallbacks
if (!process.env.UPSTASH_REDIS_URL) {
  console.warn('⚠️ UPSTASH_REDIS_URL not configured. Queue features will not work.');
}

const connection = process.env.UPSTASH_REDIS_URL ? { url: process.env.UPSTASH_REDIS_URL } : null;

export const callQueue = connection ? new Queue('callQueue', { connection }) : null;
export const emailQueue = connection ? new Queue('emailQueue', { connection }) : null;