import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PLANS = {
  professional: {
    name: 'FlashFire – Professional Plan',
    description: [
      '✦ 500 Job Applications – We find & apply to jobs for you',
      '✦ No Time Constraint – Until your applications are completed',
      '✦ LinkedIn Makeover – Let recruiters come to you',
      '✦ Interview Prep Material – Resources to help you ace interviews',
      '✦ Everything in Ignite Plan included',
      '',
      'Once your payment is confirmed, you will receive an official invoice via email. Our team will initiate the onboarding process within 24 hours.',
    ].join('\n'),
    originalPrice: 349,
  },
  executive: {
    name: 'FlashFire – Executive Plan',
    description: [
      '✦ 1200 Job Applications – We find & apply to jobs for you',
      '✦ Everything in Professional Plan included',
      '✦ 1 Cover Letter – Personalized for all applications',
      '✦ Emailing Recruiters – We personally reach out to recruiters for you',
      '✦ Portfolio Website – We build a personal site to showcase your projects, skills & achievements',
      '',
      'Once your payment is confirmed, you will receive an official invoice via email. Our team will initiate the onboarding process within 24 hours.',
    ].join('\n'),
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
    const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60 * 60;

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
