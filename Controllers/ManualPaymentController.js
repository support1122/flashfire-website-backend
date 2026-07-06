import { ManualPaymentModel } from "../Schema_Models/ManualPaymentModel.js";

function toRow(doc) {
  return {
    id: String(doc._id),
    date: doc.date.toISOString(),
    amount: doc.amount,
    currency: doc.currency,
    email: doc.customerEmail,
    name: doc.customerName,
    planName: doc.planName,
    paymentMethod: doc.paymentMethod,
    referenceId: doc.referenceId || "",
    notes: doc.notes || "",
    manual: true,
  };
}

export const getManualPaymentsByMonth = async (req, res) => {
  try {
    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, error: "month query param required, format YYYY-MM" });
    }

    const [year, mon] = month.split("-").map(Number);
    const start = new Date(Date.UTC(year, mon - 1, 1));
    const end = new Date(Date.UTC(year, mon, 1));

    const docs = await ManualPaymentModel.find({ date: { $gte: start, $lt: end } }).sort({ date: 1 });
    const rows = docs.map(toRow);

    return res.status(200).json({ success: true, data: { month, rows } });
  } catch (error) {
    console.error("Error fetching manual payments:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to fetch manual payments" });
  }
};

export const createManualPayment = async (req, res) => {
  try {
    const { date, amount, customerName, customerEmail, planName, paymentMethod, referenceId, notes } = req.body;
    if (!date || amount === undefined || !customerName || !customerEmail || !planName || !paymentMethod) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const doc = await ManualPaymentModel.create({
      date: new Date(date),
      amount: Number(amount),
      currency: "INR",
      customerName,
      customerEmail,
      planName,
      paymentMethod,
      referenceId,
      notes,
      createdBy: req.crmUser?.email || "",
    });

    return res.status(201).json({ success: true, data: toRow(doc) });
  } catch (error) {
    console.error("Error creating manual payment:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to create manual payment" });
  }
};

export const updateManualPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { date, amount, customerName, customerEmail, planName, paymentMethod, referenceId, notes } = req.body;

    const doc = await ManualPaymentModel.findById(id);
    if (!doc) return res.status(404).json({ success: false, error: "Manual payment not found" });

    if (date !== undefined) doc.date = new Date(date);
    if (amount !== undefined) doc.amount = Number(amount);
    if (customerName !== undefined) doc.customerName = customerName;
    if (customerEmail !== undefined) doc.customerEmail = customerEmail;
    if (planName !== undefined) doc.planName = planName;
    if (paymentMethod !== undefined) doc.paymentMethod = paymentMethod;
    if (referenceId !== undefined) doc.referenceId = referenceId;
    if (notes !== undefined) doc.notes = notes;

    await doc.save();

    return res.status(200).json({ success: true, data: toRow(doc) });
  } catch (error) {
    console.error("Error updating manual payment:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to update manual payment" });
  }
};

export const deleteManualPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await ManualPaymentModel.findByIdAndDelete(id);
    if (!doc) return res.status(404).json({ success: false, error: "Manual payment not found" });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error deleting manual payment:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to delete manual payment" });
  }
};
