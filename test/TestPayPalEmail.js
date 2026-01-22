import { sendPaymentConfirmationEmail } from '../Utils/PaymentEmailHelper.js';

/**
 * Test route to send a payment confirmation email
 * GET /test/paypal
 */
export default async function TestPayPalEmail(req, res) {
  try {
    // Hardcoded test data
    const testPaymentData = {
      customerEmail: 'sohith@flashfirehq.com',
      customerFirstName: 'Sohith',
      customerLastName: 'Test',
      amount: 299.99,
      currency: 'USD',
      planName: 'PROFESSIONAL',
      planSubtitle: 'Premium Plan',
      paypalOrderId: 'TEST-ORDER-' + Date.now(),
      paymentDate: new Date()
    };

    console.log('🧪 Testing PayPal payment confirmation email...');
    console.log('📧 Sending to:', testPaymentData.customerEmail);
    console.log('💰 Amount:', testPaymentData.currency, testPaymentData.amount);
    console.log('📦 Plan:', testPaymentData.planName, '-', testPaymentData.planSubtitle);

    // Send the email
    const result = await sendPaymentConfirmationEmail(testPaymentData);

    if (result.success) {
      console.log('✅ Test email sent successfully!');
      console.log('📧 Message ID:', result.messageId);
      console.log('📊 Status Code:', result.statusCode);

      return res.status(200).json({
        success: true,
        message: 'Test payment confirmation email sent successfully',
        data: {
          recipient: testPaymentData.customerEmail,
          amount: `${testPaymentData.currency} ${testPaymentData.amount}`,
          plan: `${testPaymentData.planName} - ${testPaymentData.planSubtitle}`,
          transactionId: testPaymentData.paypalOrderId,
          messageId: result.messageId,
          statusCode: result.statusCode,
          timestamp: new Date().toISOString()
        }
      });
    } else {
      console.error('❌ Failed to send test email:', result.error);
      
      return res.status(500).json({
        success: false,
        message: 'Failed to send test payment confirmation email',
        error: result.error,
        response: result.response,
        data: {
          recipient: testPaymentData.customerEmail,
          attemptedAt: new Date().toISOString()
        }
      });
    }

  } catch (error) {
    console.error('❌ Error in test PayPal email route:', error);
    return res.status(500).json({
      success: false,
      message: 'Error testing PayPal email',
      error: error.message || 'Unknown error',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
