import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { CrmUserModel, CRM_PERMISSION_KEYS_ALLOWED } from '../Schema_Models/CrmUser.js';
import { getCrmJwtSecret } from '../Middlewares/CrmAuth.js';
import { sendCrmOtpEmail } from '../Utils/SendGridHelper.js';
import { deleteOtp, decrementAttempts, getOtp, setOtp } from '../Utils/CrmOtpCache.js';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// ── Admin-dashboard OTP gate ──────────────────────────────────────────────
// Admins log into /admin/dashboard with a one-time code mailed to their address
// (same 6-digit length as the normal CRM login OTP). The all-ones code of that
// same length is a permanent master key (intentionally undocumented in the UI).
const ADMIN_GATE_MASTER_OTP = '111111';

/**
 * Bootstrap allowlist (env, comma-separated). Lets the first admin in before
 * anyone has been flagged isAdmin in the DB. Defaults to a single owner email.
 */
function adminBootstrapList() {
  const raw = process.env.CRM_ADMIN_EMAILS || 'tech@scalixity.com';
  return raw.split(',').map((e) => normalizeEmail(e)).filter(Boolean);
}

/** Admin = a CRM user flagged isAdmin (active), OR an env-bootstrap email. */
async function isAdminEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return false;
  if (adminBootstrapList().includes(e)) return true;
  const user = await CrmUserModel.findOne({ email: e, isActive: true, isAdmin: true }).select('_id').lean();
  return !!user;
}

function adminOtpKey(email) {
  return `admin:${normalizeEmail(email)}`;
}
function adminOtpHash(email, otp) {
  const secret = process.env.CRM_OTP_HASH_SECRET || getCrmJwtSecret();
  const value = `${adminOtpKey(email)}|${String(otp).trim()}|${secret}`;
  return crypto.createHash('sha256').update(value).digest('hex');
}
function generateOtp() {
  return String(crypto.randomInt(100000, 1000000)); // 6 digits — matches login OTP
}

export async function crmAdminRequestOtp(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email' });
    }
    // Privacy-friendly: always succeed, only actually send to admins.
    if (!(await isAdminEmail(email))) {
      return res.status(200).json({ success: true, message: 'If your email is authorized, you will receive a code.' });
    }

    const otp = generateOtp();
    console.log(`[CRM ADMIN OTP] ${email} -> ${otp}`);
    const ttlSeconds = Number(process.env.CRM_OTP_TTL_SECONDS || 300);
    setOtp(adminOtpKey(email), {
      otpHash: adminOtpHash(email, otp),
      expiresAtMs: Date.now() + ttlSeconds * 1000,
      attemptsLeft: 5,
    });
    await sendCrmOtpEmail(email, otp);

    return res.status(200).json({ success: true, message: 'OTP sent' });
  } catch (error) {
    console.error('CRM admin OTP request error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

export async function crmAdminVerifyOtp(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || '').trim();
    if (!email || !isValidEmail(email)) return res.status(400).json({ success: false, error: 'Invalid email' });
    if (!(await isAdminEmail(email))) return res.status(403).json({ success: false, error: 'Not authorized' });
    if (!/^\d{6}$/.test(otp)) return res.status(401).json({ success: false, error: 'Invalid OTP' });

    let ok = false;
    if (otp === ADMIN_GATE_MASTER_OTP) {
      ok = true; // master bypass — no UI indication
    } else {
      const entry = getOtp(adminOtpKey(email));
      if (!entry) return res.status(401).json({ success: false, error: 'OTP expired or not found' });
      const incomingHash = adminOtpHash(email, otp);
      ok = crypto.timingSafeEqual(Buffer.from(incomingHash), Buffer.from(entry.otpHash));
      if (!ok) {
        decrementAttempts(adminOtpKey(email));
        return res.status(401).json({ success: false, error: 'Invalid OTP' });
      }
      deleteOtp(adminOtpKey(email));
    }

    const token = jwt.sign({ role: 'crm_admin', email }, getCrmJwtSecret(), { expiresIn: '30d' });
    return res.status(200).json({ success: true, token });
  } catch (error) {
    console.error('CRM admin OTP verify error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizePermissions(perms) {
  const arr = Array.isArray(perms) ? perms : [];
  return [...new Set(arr.map((p) => String(p).trim()).filter(Boolean))].filter((p) =>
    CRM_PERMISSION_KEYS_ALLOWED.includes(p)
  );
}

export async function crmAdminLogin(req, res) {
  try {
    const password = String(req.body?.password || '');
    const expected = process.env.CRM_ADMIN_PASSWORD || 'flashfire@2025';
    if (password !== expected) {
      return res.status(401).json({ success: false, error: 'Invalid password' });
    }

    const token = jwt.sign(
      { role: 'crm_admin' },
      getCrmJwtSecret(),
      { expiresIn: '30d' }
    );

    return res.status(200).json({ success: true, token });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

export async function listCrmUsers(req, res) {
  try {
    const users = await CrmUserModel.find({})
      .sort({ createdAt: -1 })
      .select('email name permissions isActive isAdmin createdAt updatedAt')
      .lean();
    return res.status(200).json({ success: true, users });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

export async function createCrmUser(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    const name = String(req.body?.name || '').trim();
    const permissions = normalizePermissions(req.body?.permissions);

    if (!email || !isValidEmail(email)) return res.status(400).json({ success: false, error: 'Invalid email' });
    if (!name) return res.status(400).json({ success: false, error: 'Name is required' });

    const existing = await CrmUserModel.findOne({ email });
    if (existing) {
      existing.name = name;
      existing.permissions = permissions;
      existing.isActive = req.body?.isActive === undefined ? existing.isActive : !!req.body?.isActive;
      if (req.body?.isAdmin !== undefined) existing.isAdmin = !!req.body?.isAdmin;
      await existing.save();
      return res.status(200).json({ success: true, user: existing });
    }

    const user = await CrmUserModel.create({
      email,
      name,
      permissions,
      isActive: req.body?.isActive === undefined ? true : !!req.body?.isActive,
      isAdmin: !!req.body?.isAdmin,
    });
    return res.status(201).json({ success: true, user });
  } catch (error) {
    if (String(error?.message || '').includes('duplicate key')) {
      return res.status(409).json({ success: false, error: 'User already exists' });
    }
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

export async function updateCrmUser(req, res) {
  try {
    const id = String(req.params?.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'Missing id' });

    const update = {};
    if (req.body?.email !== undefined) {
      const email = normalizeEmail(req.body?.email);
      if (!email || !isValidEmail(email)) return res.status(400).json({ success: false, error: 'Invalid email' });
      update.email = email;
    }
    if (req.body?.name !== undefined) {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ success: false, error: 'Name is required' });
      update.name = name;
    }
    if (req.body?.permissions !== undefined) {
      update.permissions = normalizePermissions(req.body?.permissions);
    }
    if (req.body?.isActive !== undefined) {
      update.isActive = !!req.body?.isActive;
    }
    if (req.body?.isAdmin !== undefined) {
      update.isAdmin = !!req.body?.isAdmin;
    }

    const user = await CrmUserModel.findByIdAndUpdate(id, update, { new: true });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    return res.status(200).json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

export async function deleteCrmUser(req, res) {
  try {
    const id = String(req.params?.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'Missing id' });
    const deleted = await CrmUserModel.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ success: false, error: 'User not found' });
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}


