// models/Employer.ts
import mongoose from 'mongoose';

// Align schema with fields sent from the frontend Employer form
const EmployerSchema = new mongoose.Schema({
  companyName: { type: String },
  contactName: { type: String },
  email: { type: String },
  phone: { type: String },
  companySize: { type: String },
  industry: { type: String },
  location: { type: String },
  jobTitle: { type: String },
  jobDescription: { type: String },
  salaryRange: { type: String },
  urgency: { type: String },
  hiringNeeds: { type: String }
}, { timestamps: true });

export const EmployerModel = mongoose.model('EmployerForm', EmployerSchema);
