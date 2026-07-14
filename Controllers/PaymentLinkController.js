import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PLANS = {
  professional: {
    name: 'Professional Plan',
    description: 'Professional Plan – Mid-Level Professionals\n\nOnce your payment is confirmed, you will receive an official invoice via email. Our team will initiate the onboarding process within 24 hours.',
    originalPrice: 349,
  },
  executive: {
    name: 'Executive Plan',
    description: 'Executive Plan – 1200+ Applications\n\nOnce your payment is confirmed, you will receive an official invoice via email. Our team will initiate the onboarding process within 24 hours.',
    originalPrice: 599,
  },
};

export async function generatePaymentLink(req, res) {
  try {
    const { plan, discount } = req.body;

    if (!plan || !PLANS[plan]) {
      return res.status(400).json({ success: false, error: 'Invalid plan selected.' });
    }

    const planConfig = PLANS[plan];
    const discountAmount = Number(discount);

    if (isNaN(discountAmount) || discountAmount < 0) {
      return res.status(400).json({ success: false, error: 'Discount cannot be negative.' });
    }

    const finalPrice = planConfig.originalPrice - discountAmount;

    if (finalPrice <= 0) {
      return res.status(400).json({ success: false, error: 'Discount exceeds original price.' });
    }

    const baseUrl = process.env.CAMPAIGN_BASE_URL || 'https://www.flashfirejobs.com';
    const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60 * 60; // 5 hours from now

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'usd',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(finalPrice * 100),
            product_data: {
              name: planConfig.name,
              description: planConfig.description,
            },
          },
          quantity: 1,
        },
      ],
      expires_at: expiresAt,
      success_url: `${baseUrl}/payment-success`,
      cancel_url: `${baseUrl}/payment-cancelled`,
    });

    return res.json({
      success: true,
      url: session.url,
      sessionId: session.id,
      finalPrice,
      expiresAt: session.expires_at,
    });
  } catch (err) {
    console.error('[PaymentLinkController] Error:', err);
    return res.status(500).json({ success: false, error: 'Unable to connect to Stripe. Please try again.' });
  }
}
