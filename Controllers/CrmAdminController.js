import jwt from 'jsonwebtoken';
import { CrmUserModel, CRM_PERMISSION_KEYS_ALLOWED } from '../Schema_Models/CrmUser.js';
import { getCrmJwtSecret } from '../Middlewares/CrmAuth.js';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
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
      .select('email name permissions isActive createdAt updatedAt')
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
      await existing.save();
      return res.status(200).json({ success: true, user: existing });
    }

    const user = await CrmUserModel.create({
      email,
      name,
      permissions,
      isActive: req.body?.isActive === undefined ? true : !!req.body?.isActive,
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


