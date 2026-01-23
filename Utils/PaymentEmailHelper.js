import sgMail from "@sendgrid/mail";
import dotenv from "dotenv";
dotenv.config();
import { DiscordConnect } from "./DiscordConnect.js";

sgMail.setApiKey(process.env.SENDGRID_API_KEY_1 || process.env.SENDGRID_API_KEY);


export async function sendPaymentConfirmationEmail(paymentData) {
  try {
    const {
      customerEmail,
      customerFirstName,
      customerLastName,
      amount,
      currency = 'USD',
      planName,
      planSubtitle,
      paypalOrderId,
      paymentDate = new Date(),
    } = paymentData;

    if (!customerEmail || !customerFirstName || !amount || !planName) {
      throw new Error('Missing required payment data for email');
    }

    const customerName = `${customerFirstName} ${customerLastName || ''}`.trim();
    const formattedAmount = parseFloat(amount).toFixed(2);
    const formattedDate = new Date(paymentDate).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    });

    // Determine sender email
    const senderEmail = process.env.SENDER_EMAIL || process.env.SENDGRID_FROM_EMAIL || 'noreply@flashfirehq.com';

    const msg = {
      to: customerEmail,
      from: {
        email: senderEmail,
        name: 'FlashFire'
      },
      subject: `Payment Confirmation - ${planName} Plan`,
      html: `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Payment Confirmation</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
    <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
        <tr>
            <td align="center" style="padding: 40px 20px;">
                <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <!-- Header -->
                    <tr>
                        <td style="padding: 40px 40px 30px; text-align: center; background: linear-gradient(135deg, #ff5722 0%, #ff7043 100%); border-radius: 8px 8px 0 0;">
                            <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">
                                Payment Received
                            </h1>
                            <p style="margin: 10px 0 0; color: #ffffff; font-size: 16px; opacity: 0.95;">
                                Thank you for your payment!
                            </p>
                        </td>
                    </tr>

                    <!-- Main Content -->
                    <tr>
                        <td style="padding: 40px 40px 30px;">
                            <p style="margin: 0 0 20px; color: #333333; font-size: 16px; line-height: 1.6;">
                                Dear ${customerName},
                            </p>
                            <p style="margin: 0 0 30px; color: #555555; font-size: 16px; line-height: 1.6;">
                                We are pleased to confirm that we have successfully received your payment. Your transaction has been processed and your account has been updated accordingly.
                            </p>

                            <!-- Payment Details Box -->
                            <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f8f9fa; border-radius: 8px; margin: 30px 0; border: 1px solid #e9ecef;">
                                <tr>
                                    <td style="padding: 25px;">
                                        <h2 style="margin: 0 0 20px; color: #333333; font-size: 18px; font-weight: 600; border-bottom: 2px solid #ff5722; padding-bottom: 10px;">
                                            Payment Details
                                        </h2>
                                        
                                        <table role="presentation" style="width: 100%; border-collapse: collapse;">
                                            <tr>
                                                <td style="padding: 8px 0; color: #666666; font-size: 14px; width: 40%;">Plan:</td>
                                                <td style="padding: 8px 0; color: #333333; font-size: 14px; font-weight: 600;">${planName}${planSubtitle ? ` - ${planSubtitle}` : ''}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 8px 0; color: #666666; font-size: 14px;">Amount Paid:</td>
                                                <td style="padding: 8px 0; color: #333333; font-size: 16px; font-weight: 700; color: #ff5722;">${currency} ${formattedAmount}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 8px 0; color: #666666; font-size: 14px;">Transaction ID:</td>
                                                <td style="padding: 8px 0; color: #333333; font-size: 14px; font-family: monospace;">${paypalOrderId}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 8px 0; color: #666666; font-size: 14px;">Payment Date:</td>
                                                <td style="padding: 8px 0; color: #333333; font-size: 14px;">${formattedDate}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 8px 0; color: #666666; font-size: 14px;">Status:</td>
                                                <td style="padding: 8px 0;">
                                                    <span style="display: inline-block; padding: 4px 12px; background-color: #d4edda; color: #155724; border-radius: 4px; font-size: 13px; font-weight: 600;">
                                                        ✓ Completed
                                                    </span>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>

                            <!-- Next Steps -->
                            <div style="background-color: #fff7ed; border-left: 4px solid #ff5722; padding: 20px; margin: 30px 0; border-radius: 4px;">
                                <h3 style="margin: 0 0 10px; color: #333333; font-size: 16px; font-weight: 600;">
                                    What's Next?
                                </h3>
                                <p style="margin: 0; color: #555555; font-size: 14px; line-height: 1.6;">
                                    Your account has been activated with the <strong>${planName}</strong> plan. You can now access all the features and benefits included in your subscription. Our team will contact you soon. If you have any questions or need assistance, please don't hesitate to contact our support team.
                                </p>
                            </div>

                            <!-- Support Information -->
                            <p style="margin: 30px 0 0; color: #666666; font-size: 14px; line-height: 1.6;">
                                If you have any questions about this payment or need assistance, please contact our support team at 
                                <a href="mailto:support@flashfirehq.com" style="color: #ff5722; text-decoration: none; font-weight: 600;">support@flashfirehq.com</a>
                            </p>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding: 30px 40px; background-color: #f8f9fa; border-top: 1px solid #e9ecef; border-radius: 0 0 8px 8px;">
                            <p style="margin: 0 0 10px; color: #666666; font-size: 12px; text-align: center; line-height: 1.6;">
                                This is an automated confirmation email. Please do not reply to this message.
                            </p>
                            <p style="margin: 0; color: #999999; font-size: 12px; text-align: center;">
                                © ${new Date().getFullYear()} FlashFire. All rights reserved.
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
      `,
      text: `
Payment Confirmation - ${planName} Plan

Dear ${customerName},

We are pleased to confirm that we have successfully received your payment. Your transaction has been processed and your account has been updated accordingly.

PAYMENT DETAILS:
- Plan: ${planName}${planSubtitle ? ` - ${planSubtitle}` : ''}
- Amount Paid: ${currency} ${formattedAmount}
- Transaction ID: ${paypalOrderId}
- Payment Date: ${formattedDate}
- Status: Completed

Your account has been activated with the ${planName} plan. You can now access all the features and benefits included in your subscription.

If you have any questions about this payment or need assistance, please contact our support team at support@flashfirehq.com

This is an automated confirmation email. Please do not reply to this message.

© ${new Date().getFullYear()} FlashFire. All rights reserved.
      `.trim()
    };

    const result = await sgMail.send(msg);
    
    // Send Discord notification about email being sent
    try {
      const discordWebhookUrl = process.env.DISCORD_PAYMENT_URL || process.env.DISCORD_WEB_HOOK_URL;
      
      if (discordWebhookUrl) {
        const formattedDate = new Date(paymentDate).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZoneName: 'short'
        });

        const planDisplay = planSubtitle ? `${planName} - ${planSubtitle}` : planName;

        const discordMessage = `Email Sent to Client

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Name:        ${customerName}
Email:       ${customerEmail}
Plan:        ${planDisplay}
Amount:      ${currency} ${formattedAmount}
Date:        ${formattedDate}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

        await DiscordConnect(discordWebhookUrl, discordMessage, false);
        console.log('✅ Discord notification sent for payment email');
      }
    } catch (discordError) {
      console.error('❌ Failed to send Discord notification:', discordError);
    }
    
    return {
      success: true,
      messageId: result[0]?.headers?.['x-message-id'],
      statusCode: result[0]?.statusCode
    };
  } catch (error) {
    console.error('❌ Error sending payment confirmation email:', error);
    return {
      success: false,
      error: error.message || 'Failed to send payment confirmation email',
      response: error.response?.body || null
    };
  }
}
