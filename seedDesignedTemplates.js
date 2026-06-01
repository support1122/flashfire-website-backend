/**
 * Seed the 6 Flashfire consultation follow-up templates into
 * DesignedEmailTemplate. Idempotent: upserts by (name, category).
 *
 * Run:  node seedDesignedTemplates.js
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { DesignedEmailTemplateModel } from './Schema_Models/DesignedEmailTemplate.js';

dotenv.config();

// Real production booking page — used literally so links never break.
const BOOK = process.env.CALENDLY_SCHEDULING_LINK || process.env.SCHEDULING_LINK || 'https://calendly.com/flashfirejobs';

const MEET_MD = `[Meeting Link](${BOOK})`;
const MEET_HTML =
  `<a href="${BOOK}" target="_blank" rel="noopener" style="color:#ea580c;font-weight:700;text-decoration:underline;">Meeting Link</a>`;

const SIG = ['Regards,', 'Onboarding Team,', 'Flashfire'];

/**
 * A block is either:
 *   { p: 'text' }            -> paragraph (use {{MEET}} for the link)
 *   { list: ['a','b'] }      -> bullet list
 *   { sig: true }            -> signature
 */
function renderMarkdown(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.sig) out.push(SIG.join('  \n'));
    else if (b.cta) out.push(`[${b.cta}](${BOOK})`);
    else if (b.list) out.push(b.list.map((i) => `- ${i}`).join('\n'));
    else out.push(b.p.replaceAll('{{MEET}}', MEET_MD));
  }
  return out.join('\n\n');
}

function renderHtml(blocks) {
  const esc = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s).replaceAll('{{MEET}}', MEET_HTML);
  const P = (html) =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#1e293b;">${html}</p>`;
  const out = [];
  for (const b of blocks) {
    if (b.sig) {
      out.push(P(SIG.map(esc).join('<br/>')));
    } else if (b.cta) {
      out.push(
        `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;"><tr><td style="border-radius:10px;background:#ff5722;box-shadow:0 4px 10px rgba(255,87,34,0.30);">` +
          `<a href="${BOOK}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 30px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">` +
          `${esc(b.cta)} &rarr;</a></td></tr></table>`
      );
    } else if (b.list) {
      const lis = b.list
        .map(
          (i) =>
            `<li style="margin:0 0 6px;">${inline(i)}</li>`
        )
        .join('');
      out.push(
        `<ul style="margin:0 0 16px;padding-left:22px;color:#1e293b;font-size:15px;line-height:1.6;">${lis}</ul>`
      );
    } else {
      out.push(P(inline(b.p)));
    }
  }
  return out.join('\n');
}

const TEMPLATES = [
  {
    name: 'Consultation — Next Step',
    subject: 'Your Flashfire request — next step',
    preheader: 'Schedule your consultation and see how we manage your job search',
    blocks: [
      { p: 'Hi there,' },
      { p: 'Thank you for submitting your details to Flashfire.' },
      { p: 'The next step is to schedule a short consultation with our team.' },
      {
        p: 'In this call, we understand your target roles, preferred locations, experience, and current job search challenges. We also explain how the process works, including resume optimization, LinkedIn support, job filtering, and application tracking.',
      },
      { p: 'Many candidates come to us after spending weeks applying without a clear system.' },
      { p: 'Flashfire was built to make that process more structured and easier to manage.' },
      { p: 'You can choose a convenient time here:' },
      { cta: 'Schedule Your Consultation' },
      { p: 'If you face any issue while booking, just reply to this email and our team will help.' },
      { sig: true },
    ],
  },
  {
    name: 'Consultation — Reminder',
    subject: 'Reminder to schedule your consultation',
    preheader: 'This call helps us understand your target roles and job search goals',
    blocks: [
      { p: 'Hi there,' },
      { p: 'Just following up on your request.' },
      {
        p: 'Your consultation is still pending, and booking the call will help us understand whether Flashfire is the right fit for your job search goals.',
      },
      { p: 'During the call, we will walk you through:' },
      {
        list: [
          'how roles are filtered based on your preferences',
          'how resumes are optimized for relevant openings',
          'how the application tracker works',
          'what kind of support you can expect from our team',
        ],
      },
      {
        p: 'We have already supported 600+ job seekers through a more structured application process, and many users tell us that the biggest value is saving time and having clarity during the search.',
      },
      { p: 'You can schedule your consultation here:' },
      { cta: 'Schedule Your Consultation' },
      { p: 'If you want, you can also reply with your preferred time window and our team can assist.' },
      { sig: true },
    ],
  },
  {
    name: 'Value — 300,000+ Applications',
    subject: 'How Flashfire helped process 300,000+ applications',
    preheader: 'See how our system helps candidates structure their job search',
    blocks: [
      { p: 'Hi there,' },
      {
        p: 'I wanted to share a little more context in case you are still deciding whether to schedule the consultation.',
      },
      {
        p: 'Flashfire is designed for candidates who want a more structured job search process. Instead of handling everything alone, candidates get support with:',
      },
      {
        list: [
          'resume optimization based on target roles',
          'LinkedIn profile improvement',
          'job filtering based on role, location, and pay preferences',
          'application tracking in one place',
        ],
      },
      {
        p: 'Our team has processed more than 300,000 applications across users, which has helped us build a repeatable workflow around targeting, tailoring, and tracking.',
      },
      {
        p: 'The consultation is simply the best place to see whether this process matches what you need right now.',
      },
      { p: 'You can book your consultation here:' },
      { cta: 'Book Your Consultation' },
      { p: 'If now is not the right time, no problem. You can always reply later.' },
      { sig: true },
    ],
  },
  {
    name: 'Story — Recent Candidate',
    subject: 'A quick story from a recent candidate',
    preheader: 'How structured applications helped them start getting interviews',
    blocks: [
      { p: 'Hi there,' },
      {
        p: 'A lot of people who reach out to us are doing many things right already. They have strong backgrounds, but the process becomes exhausting after repeated applications, low response rates, and constant uncertainty.',
      },
      {
        p: 'One of the biggest shifts candidates mention after joining Flashfire is that they finally stop guessing. They know which roles are being targeted, how their resume is being adapted, and how progress is being tracked.',
      },
      {
        p: 'Several users have shared that they started seeing interview movement within the first few weeks once their search became more consistent and better organized.',
      },
      {
        p: 'If you would like to understand how this would work for your profile, you can schedule a consultation here:',
      },
      { cta: 'Schedule a Consultation' },
      { p: 'If you have any questions before booking, just reply to this email.' },
      { sig: true },
    ],
  },
  {
    name: 'FAQ — Before Getting Started',
    subject: 'What candidates usually want to know before getting started',
    preheader: 'Answers about time saved, tracking, and how Flashfire works',
    blocks: [
      { p: 'Hi there,' },
      { p: 'Before booking, most candidates usually ask us a few practical questions:' },
      { p: 'How is Flashfire different from applying on my own?' },
      {
        p: 'The biggest difference is structure. Our team helps organize the search through role-based targeting, resume support, LinkedIn optimization, and a visible tracker.',
      },
      { p: 'Will I be able to see what is happening?' },
      {
        p: 'Yes. Candidates can track applications and stay updated on progress instead of wondering what has been done.',
      },
      { p: 'Does this save time?' },
      {
        p: 'For many users, yes. A major reason people reach out to us is because managing dozens of applications manually every week becomes difficult to sustain.',
      },
      {
        p: 'You may have also seen some of our candidate outcomes on the site, including users who received interviews and offers across different roles and industries. The consultation is where we explain what is realistic for your background and how the workflow is set up.',
      },
      { p: 'If you would still like to explore it, you can book here:' },
      { cta: 'Book Your Consultation' },
      { sig: true },
    ],
  },
  {
    name: 'Final Follow-up',
    subject: 'Final follow-up on your Flashfire request',
    preheader: "You can still schedule your consultation if you're interested",
    blocks: [
      { p: 'Hi there,' },
      {
        p: 'This is my final follow-up regarding your consultation request. If you are still considering support for your job search, you can schedule a time here:',
      },
      { cta: 'Schedule a Time' },
      {
        p: 'If your plans have changed, that is completely fine and no action is needed from your side.',
      },
      {
        p: 'Thank you again for your interest in Flashfire, and I wish you the very best with your search.',
      },
      { sig: true },
    ],
  },
];

function extractVariables(text = '') {
  const set = new Set();
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) set.add(m[1]);
  return [...set];
}

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI missing in .env');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected. Seeding', TEMPLATES.length, 'templates...');

  for (const t of TEMPLATES) {
    const markdown = renderMarkdown(t.blocks);
    const html = renderHtml(t.blocks);
    const variables = extractVariables(`${t.subject} ${markdown} ${html}`);
    const doc = {
      name: t.name,
      category: 'meta_leads',
      subject: t.subject,
      preheader: t.preheader,
      markdown,
      html,
      senderEmail: null,
      senderName: null,
      variables,
      attachedWorkflowId: null,
      isActive: true,
      createdBy: 'system:seed',
    };
    const saved = await DesignedEmailTemplateModel.findOneAndUpdate(
      { name: t.name, category: 'meta_leads' },
      { $set: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log('  ✓', saved.name, '→', saved._id.toString());
  }

  await mongoose.disconnect();
  console.log('Done.');
  process.exit(0);
}

run().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
