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
    // What "Pull deductions" put into `deduction` (plan 8.4). `deduction` stays freely editable after a pull.
    deductionBreakdown: {
      type: new mongoose.Schema(
        {
          bdaEmail: String,
          month: String,
          totalInr: Number,
          pulledAt: Date,
          pulledBy: String,
          byRule: mongoose.Schema.Types.Mixed, // { rule: { count, amountInr } }
          items: [
            {
              _id: false,
              deductionId: String,
              rule: String,
              bookingId: String,
              clientName: String,
              scheduledStart: Date,
              tierIndex: Number,
              amountInr: Number,
            },
          ],
        },
        { _id: false }
      ),
      default: null,
    },
    isPaid: { type: Boolean, default: false },
    leaves: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const PayrollModel = mongoose.models.Payroll || mongoose.model('Payroll', PayrollSchema);
