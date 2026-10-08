// Preload for legacy tests that read MONGO_URI at import time:
//   node --import ./test/helpers/useTestDbEnv.mjs --test test/BdaAttendanceAssignment.test.mjs
// connectTestDb() points MONGO_URI at the throwaway database and refuses any other.
import { connectTestDb } from './testDb.mjs';

await connectTestDb();
