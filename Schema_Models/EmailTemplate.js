import mongoose from 'mongoose';

export const EmailTemplateSchema = new mongoose.Schema({
  templateId: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  templateName: {
    type: String,
    required: true,
    trim: true
  },
  domainName: {
    type: String,
    required: true,
    trim: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Ensure unique combination of templateId and domainName
EmailTemplateSchema.index({ templateId: 1, domainName: 1 }, { unique: true });

export const EmailTemplateModel = mongoose.model('EmailTemplate', EmailTemplateSchema);

