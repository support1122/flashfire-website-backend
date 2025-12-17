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

export async function sendCrmOtpEmail(to, otp, name) {
  const safeName = name ? String(name).trim() : '';
  const msg = {
    to,
    from: process.env.SENDGRID_FROM_EMAIL,
    subject: 'Your FlashFire CRM login code',
    text: `Your FlashFire CRM OTP is: ${otp}\n\nThis code expires in 5 minutes.`,
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; max-width:600px; margin:0 auto; padding:20px; background:#f8fafc; border-radius:16px; color:#0f172a;">
        <div style="background:#0f172a; color:white; padding:18px 20px; border-radius:14px;">
          <div style="font-size:14px; opacity:0.85; letter-spacing:0.06em; text-transform:uppercase;">FlashFire CRM</div>
          <div style="font-size:22px; font-weight:800; margin-top:6px;">One-time login code</div>
        </div>

        <div style="background:white; border:1px solid #e2e8f0; padding:20px; border-radius:14px; margin-top:14px;">
          <p style="margin:0 0 10px 0; font-size:15px; color:#334155;">
            ${safeName ? `Hi ${safeName},` : 'Hi,'}
          </p>
          <p style="margin:0 0 16px 0; font-size:15px; color:#334155;">
            Use this OTP to log in. It expires in <b>5 minutes</b>.
          </p>

          <div style="display:flex; align-items:center; justify-content:center; padding:14px; border-radius:12px; background:#fff7ed; border:1px solid #fed7aa;">
            <span style="font-size:28px; font-weight:900; letter-spacing:0.22em; color:#ea580c;">${otp}</span>
          </div>

          <p style="margin:16px 0 0 0; font-size:13px; color:#64748b;">
            If you didn’t request this code, ignore this email.
          </p>
        </div>

        <p style="margin:14px 0 0 0; text-align:center; font-size:12px; color:#94a3b8;">
          © ${new Date().getFullYear()} FlashFire
        </p>
      </div>
    `,
  };

  await sgMail.send(msg);
}