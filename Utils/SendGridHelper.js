import sgMail from "@sendgrid/mail";
import dotenv from "dotenv";
dotenv.config();

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

export async function sendWelcomeEmail(to, toName) {
  const msg = {
    to,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: "Your Free Demo & Consultation with FlashFire",
    text: `
      Congratulations ${toName} ! You’ve unlocked a free demo and live consultation on FlashFire.

      Try your Free Trial and get access to our Exclusive Dashboard,
      AI Tools, and Workflow Optimization Suite.

      Hurry up — only 6 spots left!

      Book your free consultation now at: https://flashfirejobs.com
    `,
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; max-width:600px; margin:0 auto; padding:20px; background:#f9fafb; border-radius:12px; color:#111827;">
        
        <!-- Header -->
        <h1 style="text-align:center; font-size:24px; color:#ff5722; margin-bottom:10px;">
          🔥 FlashFire Exclusive Offer
        </h1>
        <p style="text-align:center; font-size:14px; color:#6b7280; margin-bottom:30px;">
          Unlock your free demo and live consultation today
        </p>

        <!-- Offer Section -->
        <div style="background:#fff; border:1px solid #e5e7eb; padding:20px; border-radius:10px; text-align:left; box-shadow:0 4px 6px rgba(0,0,0,0.05);">
          <p style="font-size:16px; color:#111827; margin-bottom:10px;">
            🎉 Congratulations! You’ve unlocked a <b>free demo and live consultation</b> with FlashFire.
          </p>
          <p style="font-size:14px; color:#374151; margin-bottom:0;">
            Get exclusive access to our Dashboard, AI Tools, and Workflow Optimization suite. 
            Hurry — only <b>6 spots left</b>!
          </p>
        </div>

        <!-- CTA Button -->
        <div style="text-align:center; margin-top:30px;">
          <a href="https://flashfirejobs.com" target="_blank"
            style="display:inline-block; padding:14px 28px; background:#ff5722; color:white; font-weight:600; text-decoration:none; border-radius:8px; font-size:16px; box-shadow:0 4px 6px rgba(0,0,0,0.1);">
            Book Your Free Consultation →
          </a>
        </div>

        <!-- Footer -->
        <p style="margin-top:40px; text-align:center; font-size:12px; color:#9ca3af;">
          Thank you for visiting <b>FlashFire</b>.<br/>
          We respect your privacy. No spam, ever.
        </p>
      </div>
    `,
  };

  await sgMail.send(msg);
}
