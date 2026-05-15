import mongoose from 'mongoose';
import { ActivityLogModel } from '../Schema_Models/ActivityLog.js';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

function encodeCursor(doc) {
  if (!doc) return null;
  return Buffer.from(JSON.stringify({ t: new Date(doc.createdAt).getTime(), i: String(doc._id) })).toString('base64');
}

function decodeCursor(raw) {
  try {
    const parsed = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
    if (!parsed || typeof parsed.t !== 'number' || !parsed.i) return null;
    return { t: new Date(parsed.t), i: new mongoose.Types.ObjectId(parsed.i) };
  } catch {
    return null;
  }
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * GET /api/crm/admin/activity-logs
 * Cursor-paginated activity feed for the admin Activity tab (infinite scroll).
 * Query: cursor, limit, actorEmail, actorRole, category, action, success, targetId, search, from, to
 */
export async function getActivityLogs(req, res) {
  try {
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
    const filter = {};

    if (req.query.actorEmail) filter.actorEmail = String(req.query.actorEmail).trim().toLowerCase();
    if (req.query.actorRole) filter.actorRole = String(req.query.actorRole).trim();
    if (req.query.category) filter.category = String(req.query.category).trim().toLowerCase();
    if (req.query.action) filter.action = String(req.query.action).trim();
    if (req.query.targetId) filter.targetId = String(req.query.targetId).trim();
    if (req.query.success === 'true') filter.success = true;
    if (req.query.success === 'false') filter.success = false;

    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) {
        const d = new Date(req.query.from);
        if (!isNaN(d)) filter.createdAt.$gte = d;
      }
      if (req.query.to) {
        const d = new Date(req.query.to);
        if (!isNaN(d)) filter.createdAt.$lte = d;
      }
      if (!Object.keys(filter.createdAt).length) delete filter.createdAt;
    }

    if (req.query.search) {
      const rx = new RegExp(escapeRegex(String(req.query.search).trim()), 'i');
      filter.$or = [{ actorEmail: rx }, { actorName: rx }, { label: rx }, { targetId: rx }, { action: rx }];
    }

    // Cursor: keyset pagination on (createdAt desc, _id desc) — stable + index-friendly.
    if (req.query.cursor) {
      const cur = decodeCursor(req.query.cursor);
      if (cur) {
        const keyset = {
          $or: [{ createdAt: { $lt: cur.t } }, { createdAt: cur.t, _id: { $lt: cur.i } }],
        };
        if (filter.$or) {
          filter.$and = [{ $or: filter.$or }, keyset];
          delete filter.$or;
        } else {
          Object.assign(filter, keyset);
        }
      }
    }

    const docs = await ActivityLogModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = docs.length > limit;
    const items = hasMore ? docs.slice(0, limit) : docs;
    const nextCursor = hasMore ? encodeCursor(items[items.length - 1]) : null;

    return res.status(200).json({ success: true, items, nextCursor, hasMore });
  } catch (error) {
    console.error('getActivityLogs error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

/**
 * GET /api/crm/admin/activity-logs/filters
 * Distinct values for the filter dropdowns. Cached briefly to stay cheap.
 */
let filtersCache = { at: 0, data: null };
export async function getActivityFilters(req, res) {
  try {
    if (filtersCache.data && Date.now() - filtersCache.at < 60_000) {
      return res.status(200).json({ success: true, ...filtersCache.data });
    }
    const [actors, categories, roles] = await Promise.all([
      ActivityLogModel.distinct('actorEmail'),
      ActivityLogModel.distinct('category'),
      ActivityLogModel.distinct('actorRole'),
    ]);
    const data = {
      actorEmails: actors.filter(Boolean).sort(),
      categories: categories.filter(Boolean).sort(),
      roles: roles.filter(Boolean).sort(),
    };
    filtersCache = { at: Date.now(), data };
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    console.error('getActivityFilters error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}
