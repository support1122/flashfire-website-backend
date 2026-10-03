import { PayrollModel } from '../Schema_Models/Payroll.js';

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
