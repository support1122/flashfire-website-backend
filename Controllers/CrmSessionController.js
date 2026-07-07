import { CrmSessionModel } from "../Schema_Models/CrmSessionModel.js";
import { CrmTrustedDeviceModel } from "../Schema_Models/CrmTrustedDeviceModel.js";

// Revoking a session also un-trusts the device it came from, so the next login
// from that device requires fresh admin approval rather than logging back in instantly.
async function untrustDeviceForSession(doc) {
  if (!doc.deviceKey) return;
  await CrmTrustedDeviceModel.deleteOne({ email: doc.email, deviceKey: doc.deviceKey });
}

function toSessionView(doc, currentSessionId) {
  return {
    id: String(doc._id),
    sessionId: doc.sessionId,
    email: doc.email,
    ip: doc.ip || "",
    country: doc.country || "",
    countryCode: doc.countryCode || "",
    deviceLabel: `${doc.browser || "Unknown"} on ${doc.os || "Unknown"}`,
    browser: doc.browser || "",
    os: doc.os || "",
    deviceType: doc.deviceType || "",
    revoked: doc.revoked,
    createdAt: doc.createdAt,
    lastSeenAt: doc.lastSeenAt,
    isCurrent: doc.sessionId === currentSessionId,
  };
}

// Sessions for the logged-in user only.
export const listMySessions = async (req, res) => {
  try {
    const email = req.crmUser?.email;
    const currentSessionId = req.crmUser?.sessionId;
    const docs = await CrmSessionModel.find({ email, revoked: false })
      .sort({ lastSeenAt: -1 });
    return res.status(200).json({ success: true, data: docs.map((d) => toSessionView(d, currentSessionId)) });
  } catch (error) {
    console.error("Error listing sessions:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to list sessions" });
  }
};

// Revoke a session — must belong to the requesting user (or requester is admin).
export const revokeMySession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const email = req.crmUser?.email;

    const doc = await CrmSessionModel.findOne({ sessionId });
    if (!doc) return res.status(404).json({ success: false, error: "Session not found" });
    if (doc.email !== email) return res.status(403).json({ success: false, error: "Forbidden" });

    doc.revoked = true;
    doc.revokedAt = new Date();
    await doc.save();
    await untrustDeviceForSession(doc);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error revoking session:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to revoke session" });
  }
};

// Admin: list every active session across all CRM users.
export const listAllSessions = async (req, res) => {
  try {
    const docs = await CrmSessionModel.find({ revoked: false }).sort({ lastSeenAt: -1 });
    return res.status(200).json({ success: true, data: docs.map((d) => toSessionView(d, null)) });
  } catch (error) {
    console.error("Error listing all sessions:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to list sessions" });
  }
};

// Admin: revoke any user's session.
export const adminRevokeSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const doc = await CrmSessionModel.findOne({ sessionId });
    if (!doc) return res.status(404).json({ success: false, error: "Session not found" });

    doc.revoked = true;
    doc.revokedAt = new Date();
    await doc.save();
    await untrustDeviceForSession(doc);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error revoking session (admin):", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to revoke session" });
  }
};
