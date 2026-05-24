import crypto from "crypto";

/**
 * Zoom Phone Webhook Controller
 *
 * Handles:
 *  - endpoint.url_validation  → HMAC-SHA256 challenge/response (required by Zoom)
 *  - All other Zoom Phone events (ringing, completed, missed, recordings, transcripts)
 *
 * Required env var:
 *   ZOOM_WEBHOOK_SECRET_TOKEN=<your secret token from Zoom Marketplace>
 */

export const handleZoomPhoneWebhook = async (req, res) => {
  try {
    const body = req.body;

    // ── 1. URL Validation Challenge ──────────────────────────────────────────
    if (body.event === "endpoint.url_validation") {
      const plainToken = body?.payload?.plainToken;

      if (!plainToken) {
        return res.status(400).json({ error: "Missing plainToken in payload" });
      }

      const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
      if (!secret) {
        console.error("[ZoomPhone] ZOOM_WEBHOOK_SECRET_TOKEN is not set");
        return res.status(500).json({ error: "Webhook secret not configured" });
      }

      const encryptedToken = crypto
        .createHmac("sha256", secret)
        .update(plainToken)
        .digest("hex");

      console.log("[ZoomPhone] URL validation challenge passed");

      return res.status(200).json({
        plainToken,
        encryptedToken,
      });
    }

    // ── 2. All other Zoom Phone events ───────────────────────────────────────
    const event = body.event || "unknown";
    console.log(`[ZoomPhone] Received event: ${event}`, JSON.stringify(body, null, 2));

    switch (event) {
      case "phone.callee_ringing":
      case "phone.caller_ringing":
        // TODO: log inbound/outbound ringing to CRM activity
        break;

      case "phone.callee_call_log_completed":
      case "phone.caller_call_log_completed":
        // TODO: save completed call log to CRM
        break;

      case "phone.callee_missed_call":
      case "phone.caller_missed_call":
        // TODO: create missed-call activity in CRM
        break;

      case "phone.recording_completed":
        // TODO: store recording URL against CRM contact
        break;

      case "phone.voicemail_received":
        // TODO: store voicemail against CRM contact
        break;

      default:
        // Log unhandled events for future implementation
        console.log(`[ZoomPhone] Unhandled event type: ${event}`);
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("[ZoomPhone] Webhook error:", err);
    return res.status(500).json({ error: true });
  }
};
