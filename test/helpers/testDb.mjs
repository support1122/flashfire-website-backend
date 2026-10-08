// The ONLY way tests in this repo may reach MongoDB.
//
// The local .env MONGODB_URI points at the PRODUCTION cluster (plan section 12.2). Tests therefore connect to
// the same cluster but a throwaway database, and every helper here refuses to touch any other database name.
// Nothing is printed: the URI contains credentials.
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

export const TEST_DB_NAME = 'bda_attendance_test';

function testUri() {
  const env = dotenv.parse(readFileSync(new URL('../../.env', import.meta.url)));
  const raw = process.env.TEST_MONGODB_URI || env.MONGODB_URI;
  if (!raw) throw new Error('MONGODB_URI is not set in .env and TEST_MONGODB_URI is not set');
  const url = new URL(raw);
  url.pathname = `/${TEST_DB_NAME}`;
  return url.toString();
}

function assertTestDb() {
  const name = mongoose.connection?.db?.databaseName;
  if (name !== TEST_DB_NAME) {
    throw new Error(`Refusing to run: connected database is "${name}", expected "${TEST_DB_NAME}"`);
  }
}

/** Connect to the throwaway database. Safe to call from every test file's before(). */
export async function connectTestDb() {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(testUri(), { serverSelectionTimeoutMS: 15000 });
  }
  assertTestDb();
  process.env.MONGO_URI = testUri(); // some code and older tests read MONGO_URI
  return mongoose.connection;
}

/** Delete every document in one collection of the test database (never anything else). */
export async function clearCollection(name) {
  assertTestDb();
  await mongoose.connection.db.collection(name).deleteMany({});
}

/** Drop the whole throwaway database. Call from the last after() of a suite. */
export async function dropTestDb() {
  assertTestDb();
  await mongoose.connection.db.dropDatabase();
}

export async function disconnectTestDb() {
  if (mongoose.connection.readyState === 1) await mongoose.disconnect();
}

/** Keep tests off the network: no Discord posts, no Google calls. Call at the top of every test file. */
export function isolateExternalServices() {
  for (const k of Object.keys(process.env)) if (k.startsWith('DISCORD_')) delete process.env[k];
  process.env.MEET_API_ATTENDANCE_ENABLED = 'false';
  process.env.DISABLE_REDIS = 'true';
}
