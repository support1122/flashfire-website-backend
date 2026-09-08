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
let clientTrackingRecordModel = null;

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

// `strict: false` — read-only. The authoritative schema (ClientModel /
// 'DashboardTracking') lives in the clients-tracking repo. This is the
// registration record written when a client pays. Verified against live data
// (290 rows): `planType` is lowercase (ignite/professional/executive/prime),
// `amountPaid` is a string that is usually symbol-prefixed ("£79", "$99",
// "CAD749", "₹46629") but sometimes bare ("579"), the `currency` field is
// never populated here (currency lives on the matching `users` row instead),
// and `crmEmail` — the CRM email captured at registration — is our only
// mapping key (set on ~135/290 rows).
const clientTrackingRecordSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    crmEmail: String,
    // "Payment Email" from the registration form — the address the client
    // actually paid Stripe with (may differ from email / crmEmail).
    paymentEmail: String,
    planType: String,
    planPrice: Number,
    amountPaid: String,
    amountPaidDate: String,
    currency: String,
  },
  { timestamps: true, strict: false }
);

export function getClientTrackingRecordModel() {
  const c = getClientsTrackingConnection();
  if (!c) return null;
  if (!clientTrackingRecordModel) {
    // ClientModel in the clients-tracking repo: mongoose.model('DashboardTracking', ...)
    // with no explicit collection name -> collection 'dashboardtrackings'.
    clientTrackingRecordModel = c.model(
      'ClientTrackingRecord',
      clientTrackingRecordSchema,
      'dashboardtrackings'
    );
  }
  return clientTrackingRecordModel;
}
