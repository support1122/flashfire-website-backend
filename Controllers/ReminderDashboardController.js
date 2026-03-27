import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { ScheduledCallModel } from '../Schema_Models/ScheduledCall.js';
import { ScheduledWhatsAppReminderModel } from '../Schema_Models/ScheduledWhatsAppReminder.js';
import { ScheduledDiscordMeetReminderModel } from '../Schema_Models/ScheduledDiscordMeetReminder.js';
import { ReminderErrorModel } from '../Schema_Models/ReminderError.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';

// ─── API: Search all reminder data for a client ───
export async function searchClientReminders(req, res) {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ success: false, error: 'Query must be at least 2 characters' });
    }

    const query = q.trim();
    const phoneDigits = query.replace(/\D/g, '');

    // Build booking search conditions
    const bookingConditions = [
      { clientName: { $regex: query, $options: 'i' } },
      { clientEmail: { $regex: query, $options: 'i' } },
    ];
    if (phoneDigits.length >= 7) {
      bookingConditions.push({ clientPhone: { $regex: phoneDigits } });
    }

    // 1. Find bookings
    const bookings = await CampaignBookingModel.find({ $or: bookingConditions })
      .sort({ bookingCreatedAt: -1 })
      .limit(10)
      .lean();

    if (bookings.length === 0) {
      return res.json({ success: true, bookings: [], calls: [], whatsapp: [], discord: [], bda: [], errors: [] });
    }

    // Collect identifiers
    const emails = [...new Set(bookings.map(b => b.clientEmail).filter(Boolean))];
    const phones = [...new Set(bookings.map(b => b.clientPhone).filter(Boolean))];
    const bookingIds = bookings.map(b => b.bookingId);
    const phoneRegexes = phones.map(p => {
      const digits = p.replace(/\D/g, '');
      return digits.length >= 7 ? digits.slice(-10) : null;
    }).filter(Boolean);

    // Build phone conditions for each collection
    const phoneOr = phoneRegexes.map(d => ({ phoneNumber: { $regex: d } }));
    const emailOr = emails.map(e => ({ inviteeEmail: e }));

    // 2. Parallel queries
    const [calls, whatsapp, discord, bda, errors] = await Promise.all([
      // Calls
      ScheduledCallModel.find({
        $or: [...emailOr, ...phoneOr].length > 0 ? [...emailOr, ...phoneOr] : [{ _id: null }]
      }).sort({ scheduledFor: -1 }).limit(50).lean(),

      // WhatsApp (uses phoneNumber + clientEmail fields)
      ScheduledWhatsAppReminderModel.find({
        $or: [...phoneOr, ...emails.map(e => ({ clientEmail: e }))].length > 0
          ? [...phoneOr, ...emails.map(e => ({ clientEmail: e }))]
          : [{ _id: null }]
      }).sort({ scheduledFor: -1 }).limit(50).lean(),

      // Discord
      ScheduledDiscordMeetReminderModel.find({
        $or: [
          ...emails.map(e => ({ clientEmail: e })),
          ...bookingIds.map(id => ({ bookingId: id })),
        ]
      }).sort({ scheduledFor: -1 }).limit(50).lean(),

      // BDA Attendance
      BdaAttendanceModel.find({
        bookingId: { $in: bookingIds }
      }).sort({ joinedAt: -1 }).limit(50).lean(),

      // Errors
      ReminderErrorModel.find({
        $or: [
          ...emails.map(e => ({ clientEmail: e })),
          ...bookingIds.map(id => ({ bookingId: id })),
        ]
      }).sort({ createdAt: -1 }).limit(50).lean(),
    ]);

    res.json({ success: true, bookings, calls, whatsapp, discord, bda, errors });
  } catch (error) {
    console.error('[ReminderDashboard] Search error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ─── API: Get recent errors ───
export async function getRecentErrors(req, res) {
  try {
    const { page = 1, limit = 30, category, severity } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (severity) filter.severity = severity;

    const [errors, total] = await Promise.all([
      ReminderErrorModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit))
        .lean(),
      ReminderErrorModel.countDocuments(filter),
    ]);

    res.json({ success: true, errors, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

// ─── HTML: Render dashboard ───
export function renderReminderDashboard(req, res) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reminder Dashboard — FlashFire</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#f8fafc;--surface:#fff;--border:#e2e8f0;--text:#0f172a;--text2:#475569;--text3:#94a3b8;
    --blue:#3b82f6;--blue-bg:#eff6ff;--green:#16a34a;--green-bg:#f0fdf4;
    --red:#dc2626;--red-bg:#fef2f2;--amber:#d97706;--amber-bg:#fffbeb;
    --gray:#6b7280;--gray-bg:#f3f4f6;--purple:#7c3aed;--purple-bg:#f5f3ff;
    --radius:8px;--shadow:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.04);
  }
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;min-height:100vh}
  .container{max-width:1280px;margin:0 auto;padding:24px 20px}
  h1{font-size:22px;font-weight:700;color:var(--text)}
  .header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px;flex-wrap:wrap}
  .header-left{display:flex;align-items:center;gap:12px}
  .badge{display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600}
  .badge-blue{background:var(--blue-bg);color:var(--blue)}

  /* Search */
  .search-box{position:relative;width:100%;max-width:560px}
  .search-box input{width:100%;padding:10px 16px 10px 40px;border:1.5px solid var(--border);border-radius:var(--radius);font-size:15px;background:var(--surface);transition:border .15s}
  .search-box input:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(59,130,246,.12)}
  .search-box svg{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text3)}
  .search-box .spinner{position:absolute;right:12px;top:50%;transform:translateY(-50%);width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--blue);border-radius:50%;animation:spin .6s linear infinite;display:none}
  @keyframes spin{to{transform:translateY(-50%) rotate(360deg)}}

  /* Tabs */
  .tabs{display:flex;gap:4px;margin-bottom:20px;border-bottom:1px solid var(--border);padding-bottom:0;overflow-x:auto}
  .tab{padding:8px 16px;font-size:13px;font-weight:600;color:var(--text2);cursor:pointer;border:none;background:none;border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap}
  .tab:hover{color:var(--text)}
  .tab.active{color:var(--blue);border-bottom-color:var(--blue)}
  .tab .count{margin-left:6px;padding:1px 7px;border-radius:10px;font-size:11px;background:var(--gray-bg);color:var(--text2)}
  .tab.active .count{background:var(--blue-bg);color:var(--blue)}

  /* Cards */
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden}
  .card-header{padding:14px 18px;border-bottom:1px solid var(--border);font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}
  .card-body{padding:18px}

  /* Booking Card */
  .booking-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
  .booking-field{display:flex;flex-direction:column;gap:2px}
  .booking-field .label{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);font-weight:600}
  .booking-field .value{font-size:14px;color:var(--text);word-break:break-all}

  /* Status pills */
  .status{display:inline-flex;align-items:center;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600;text-transform:capitalize}
  .status-pending{background:var(--amber-bg);color:var(--amber)}
  .status-processing{background:var(--blue-bg);color:var(--blue)}
  .status-completed{background:var(--green-bg);color:var(--green)}
  .status-failed{background:var(--red-bg);color:var(--red)}
  .status-cancelled,.status-canceled{background:var(--gray-bg);color:var(--gray)}
  .status-scheduled{background:var(--blue-bg);color:var(--blue)}
  .status-no-show{background:var(--red-bg);color:var(--red)}
  .status-paid{background:var(--green-bg);color:var(--green)}
  .status-rescheduled{background:var(--purple-bg);color:var(--purple)}
  .status-present{background:var(--green-bg);color:var(--green)}
  .status-absent{background:var(--red-bg);color:var(--red)}

  /* Table */
  .table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);font-weight:600;border-bottom:1px solid var(--border);white-space:nowrap}
  td{padding:10px 14px;border-bottom:1px solid var(--border);vertical-align:top;color:var(--text2)}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#f8fafc}
  .mono{font-family:'SF Mono',SFMono-Regular,Consolas,monospace;font-size:12px}
  .truncate{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .error-msg{color:var(--red);font-size:12px;margin-top:2px}

  /* Empty state */
  .empty{padding:48px 20px;text-align:center;color:var(--text3)}
  .empty svg{margin-bottom:12px;opacity:.4}
  .empty p{font-size:14px}

  /* Error severity */
  .severity-critical{background:#991b1b;color:#fff}
  .severity-error{background:var(--red-bg);color:var(--red)}
  .severity-warning{background:var(--amber-bg);color:var(--amber)}
  .severity-info{background:var(--blue-bg);color:var(--blue)}

  /* Tabs content */
  .tab-content{display:none}
  .tab-content.active{display:block}

  /* Stats row */
  .stats-row{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
  .stat{display:flex;align-items:center;gap:6px;padding:6px 14px;border-radius:var(--radius);border:1px solid var(--border);background:var(--surface);font-size:13px}
  .stat .num{font-weight:700;font-size:16px}

  /* Responsive */
  @media(max-width:640px){
    .booking-grid{grid-template-columns:1fr}
    .header{flex-direction:column;align-items:flex-start}
    .search-box{max-width:100%}
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="header-left">
      <h1>Reminder Dashboard</h1>
      <span class="badge badge-blue">FlashFire Admin</span>
    </div>
    <div class="search-box">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <input type="text" id="searchInput" placeholder="Search by name, email, or phone..." autofocus>
      <div class="spinner" id="spinner"></div>
    </div>
  </div>

  <div id="initialState" class="empty">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
    <p>Search for a client by name, email, or phone number</p>
  </div>

  <div id="noResults" class="empty" style="display:none">
    <p>No bookings found for this search</p>
  </div>

  <div id="results" style="display:none">
    <!-- Booking cards -->
    <div id="bookingCards" style="margin-bottom:20px"></div>

    <!-- Tabs -->
    <div class="tabs" id="tabsBar">
      <button class="tab active" data-tab="calls">Calls <span class="count" id="callCount">0</span></button>
      <button class="tab" data-tab="whatsapp">WhatsApp <span class="count" id="waCount">0</span></button>
      <button class="tab" data-tab="discord">Discord <span class="count" id="discordCount">0</span></button>
      <button class="tab" data-tab="bda">BDA Attendance <span class="count" id="bdaCount">0</span></button>
      <button class="tab" data-tab="errors">Errors <span class="count" id="errorCount">0</span></button>
    </div>

    <!-- Calls Tab -->
    <div class="tab-content active" id="tab-calls">
      <div class="card">
        <div class="card-header">Scheduled Calls</div>
        <div class="table-wrap"><table>
          <thead><tr><th>Call ID</th><th>Phone</th><th>Scheduled For</th><th>Meeting Time</th><th>Status</th><th>Attempts</th><th>Error</th></tr></thead>
          <tbody id="callsBody"></tbody>
        </table></div>
      </div>
    </div>

    <!-- WhatsApp Tab -->
    <div class="tab-content" id="tab-whatsapp">
      <div class="card">
        <div class="card-header">WhatsApp Reminders</div>
        <div class="table-wrap"><table>
          <thead><tr><th>Reminder ID</th><th>Phone</th><th>Type</th><th>Scheduled For</th><th>Status</th><th>Error</th></tr></thead>
          <tbody id="waBody"></tbody>
        </table></div>
      </div>
    </div>

    <!-- Discord Tab -->
    <div class="tab-content" id="tab-discord">
      <div class="card">
        <div class="card-header">Discord Meet Reminders</div>
        <div class="table-wrap"><table>
          <thead><tr><th>Reminder ID</th><th>Client</th><th>Meeting Start</th><th>Scheduled For</th><th>Status</th><th>Error</th></tr></thead>
          <tbody id="discordBody"></tbody>
        </table></div>
      </div>
    </div>

    <!-- BDA Tab -->
    <div class="tab-content" id="tab-bda">
      <div class="card">
        <div class="card-header">BDA Attendance</div>
        <div class="table-wrap"><table>
          <thead><tr><th>BDA Email</th><th>Booking ID</th><th>Status</th><th>Joined At</th><th>Left At</th><th>Duration</th></tr></thead>
          <tbody id="bdaBody"></tbody>
        </table></div>
      </div>
    </div>

    <!-- Errors Tab -->
    <div class="tab-content" id="tab-errors">
      <div class="card">
        <div class="card-header">Reminder Errors</div>
        <div class="table-wrap"><table>
          <thead><tr><th>Time</th><th>Category</th><th>Severity</th><th>Message</th><th>Source</th><th>Booking</th></tr></thead>
          <tbody id="errorsBody"></tbody>
        </table></div>
      </div>
    </div>
  </div>
</div>

<script>
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
let debounceTimer;

// Tab switching
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    $('#tab-' + tab.dataset.tab).classList.add('active');
  });
});

// Search
$('#searchInput').addEventListener('input', e => {
  clearTimeout(debounceTimer);
  const q = e.target.value.trim();
  if (q.length < 2) {
    $('#results').style.display = 'none';
    $('#noResults').style.display = 'none';
    $('#initialState').style.display = '';
    return;
  }
  debounceTimer = setTimeout(() => search(q), 400);
});

async function search(q) {
  $('#spinner').style.display = 'block';
  $('#initialState').style.display = 'none';
  try {
    const res = await fetch('/api/admin/reminders/search?q=' + encodeURIComponent(q));
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    render(data);
  } catch (err) {
    console.error(err);
    $('#noResults').querySelector('p').textContent = 'Error: ' + err.message;
    $('#noResults').style.display = '';
    $('#results').style.display = 'none';
  } finally {
    $('#spinner').style.display = 'none';
  }
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function fmtDuration(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return h + 'h ' + (m % 60) + 'm';
  if (m > 0) return m + 'm ' + (s % 60) + 's';
  return s + 's';
}

function statusPill(s) {
  if (!s) return '<span class="status status-pending">unknown</span>';
  const cls = 'status-' + s.replace(/[^a-z0-9-]/gi, '').toLowerCase();
  return '<span class="status ' + cls + '">' + s + '</span>';
}

function severityPill(s) {
  return '<span class="status severity-' + s + '">' + s + '</span>';
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function extractReminderType(reminderId) {
  if (!reminderId) return '—';
  if (reminderId.includes('immediate')) return 'Immediate';
  if (reminderId.includes('3h')) return '3h Before';
  if (reminderId.includes('5min')) return '5min Before';
  if (reminderId.includes('2h')) return '2h Before';
  if (reminderId.includes('24h')) return '24h Before';
  return 'Custom';
}

function render(data) {
  const { bookings, calls, whatsapp, discord, bda, errors } = data;

  if (bookings.length === 0) {
    $('#results').style.display = 'none';
    $('#noResults').style.display = '';
    $('#noResults').querySelector('p').textContent = 'No bookings found for this search';
    return;
  }

  $('#noResults').style.display = 'none';
  $('#results').style.display = '';

  // Update counts
  $('#callCount').textContent = calls.length;
  $('#waCount').textContent = whatsapp.length;
  $('#discordCount').textContent = discord.length;
  $('#bdaCount').textContent = bda.length;
  $('#errorCount').textContent = errors.length;

  // Booking cards
  let cardsHtml = '';
  bookings.forEach(b => {
    cardsHtml += '<div class="card" style="margin-bottom:12px"><div class="card-header">' +
      esc(b.clientName || 'Unknown') + ' &mdash; ' + statusPill(b.bookingStatus) +
      '</div><div class="card-body"><div class="booking-grid">' +
      field('Booking ID', b.bookingId) +
      field('Email', b.clientEmail) +
      field('Phone', b.clientPhone) +
      field('Meeting', fmtDate(b.scheduledEventStartTime)) +
      field('Timezone', b.inviteeTimezone) +
      field('Lead Source', b.leadSource || b.utmSource) +
      field('Google Meet', b.googleMeetUrl || b.calendlyMeetLink || '—') +
      field('Created', fmtDate(b.bookingCreatedAt)) +
      field('Claimed By', b.claimedBy?.name || b.claimedBy?.email || 'Not claimed') +
      field('Payment Plan', b.paymentPlan?.name || 'None') +
      field('Status Changed At', fmtDate(b.statusChangedAt)) +
      field('Changed By', (b.statusChangeSource || '—') + (b.statusChangedBy ? ' (' + b.statusChangedBy + ')' : '')) +
      (b.statusChangedAt && b.scheduledEventStartTime && new Date(b.statusChangedAt) < new Date(b.scheduledEventStartTime)
        ? '<div class="booking-field"><span class="label">Warning</span><span class="value" style="color:var(--red);font-weight:600">Status changed BEFORE meeting time</span></div>'
        : '') +
      '</div></div></div>';
  });
  $('#bookingCards').innerHTML = cardsHtml;

  // Calls table
  let callsHtml = '';
  if (calls.length === 0) callsHtml = '<tr><td colspan="7" class="empty" style="padding:32px"><p>No scheduled calls found</p></td></tr>';
  else calls.forEach(c => {
    callsHtml += '<tr>' +
      '<td class="mono truncate">' + esc(c.callId) + '</td>' +
      '<td>' + esc(c.phoneNumber) + '</td>' +
      '<td>' + fmtDate(c.scheduledFor) + '</td>' +
      '<td>' + fmtDate(c.meetingStartISO) + '</td>' +
      '<td>' + statusPill(c.status) + '</td>' +
      '<td>' + (c.attempts || 0) + '</td>' +
      '<td class="error-msg">' + esc(c.errorMessage || c.cancelReason || '') + '</td>' +
      '</tr>';
  });
  $('#callsBody').innerHTML = callsHtml;

  // WhatsApp table
  let waHtml = '';
  if (whatsapp.length === 0) waHtml = '<tr><td colspan="6" class="empty" style="padding:32px"><p>No WhatsApp reminders found</p></td></tr>';
  else whatsapp.forEach(w => {
    waHtml += '<tr>' +
      '<td class="mono truncate">' + esc(w.reminderId) + '</td>' +
      '<td>' + esc(w.phoneNumber) + '</td>' +
      '<td>' + extractReminderType(w.reminderId) + '</td>' +
      '<td>' + fmtDate(w.scheduledFor) + '</td>' +
      '<td>' + statusPill(w.status) + '</td>' +
      '<td class="error-msg">' + esc(w.errorMessage || w.cancelReason || '') + '</td>' +
      '</tr>';
  });
  $('#waBody').innerHTML = waHtml;

  // Discord table
  let discordHtml = '';
  if (discord.length === 0) discordHtml = '<tr><td colspan="6" class="empty" style="padding:32px"><p>No Discord meet reminders found</p></td></tr>';
  else discord.forEach(d => {
    discordHtml += '<tr>' +
      '<td class="mono truncate">' + esc(d.reminderId) + '</td>' +
      '<td>' + esc(d.clientName) + '</td>' +
      '<td>' + fmtDate(d.meetingStartISO) + '</td>' +
      '<td>' + fmtDate(d.scheduledFor) + '</td>' +
      '<td>' + statusPill(d.status) + '</td>' +
      '<td class="error-msg">' + esc(d.errorMessage || d.cancelReason || '') + '</td>' +
      '</tr>';
  });
  $('#discordBody').innerHTML = discordHtml;

  // BDA table
  let bdaHtml = '';
  if (bda.length === 0) bdaHtml = '<tr><td colspan="6" class="empty" style="padding:32px"><p>No BDA attendance records found</p></td></tr>';
  else bda.forEach(a => {
    bdaHtml += '<tr>' +
      '<td>' + esc(a.bdaEmail) + '</td>' +
      '<td class="mono truncate">' + esc(a.bookingId) + '</td>' +
      '<td>' + statusPill(a.status) + '</td>' +
      '<td>' + fmtDate(a.joinedAt) + '</td>' +
      '<td>' + fmtDate(a.leftAt) + '</td>' +
      '<td>' + fmtDuration(a.cumulativeDurationMs || a.durationMs) + '</td>' +
      '</tr>';
  });
  $('#bdaBody').innerHTML = bdaHtml;

  // Errors table
  let errHtml = '';
  if (errors.length === 0) errHtml = '<tr><td colspan="6" class="empty" style="padding:32px"><p>No errors recorded</p></td></tr>';
  else errors.forEach(e => {
    errHtml += '<tr>' +
      '<td style="white-space:nowrap">' + fmtDate(e.createdAt) + '</td>' +
      '<td>' + esc(e.category) + '</td>' +
      '<td>' + severityPill(e.severity) + '</td>' +
      '<td>' + esc(e.message) + '</td>' +
      '<td class="mono">' + esc(e.source || '') + '</td>' +
      '<td class="mono truncate">' + esc(e.bookingId || '') + '</td>' +
      '</tr>';
  });
  $('#errorsBody').innerHTML = errHtml;
}

function field(label, value) {
  return '<div class="booking-field"><span class="label">' + label + '</span><span class="value">' + esc(String(value || '—')) + '</span></div>';
}

// Auto-search from URL params
const urlQ = new URLSearchParams(location.search).get('q');
if (urlQ) {
  $('#searchInput').value = urlQ;
  search(urlQ);
}
</script>
</body>
</html>`;

  res.send(html);
}
