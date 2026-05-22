import mongoose from 'mongoose';

/**
 * Secondary MongoDB connection to the clients-tracking database
 * (a different cluster than the main CRM DB). Holds the paying-client
 * records used by the Graphs module.
 *
 * Set CLIENTS_TRACKING_MONGODB_URI in the backend .env to enable it.
 * When unset, paid-client analytics are simply disabled (no crash).
 */
let conn = null;
let clientUserModel = null;

export function getClientsTrackingConnection() {
  if (conn) return conn;
  const uri = process.env.CLIENTS_TRACKING_MONGODB_URI;
  if (!uri) {
    console.warn(
      '[ClientsTrackingDB] CLIENTS_TRACKING_MONGODB_URI not set — paid-client analytics disabled'
    );
    return null;
  }
  conn = mongoose.createConnection(uri);
  conn.on('connected', () => console.log('✅ [ClientsTrackingDB] connected to clients-tracking DB'));
  conn.on('error', (e) => console.error('[ClientsTrackingDB] connection error:', e.message));
  return conn;
}

// `strict: false` — we only read; the real schema lives in the clients-tracking repo.
const clientUserSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    planType: String,
  },
  { timestamps: true, strict: false }
);

export function getClientUserModel() {
  const c = getClientsTrackingConnection();
  if (!c) return null;
  if (!clientUserModel) {
    // collection name is `users` in the clients-tracking DB
    clientUserModel = c.model('ClientTrackingUser', clientUserSchema, 'users');
  }
  return clientUserModel;
}
