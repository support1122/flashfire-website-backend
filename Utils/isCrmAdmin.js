import { CrmUserModel } from '../Schema_Models/CrmUser.js';

/**
 * True when the CRM user is an admin. Reads the user from the database on every call (plan 8.3), because the
 * JWT is a snapshot from login time: a demoted or deactivated admin must lose access without waiting for expiry,
 * and `role: 'bda'` accounts with `isAdmin: true` exist and must pass.
 * `user` is the verified token payload (req.crmUser); only its email is trusted as a key.
 */
export async function isCrmAdmin(user) {
  const email = String(user?.email ?? '').trim().toLowerCase();
  if (!email) return false;
  const row = await CrmUserModel.findOne({ email }).select('role isAdmin isActive').lean();
  if (!row || row.isActive === false) return false;
  return row.role === 'admin' || row.isAdmin === true;
}
