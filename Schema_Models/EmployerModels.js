// models/Employer.ts
import mongoose from 'mongoose';

const EmployerSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  email: String,
  companyName: String,
  employeeCount: String,
  locations: String,
  hiresCount: String,
  heardAbout: [String],
  additionalDetails: String,
}, { timestamps: true });

export const EmployerModel = mongoose.model('EmployerForm', EmployerSchema);
