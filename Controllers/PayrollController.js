import mongoose from 'mongoose';
import { PayrollModel } from '../Schema_Models/Payroll.js';
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { resolveBda } from '../Utils/BdaIdentity.js';
import { getAllBdaProfiles } from '../Utils/BdaRegistry.js';
import { buildTotals, getDeductionsMode } from '../Utils/deductionPolicy.js';

export const getPayroll = async (req, res) => {
  try {
    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, error: 'month query param required, format YYYY-MM' });
    }

    const records = await PayrollModel.find({ month }).sort({ employeeName: 1 });
    return res.status(200).json({ success: true, data: records });
  } catch (error) {
    console.error('Error fetching payroll:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to fetch payroll records' });
  }
};

export const createPayroll = async (req, res) => {
  try {
    const { month, employeeName, teamName, startDate, endDate, monthlySalary, incentive, deduction } = req.body;

    if (!month || !employeeName || !teamName) {
      return res.status(400).json({ success: false, error: 'month, employeeName, and teamName are required' });
    }

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, error: 'month must be in YYYY-MM format' });
    }

    const record = await PayrollModel.create({
      month,
      employeeName: employeeName.trim(),
      teamName: teamName.trim(),
      startDate: startDate || '',
      endDate: endDate || '',
      monthlySalary: monthlySalary !== undefined ? Number(monthlySalary) : 0,
      incentive: incentive !== undefined && incentive !== null ? Number(incentive) : null,
      deduction: deduction !== undefined && deduction !== null ? Number(deduction) : null,
    });

    return res.status(201).json({ success: true, data: record });
  } catch (error) {
    console.error('Error creating payroll record:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to create payroll record' });
  }
};

export const updatePayroll = async (req, res) => {
  try {
    const { id } = req.params;
    const { month, employeeName, teamName, startDate, endDate, monthlySalary, incentive, deduction, isPaid, leaves } = req.body;

    const record = await PayrollModel.findById(id);
    if (!record) {
      return res.status(404).json({ success: false, error: 'Payroll record not found' });
    }

    if (month !== undefined) record.month = month;
    if (employeeName !== undefined) record.employeeName = employeeName.trim();
    if (teamName !== undefined) record.teamName = teamName.trim();
    if (startDate !== undefined) record.startDate = startDate;
    if (endDate !== undefined) record.endDate = endDate;
    if (monthlySalary !== undefined) record.monthlySalary = Number(monthlySalary);
    if (incentive !== undefined) record.incentive = incentive !== null ? Number(incentive) : null;
    if (deduction !== undefined) record.deduction = deduction !== null ? Number(deduction) : null;
    if (isPaid !== undefined) record.isPaid = Boolean(isPaid);
    if (leaves !== undefined) record.leaves = Number(leaves) || 0;

    await record.save();

    return res.status(200).json({ success: true, data: record });
  } catch (error) {
    console.error('Error updating payroll record:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to update payroll record' });
  }
};

export const deletePayroll = async (req, res) => {
  try {
    const { id } = req.params;
    const record = await PayrollModel.findByIdAndDelete(id);
    if (!record) {
      return res.status(404).json({ success: false, error: 'Payroll record not found' });
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error deleting payroll record:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to delete payroll record' });
  }
};

/**
 * "Pull deductions" (plan 8.4): pre-fill Payroll.deduction with the BDA's ACTIVE deductions for the record's month and
 * keep the breakdown. Dry run by default: nothing is written unless the body says `apply: true`.
 * Body: { payrollId, bdaEmail?, apply? }. bdaEmail is only needed when the payroll employeeName does not resolve to
 * exactly one registry BDA. The admin can still edit the number afterwards through updatePayroll.
 */
export const pullDeductions = async (req, res) => {
  const fail = (status, code, message) => res.status(status).json({ success: false, error: { code, message } });
  try {
    const { payrollId, apply } = req.body || {};
    if (!payrollId || !mongoose.isValidObjectId(payrollId)) {
      return fail(400, 'invalid_payroll_id', 'payrollId must be a payroll record id');
    }
    const record = await PayrollModel.findById(payrollId);
    if (!record) return fail(404, 'payroll_not_found', 'Payroll record not found');

    let bdaEmail = String(req.body?.bdaEmail ?? '').trim().toLowerCase();
    if (!bdaEmail) {
      // Names are only a fallback: resolveBda refuses an ambiguous or unknown name, so it can never pick the wrong BDA.
      const hit = resolveBda({ name: record.employeeName }, await getAllBdaProfiles());
      bdaEmail = hit?.bda?.email || '';
    }
    if (!bdaEmail) {
      return fail(422, 'bda_not_resolved', `Could not match "${record.employeeName}" to one BDA, send bdaEmail`);
    }

    const rows = await BdaDeductionModel.find({ bdaEmail, month: record.month, status: { $in: ['active', 'needs_review'] } })
      .sort({ 'evidence.scheduledStart': 1 })
      .lean();
    const active = rows.filter((r) => r.status === 'active');
    const totals = buildTotals(active);
    const breakdown = {
      bdaEmail,
      month: record.month,
      totalInr: totals.activeAmountInr,
      pulledAt: new Date(),
      pulledBy: req.crmAdmin ? req.crmAdmin.email || 'admin' : req.crmUser?.email || null,
      byRule: totals.byRule,
      items: active.map((r) => ({
        deductionId: r.deductionId,
        rule: r.rule,
        bookingId: r.bookingId,
        clientName: r.evidence?.clientName ?? null,
        scheduledStart: r.evidence?.scheduledStart ?? null,
        tierIndex: r.tierIndex ?? null,
        amountInr: r.amountInr,
      })),
    };

    const previousDeduction = record.deduction;
    const applied = apply === true;
    if (applied) {
      record.deduction = breakdown.totalInr;
      record.deductionBreakdown = breakdown;
      await record.save();
    }
    return res.status(200).json({
      success: true,
      dryRun: !applied,
      applied,
      mode: getDeductionsMode(),
      payrollId: String(record._id),
      month: record.month,
      bdaEmail,
      previousDeduction,
      deduction: breakdown.totalInr,
      breakdown,
      underReview: rows.length - active.length, // needs_review rows are left out until an admin decides
    });
  } catch (error) {
    console.error('Error pulling deductions:', error);
    return fail(500, 'internal_error', 'Failed to pull deductions');
  }
};
