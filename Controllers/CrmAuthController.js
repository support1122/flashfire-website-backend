import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { sendCrmOtpEmail } from '../Utils/SendGridHelper.js';
import { deleteOtp, decrementAttempts, getOtp, setOtp, getOtpCacheStats } from '../Utils/CrmOtpCache.js';
import { getCrmJwtSecret } from '../Middlewares/CrmAuth.js';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  // Simple internal validation; not RFC perfect but good enough for auth.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000)); // 6 digits
}

function otpHash(email, otp) {
  const secret = process.env.CRM_OTP_HASH_SECRET || getCrmJwtSecret();
  const value = `${normalizeEmail(email)}|${String(otp).trim()}|${secret}`;
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function requestCrmOtp(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email' });
    }

    const user = await CrmUserModel.findOne({ email }).lean();

    // Privacy-friendly response: always return success even if user not found/inactive.
    // But only send OTP if user exists and is active.
    if (!user || user.isActive === false) {
      return res.status(200).json({ success: true, message: 'If your email is authorized, you will receive an OTP.' });
    }

    const otp = generateOtp();
    // Requested: console log OTP for now (keep it short and clear)
    console.log(`[CRM OTP] ${email} -> ${otp}`);

    const ttlSeconds = Number(process.env.CRM_OTP_TTL_SECONDS || 300);
    const expiresAtMs = Date.now() + ttlSeconds * 1000;
    setOtp(email, { otpHash: otpHash(email, otp), expiresAtMs, attemptsLeft: 5 });

    // Send email via SendGrid
    await sendCrmOtpEmail(email, otp, user?.name);

    return res.status(200).json({
      success: true,
      message: 'OTP sent',
      cache: getOtpCacheStats(),
    });
  } catch (error) {
    console.error('CRM OTP request error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

export async function verifyCrmOtp(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || '').trim();

    if (!email || !isValidEmail(email)) return res.status(400).json({ success: false, error: 'Invalid email' });
    if (!/^\d{6}$/.test(otp)) return res.status(400).json({ success: false, error: 'Invalid OTP' });

    const entry = getOtp(email);
    if (!entry) {
      return res.status(401).json({ success: false, error: 'OTP expired or not found' });
    }

    const incomingHash = otpHash(email, otp);
    const ok = crypto.timingSafeEqual(Buffer.from(incomingHash), Buffer.from(entry.otpHash));
    if (!ok) {
      decrementAttempts(email);
      return res.status(401).json({ success: false, error: 'Invalid OTP' });
    }

    // Required: remove it after validation
    deleteOtp(email);

    const user = await CrmUserModel.findOne({ email }).lean();
    if (!user || user.isActive === false) {
      return res.status(403).json({ success: false, error: 'User not authorized' });
    }

    const token = jwt.sign(
      {
        role: 'crm_user',
        email: user.email,
        name: user.name,
        permissions: user.permissions || [],
      },
      getCrmJwtSecret(),
      { expiresIn: '7d' }
    );

    return res.status(200).json({
      success: true,
      token,
      user: {
        email: user.email,
        name: user.name,
        permissions: user.permissions || [],
      },
    });
  } catch (error) {
    console.error('CRM OTP verify error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

export async function crmMe(req, res) {
  try {
    const email = normalizeEmail(req.crmUser?.email);
    if (!email) return res.status(401).json({ success: false, error: 'Invalid token' });
    const user = await CrmUserModel.findOne({ email }).lean();
    if (!user || user.isActive === false) return res.status(401).json({ success: false, error: 'Unauthorized' });
    return res.status(200).json({
      success: true,
      user: {
        email: user.email,
        name: user.name,
        permissions: user.permissions || [],
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}


