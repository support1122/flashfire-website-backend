import { Queue } from 'bullmq';
import redisConnection from './redisConnection.js';

// Create queues only if Redis connection is available
export const callQueue = redisConnection ? new Queue('callQueue', { connection: redisConnection }) : null;
export const emailQueue = redisConnection ? new Queue('emailQueue', { connection: redisConnection }) : null;