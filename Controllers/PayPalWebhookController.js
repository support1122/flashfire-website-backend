import { PaymentModel } from "../Schema_Models/Payment.js";
import { DiscordConnect } from "../Utils/DiscordConnect.js";
import { sendPaymentConfirmationEmail } from "../Utils/PaymentEmailHelper.js";

const PAYPAL_DISCORD_WEBHOOK =
  process.env.DISCORD_PAYPAL_WEBHOOK_URL ||
  process.env.DISCORD_MAIN_WEBHOOK_URL ||
  null;

/**
 * Handle PayPal webhook events
 * PayPal sends webhook notifications for various events like PAYMENT.CAPTURE.COMPLETED
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const handlePayPalWebhook = async (req, res) => {
  try {
    const webhookEvent = req.body;

    // Log the webhook event for debugging
    console.log('📥 PayPal Webhook Received:', {
      eventType: webhookEvent.event_type,
      eventId: webhookEvent.id,
      createTime: webhookEvent.create_time,
      resourceType: webhookEvent.resource_type
    });

    // Send rich Discord notification for any PayPal payment event
    if (PAYPAL_DISCORD_WEBHOOK) {
      try {
        const r = webhookEvent.resource || {};
        // Extract buyer info from different event structures
        const payer = r.payer || r.payment_source?.paypal || {};
        const payerName = [payer.name?.given_name, payer.name?.surname].filter(Boolean).join(' ')
          || payer.email_address || '';
        const payerEmail = payer.email_address || '';
        // Amount from capture or purchase_units
        const amtObj = r.amount || r.purchase_units?.[0]?.amount || {};
        const amount = amtObj.value ? `${amtObj.currency_code || 'USD'} ${amtObj.value}` : '';
        // Description / item name
        const item = r.purchase_units?.[0]?.items?.[0];
        const description = item?.name || r.purchase_units?.[0]?.description || r.description || '';
        const txnId = r.id || '';
        const istTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        const isPayment = ['PAYMENT.CAPTURE.COMPLETED', 'CHECKOUT.ORDER.COMPLETED'].includes(webhookEvent.event_type);
        const emoji = isPayment ? '💰' : 'ℹ️';

        const lines = [
          `${emoji} **PayPal: ${webhookEvent.event_type || 'Event'}**`,
          '────────────────────────────────',
          ...(payerName  ? [`👤 **Buyer:** ${payerName}`]        : []),
          ...(payerEmail ? [`📧 **Email:** ${payerEmail}`]       : []),
          ...(amount     ? [`💵 **Amount:** ${amount}`]          : []),
          ...(description? [`📦 **Plan/Item:** ${description}`]  : []),
          ...(txnId      ? [`🔖 **Transaction ID:** ${txnId}`]   : []),
          `🕐 **Time (IST):** ${istTime}`,
        ];

        await DiscordConnect(PAYPAL_DISCORD_WEBHOOK, lines.join('\n'), false);
        console.log('✅ PayPal webhook Discord notification sent');
      } catch (discordError) {
        console.error('❌ Failed to send PayPal Discord notification:', discordError.message);
      }
    } else {
      console.warn('⚠️ DISCORD_PAYPAL_WEBHOOK_URL not set — skipping Discord notification');
    }

    // Handle different event types
    switch (webhookEvent.event_type) {
      case 'PAYMENT.CAPTURE.COMPLETED':
        await handlePaymentCaptureCompleted(webhookEvent);
        break;
      
      case 'CHECKOUT.ORDER.COMPLETED':
        await handleOrderCompleted(webhookEvent);
        break;
      
      case 'PAYMENT.CAPTURE.REFUNDED':
        await handlePaymentRefunded(webhookEvent);
        break;
      
      default:
        console.log(`ℹ️ Unhandled PayPal webhook event: ${webhookEvent.event_type}`);
    }

    // Always return 200 OK to PayPal to acknowledge receipt
    // PayPal will retry if we don't respond with 200
    return res.status(200).json({
      success: true,
      message: 'Webhook received and processed'
    });

  } catch (error) {
    console.error('❌ Error processing PayPal webhook:', error);
    
    // Still return 200 to prevent PayPal from retrying indefinitely
    // Log the error for manual investigation
    return res.status(200).json({
      success: false,
      error: error.message || 'Error processing webhook'
    });
  }
};

/**
 * Handle PAYMENT.CAPTURE.COMPLETED event
 * This is triggered when a payment is successfully captured
 */
async function handlePaymentCaptureCompleted(webhookEvent) {
  try {
    const resource = webhookEvent.resource;
    const capture = resource; // The resource is the capture object
    
    if (!capture || capture.status !== 'COMPLETED') {
      console.log('⚠️ Payment capture not completed, skipping');
      return;
    }

    const orderId = capture.supplementary_data?.related_ids?.order_id || null;
    const captureId = capture.id;
    const amount = parseFloat(capture.amount?.value || 0);
    const currency = capture.amount?.currency_code || 'USD';
    
    // Get payer information from the capture
    const payerEmail = capture.payer?.email_address || null;
    const payerId = capture.payer?.payer_id || null;

    console.log('💰 Payment Capture Completed:', {
      captureId,
      orderId,
      amount,
      currency,
      payerEmail
    });

    // Find existing payment record by PayPal order ID or capture ID
    let payment = null;
    if (orderId) {
      payment = await PaymentModel.findOne({ paypalOrderId: orderId });
    }

    // If payment record exists and email hasn't been sent yet, send confirmation email
    // Note: Frontend payment creation already sends email, so webhook is mainly for backup/redundancy
    if (payment && payment.paymentStatus === 'completed') {
      const paymentAge = Date.now() - new Date(payment.createdAt || payment.paymentDate).getTime();
      const fiveMinutes = 5 * 60 * 1000;
      
      if (paymentAge > fiveMinutes) {
        console.log('sending webhook Discord notification only (email likely already sent)');
        await sendWebhookDiscordNotification(payment, {
          captureId,
          webhookEventId: webhookEvent.id,
          eventType: 'PAYMENT.CAPTURE.COMPLETED'
        });
      } else {
        // Payment is recent, might not have email sent yet, send both
        console.log('ℹ️ Recent payment, sending confirmation email via webhook');
        await sendPaymentConfirmationAndNotify(payment, {
          captureId,
          webhookEventId: webhookEvent.id
        });
      }
    } else {
      console.log('ℹ️ Payment record not found in database. Payment may be processed via frontend form.');
    }

  } catch (error) {
    console.error('❌ Error handling PAYMENT.CAPTURE.COMPLETED:', error);
    throw error;
  }
}

/**
 * Handle CHECKOUT.ORDER.COMPLETED event
 * This is triggered when an order is completed
 */
async function handleOrderCompleted(webhookEvent) {
  try {
    const resource = webhookEvent.resource;
    const order = resource;

    if (!order || order.status !== 'COMPLETED') {
      console.log('⚠️ Order not completed, skipping');
      return;
    }

    const orderId = order.id;
    const purchaseUnit = order.purchase_units?.[0];
    const capture = purchaseUnit?.payments?.captures?.[0];
    
    if (!capture || capture.status !== 'COMPLETED') {
      console.log('⚠️ No completed capture found in order');
      return;
    }

    const amount = parseFloat(capture.amount?.value || 0);
    const currency = capture.amount?.currency_code || 'USD';
    const payer = order.payer;
    const payerEmail = payer?.email_address || null;
    const payerId = payer?.payer_id || null;

    console.log('✅ Order Completed:', {
      orderId,
      amount,
      currency,
      payerEmail
    });

    // Find existing payment record
    const payment = await PaymentModel.findOne({ paypalOrderId: orderId });

    if (payment && payment.paymentStatus === 'completed') {
      const paymentAge = Date.now() - new Date(payment.createdAt || payment.paymentDate).getTime();
      const fiveMinutes = 5 * 60 * 1000;
      
      if (paymentAge > fiveMinutes) {
        console.log('ℹ️ Payment exists, sending webhook Discord notification only');
        await sendWebhookDiscordNotification(payment, {
          captureId: capture.id,
          webhookEventId: webhookEvent.id,
          eventType: 'CHECKOUT.ORDER.COMPLETED'
        });
      } else {
        console.log('ℹ️ Recent payment, sending confirmation email via webhook');
        await sendPaymentConfirmationAndNotify(payment, {
          captureId: capture.id,
          webhookEventId: webhookEvent.id
        });
      }
    } else {
      console.log('ℹ️ Payment record not found. Payment may be processed via frontend form.');
    }

  } catch (error) {
    console.error('❌ Error handling CHECKOUT.ORDER.COMPLETED:', error);
    throw error;
  }
}

/**
 * Handle PAYMENT.CAPTURE.REFUNDED event
 */
async function handlePaymentRefunded(webhookEvent) {
  try {
    const resource = webhookEvent.resource;
    const capture = resource;
    const orderId = capture.supplementary_data?.related_ids?.order_id || null;

    console.log('↩️ Payment Refunded:', {
      captureId: capture.id,
      orderId,
      refundAmount: capture.amount?.value
    });

    // Update payment status if record exists
    if (orderId) {
      const payment = await PaymentModel.findOne({ paypalOrderId: orderId });
      if (payment) {
        payment.paymentStatus = 'refunded';
        await payment.save();
        console.log('✅ Payment status updated to refunded');
      }
    }

  } catch (error) {
    console.error('❌ Error handling PAYMENT.CAPTURE.REFUNDED:', error);
    throw error;
  }
}

/**
 * Send webhook Discord notification only (no email to avoid duplicates)
 */
async function sendWebhookDiscordNotification(payment, metadata = {}) {
  try {
    const discordMessage = {
      "Message": "PayPal Webhook Received",
      "Event Type": metadata.eventType || "PAYMENT.CAPTURE.COMPLETED",
      "Client Name": `${payment.customerFirstName} ${payment.customerLastName}`,
      "Client Email": payment.customerEmail,
      "Amount": `${payment.currency} ${payment.amount.toFixed(2)}`,
      "Plan": `${payment.planName}${payment.planSubtitle ? ` - ${payment.planSubtitle}` : ''}`,
      "Transaction ID": payment.paypalOrderId,
      "Webhook Event ID": metadata.webhookEventId || "N/A",
      "Note": "Email already sent via frontend payment creation",
      "Timestamp": new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    };

    await DiscordConnect(
      PAYPAL_DISCORD_WEBHOOK,
      JSON.stringify(discordMessage, null, 2)
    );

    console.log('✅ Webhook Discord notification posted');
  } catch (error) {
    console.error('❌ Error sending webhook Discord notification:', error);
  }
}

/**
 * Send payment confirmation email and Discord notification
 */
async function sendPaymentConfirmationAndNotify(payment, metadata = {}) {
  try {
    // Send confirmation email to client
    const emailResult = await sendPaymentConfirmationEmail({
      customerEmail: payment.customerEmail,
      customerFirstName: payment.customerFirstName,
      customerLastName: payment.customerLastName,
      amount: payment.amount,
      currency: payment.currency,
      planName: payment.planName,
      planSubtitle: payment.planSubtitle,
      paypalOrderId: payment.paypalOrderId,
      paymentDate: payment.paymentDate || new Date()
    });

    // Send Discord notification
    const discordMessage = {
      "Message": "💳 Payment Confirmation Email Sent",
      "Client Name": `${payment.customerFirstName} ${payment.customerLastName}`,
      "Client Email": payment.customerEmail,
      "Amount": `${payment.currency} ${payment.amount.toFixed(2)}`,
      "Plan": `${payment.planName}${payment.planSubtitle ? ` - ${payment.planSubtitle}` : ''}`,
      "Transaction ID": payment.paypalOrderId,
      "Email Status": emailResult.success ? "✅ Sent Successfully" : `❌ Failed: ${emailResult.error}`,
      "Email Message ID": emailResult.messageId || "N/A",
      "Webhook Event ID": metadata.webhookEventId || "N/A",
      "Timestamp": new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    };

    await DiscordConnect(
      PAYPAL_DISCORD_WEBHOOK,
      JSON.stringify(discordMessage, null, 2)
    );

    console.log('✅ Payment confirmation email sent and Discord notification posted');

  } catch (error) {
    console.error('❌ Error sending payment confirmation:', error);
    // Don't throw - we don't want to fail the webhook processing
  }
}
