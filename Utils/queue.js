import { Queue } from 'bullmq';
// import IORedis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();
// const connection = new IORedis({
//   host: process.env.REDIS_HOST,
//   port: process.env.REDIS_PORT
// });

const redisUrl = process.env.UPSTASH_REDIS_URL || process.env.REDIS_CLOUD_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;

export const callQueue = new Queue('callQueue', { connection: {url: redisUrl} });
export const emailQueue = new Queue('emailQueue', {connection : { url : redisUrl}});