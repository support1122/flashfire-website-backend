import mongoose from 'mongoose';

const PayrollSchema = new mongoose.Schema(
  {
    month: { type: String, required: true }, // "YYYY-MM"
    employeeName: { type: String, required: true, trim: true },
    teamName: { type: String, required: true, trim: true },
    startDate: { type: String, default: '' },
    endDate: { type: String, default: '' },
    monthlySalary: { type: Number, default: 0 },
    incentive: { type: Number, default: null },
    deduction: { type: Number, default: null },
  },
  { timestamps: true }
);

export const PayrollModel = mongoose.models.Payroll || mongoose.model('Payroll', PayrollSchema);
