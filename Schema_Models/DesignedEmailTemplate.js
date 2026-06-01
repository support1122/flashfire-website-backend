import mongoose from 'mongoose';

/**
 * In-dashboard designed email templates.
 * Unlike EmailTemplate (a pointer to a SendGrid Dynamic Template), this stores
 * the full content authored in the CRM: markdown source + rendered HTML.
 * Sent via sgMail.send({ html }) after per-recipient token substitution.
 */
const DesignedEmailTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, index: true },
    // Free-form category so the same builder can serve Meta leads, BDA, etc.
    category: { type: String, default: 'general', trim: true, index: true },

    subject: { type: String, required: true, trim: true },
    preheader: { type: String, default: '', trim: true }, // inbox preview line

    markdown: { type: String, default: '' }, // authoring source
    html: { type: String, default: '' }, // rendered + sanitized body HTML

    senderEmail: { type: String, default: null, trim: true },
    senderName: { type: String, default: null, trim: true },

    // Tokens detected in the content, e.g. ['name','schedulingLink'].
    variables: { type: [String], default: [] },

    // Optional follow-up workflow auto-triggered after this template is sent.
    attachedWorkflowId: { type: String, default: null, index: true },

    isActive: { type: Boolean, default: true },
    createdBy: { type: String, default: null }, // CRM user email
  },
  { timestamps: true }
);

DesignedEmailTemplateSchema.index({ name: 1, category: 1 });

export const DesignedEmailTemplateModel =
  mongoose.models.DesignedEmailTemplate ||
  mongoose.model('DesignedEmailTemplate', DesignedEmailTemplateSchema);
