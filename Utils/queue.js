import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();
const connection = new IORedis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT
});

export const callQueue = new Queue('callQueue', { connection: {url: process.env.UPSTASH_REDIS_URL} });
