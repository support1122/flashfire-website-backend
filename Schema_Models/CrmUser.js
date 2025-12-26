import mongoose from 'mongoose';

const CRM_PERMISSION_KEYS = [
  'email_campaign',
  'campaign_manager',
  'whatsapp_campaign',
  'analytics',
  'all_data',
  'workflows',
  'leads',
];

const CrmUserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    permissions: {
      type: [String],
      default: [],
      validate: {
        validator: function (perms) {
          return Array.isArray(perms) && perms.every((p) => CRM_PERMISSION_KEYS.includes(p));
        },
        message: 'Invalid permission key in permissions array',
      },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

export const CrmUserModel = mongoose.models.CrmUser || mongoose.model('CrmUser', CrmUserSchema);
export const CRM_PERMISSION_KEYS_ALLOWED = CRM_PERMISSION_KEYS;


