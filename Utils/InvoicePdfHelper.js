import PDFDocument from "pdfkit";

function formatCurrency(amount, currency = "USD") {
  const safeAmount = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  return `${currency.toUpperCase()} ${safeAmount.toFixed(2)}`;
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return new Date().toISOString();
  }
}

export async function generateInvoicePdfBuffer(invoiceData = {}) {
  const {
    invoiceNumber,
    customerName = "Customer",
    customerEmail = "N/A",
    planName = "Plan",
    planSubtitle = "",
    amount = 0,
    currency = "USD",
    paymentDate = new Date(),
    transactionId = "N/A",
    transactionProvider = "Stripe",
    status = "Completed",
  } = invoiceData;

  const invoiceId = invoiceNumber || `INV-${Date.now()}`;
  const fullPlanName = planSubtitle ? `${planName} - ${planSubtitle}` : planName;
  const amountText = formatCurrency(amount, currency);
  const paymentDateText = formatDate(paymentDate);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fillColor("#111827").fontSize(26).text("FlashFire Invoice", { align: "left" });
    doc.moveDown(0.35);
    doc.fontSize(10).fillColor("#6b7280").text("flashfirejobs.com");
    doc.moveDown(1);

    doc.fontSize(11).fillColor("#111827");
    doc.text(`Invoice Number: ${invoiceId}`);
    doc.text(`Date: ${paymentDateText}`);
    doc.text(`Payment Provider: ${transactionProvider}`);
    doc.text(`Transaction ID: ${transactionId}`);
    doc.moveDown(1);

    doc.fontSize(12).fillColor("#111827").text("Bill To", { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(11).fillColor("#1f2937").text(customerName);
    doc.text(customerEmail);
    doc.moveDown(1.2);

    doc.fontSize(12).fillColor("#111827").text("Invoice Details", { underline: true });
    doc.moveDown(0.6);
    doc.fontSize(11).fillColor("#1f2937");
    doc.text(`Plan: ${fullPlanName}`);
    doc.text(`Amount Paid: ${amountText}`);
    doc.text(`Status: ${status}`);
    doc.moveDown(1.5);

    doc.fontSize(10).fillColor("#6b7280");
    doc.text("Thank you for your payment.", { align: "left" });
    doc.text("For support: support@flashfirehq.com", { align: "left" });

    doc.end();
  });
}
