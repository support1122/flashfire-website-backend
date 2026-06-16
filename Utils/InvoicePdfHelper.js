import PDFDocument from "pdfkit";

// ── Brand / theme tokens ──────────────────────────────────────────────
const BRAND = "#FF5722"; // FlashFire orange
const INK = "#1A1A2E"; // primary text
const MUTED = "#6B7280"; // secondary text
const FAINT = "#9CA3AF"; // tertiary / labels
const LINE = "#E5E7EB"; // dividers
const PANEL = "#F9FAFB"; // light panel fill
const SUCCESS_BG = "#ECFDF5";
const SUCCESS_TX = "#047857";

function formatCurrency(amount, currency = "USD") {
  const safe = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  const num = safe.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency.toUpperCase()} ${num}`;
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
  const fullPlanName = planSubtitle ? `${planName} — ${planSubtitle}` : planName;
  const amountText = formatCurrency(amount, currency);
  const paymentDateText = formatDate(paymentDate);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left; // 50
    const right = doc.page.width - doc.page.margins.right; // 545.28
    const contentW = right - left;

    // ── Header: brand (left) + amount paid hero (right) ───────────────
    const headerTop = 50;

    // Logo mark
    doc.roundedRect(left, headerTop, 42, 42, 9).fill(BRAND);
    doc
      .font("Helvetica-Bold")
      .fontSize(24)
      .fillColor("#FFFFFF")
      .text("F", left, headerTop + 8, { width: 42, align: "center" });

    // Brand name + tagline
    doc
      .font("Helvetica-Bold")
      .fontSize(18)
      .fillColor(INK)
      .text("FlashFire", left + 54, headerTop + 4);
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(MUTED)
      .text("flashfirejobs.com", left + 54, headerTop + 27);

    // Amount paid hero (right)
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(FAINT)
      .text("AMOUNT PAID", left, headerTop, {
        width: contentW,
        align: "right",
        characterSpacing: 1,
      });
    doc
      .font("Helvetica-Bold")
      .fontSize(26)
      .fillColor(INK)
      .text(amountText, left, headerTop + 12, { width: contentW, align: "right" });

    // PAID pill (right-aligned)
    const pillText = "PAID";
    doc.font("Helvetica-Bold").fontSize(8);
    const pillW = doc.widthOfString(pillText, { characterSpacing: 1 }) + 22;
    const pillH = 17;
    const pillX = right - pillW;
    const pillY = headerTop + 48;
    doc.roundedRect(pillX, pillY, pillW, pillH, 8).fill(SUCCESS_BG);
    doc
      .fillColor(SUCCESS_TX)
      .text(pillText, pillX, pillY + 5, {
        width: pillW,
        align: "center",
        characterSpacing: 1,
      });

    // ── Divider ───────────────────────────────────────────────────────
    let y = headerTop + 84;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(LINE).stroke();
    y += 22;

    // Small block helper: uppercase label + stacked value lines
    const block = (label, lines, x, by, w, align = "left") => {
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor(FAINT)
        .text(label.toUpperCase(), x, by, { width: w, align, characterSpacing: 0.8 });
      let yy = by + 15;
      lines.forEach((ln, i) => {
        doc
          .font(i === 0 ? "Helvetica-Bold" : "Helvetica")
          .fontSize(i === 0 ? 11 : 10)
          .fillColor(i === 0 ? INK : MUTED)
          .text(ln, x, yy, { width: w, align });
        yy += i === 0 ? 16 : 14;
      });
      return yy;
    };

    // ── Meta strip: invoice no. / date paid / payment method ──────────
    const col = contentW / 3;
    block("Invoice number", [invoiceId], left, y, col - 12);
    block("Date paid", [paymentDateText], left + col, y, col - 12);
    block("Payment method", [transactionProvider], left + col * 2, y, col);
    y += 50;

    // Transaction id (full width, mono)
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(FAINT)
      .text("TRANSACTION ID", left, y, { characterSpacing: 0.8 });
    doc
      .font("Courier")
      .fontSize(10)
      .fillColor(MUTED)
      .text(transactionId, left, y + 14, { width: contentW });
    y += 44;

    // ── Billed to / Billed from ───────────────────────────────────────
    const halfW = contentW / 2 - 10;
    const yTo = block("Billed to", [customerName, customerEmail], left, y, halfW);
    const yFrom = block(
      "Billed from",
      ["FlashFire", "support@flashfirehq.com", "flashfirejobs.com"],
      left + contentW / 2 + 10,
      y,
      halfW
    );
    y = Math.max(yTo, yFrom) + 18;

    // ── Summary table ─────────────────────────────────────────────────
    // Column geometry
    const cDesc = { x: left + 14, w: 230 };
    const cQty = { x: left + 250, w: 50 };
    const cUnit = { x: left + 300, w: 95 };
    const cAmt = { x: right - 130, w: 116 };

    // Header row
    const headH = 28;
    doc.rect(left, y, contentW, headH).fill(PANEL);
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
    const hLabel = (t, c, align) =>
      doc.text(t, c.x, y + 10, { width: c.w, align, characterSpacing: 0.8 });
    hLabel("DESCRIPTION", cDesc, "left");
    hLabel("QTY", cQty, "center");
    hLabel("UNIT PRICE", cUnit, "right");
    hLabel("AMOUNT", cAmt, "right");
    y += headH;

    // Line item
    const rowTop = y + 12;
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(planName, cDesc.x, rowTop, {
      width: cDesc.w,
    });
    let descBottom = doc.y;
    if (planSubtitle) {
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor(MUTED)
        .text(planSubtitle, cDesc.x, descBottom + 2, { width: cDesc.w });
      descBottom = doc.y;
    }
    doc.font("Helvetica").fontSize(11).fillColor(INK);
    doc.text("1", cQty.x, rowTop, { width: cQty.w, align: "center" });
    doc.text(amountText, cUnit.x, rowTop, { width: cUnit.w, align: "right" });
    doc.text(amountText, cAmt.x, rowTop, { width: cAmt.w, align: "right" });

    y = Math.max(descBottom, rowTop + 16) + 14;
    doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(LINE).stroke();
    y += 16;

    // ── Totals (right aligned) ────────────────────────────────────────
    const totalLabelX = right - 280;
    const totalLabelW = 150;
    const totalValX = right - 130;
    const totalValW = 116;
    const totalRow = (label, value, bold = false, accent = false) => {
      doc
        .font(bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(bold ? 11 : 10)
        .fillColor(bold ? INK : MUTED)
        .text(label, totalLabelX, y, { width: totalLabelW, align: "right" });
      doc
        .font("Helvetica-Bold")
        .fontSize(bold ? 13 : 10)
        .fillColor(accent ? SUCCESS_TX : bold ? INK : MUTED)
        .text(value, totalValX, y - (bold ? 2 : 0), { width: totalValW, align: "right" });
      y += bold ? 24 : 20;
    };
    totalRow("Subtotal", amountText);
    totalRow("Total", amountText);
    doc
      .moveTo(totalLabelX, y - 4)
      .lineTo(right, y - 4)
      .lineWidth(1)
      .strokeColor(LINE)
      .stroke();
    y += 6;
    totalRow("Amount paid", amountText, true, true);

    // ── Footer ────────────────────────────────────────────────────────
    const footY = doc.page.height - 112;
    doc
      .moveTo(left, footY)
      .lineTo(right, footY)
      .lineWidth(1)
      .strokeColor(LINE)
      .stroke();
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(INK)
      .text("Thank you for your business!", left, footY + 16, {
        width: contentW,
        align: "center",
      });
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        "Questions about this invoice? Contact support@flashfirehq.com",
        left,
        footY + 33,
        { width: contentW, align: "center" }
      );
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(FAINT)
      .text(
        `© ${new Date().getFullYear()} FlashFire. All rights reserved.`,
        left,
        footY + 50,
        { width: contentW, align: "center" }
      );

    doc.end();
  });
}
