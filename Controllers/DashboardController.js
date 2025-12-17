import { ScheduledCallModel } from '../Schema_Models/ScheduledCall.js';
import { WorkflowLogModel } from '../Schema_Models/WorkflowLog.js';
import { ScheduledEmailCampaignModel } from '../Schema_Models/ScheduledEmailCampaign.js';
import { WhatsAppCampaignModel } from '../Schema_Models/WhatsAppCampaign.js';
import { executeWorkflowLog, executeScheduledEmailCampaign, executeWhatsAppCampaign } from '../Utils/cronScheduler.js';
import { processDueCalls } from '../Utils/CallScheduler.js';

export async function getDashboardData(req, res) {
  try {
    const { category = 'calls', page = 1, limit = 20, status } = req.query;
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    let data = {};
    let stats = {};

    if (category === 'calls') {
      const query = status ? { status } : {};
      const [calls, total] = await Promise.all([
        ScheduledCallModel.find(query)
          .sort({ scheduledFor: -1 })
          .skip(skip)
          .limit(limitNum)
          .lean(),
        ScheduledCallModel.countDocuments(query)
      ]);

      const [pending, processing, completed, failed] = await Promise.all([
        ScheduledCallModel.countDocuments({ status: 'pending' }),
        ScheduledCallModel.countDocuments({ status: 'processing' }),
        ScheduledCallModel.countDocuments({ status: 'completed' }),
        ScheduledCallModel.countDocuments({ status: 'failed' })
      ]);

      stats = { pending, processing, completed, failed, total };
      data = { calls, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } };
    }

    if (category === 'workflows') {
      const query = status ? { status } : {};
      const [logs, total] = await Promise.all([
        WorkflowLogModel.find(query)
          .sort({ scheduledFor: -1 })
          .skip(skip)
          .limit(limitNum)
          .lean(),
        WorkflowLogModel.countDocuments(query)
      ]);

      const [scheduled, executed, failed] = await Promise.all([
        WorkflowLogModel.countDocuments({ status: 'scheduled' }),
        WorkflowLogModel.countDocuments({ status: 'executed' }),
        WorkflowLogModel.countDocuments({ status: 'failed' })
      ]);

      stats = { scheduled, executed, failed, total };
      data = { logs, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } };
    }

    if (category === 'email-campaigns') {
      const query = status ? { status } : {};
      const [campaigns, total] = await Promise.all([
        ScheduledEmailCampaignModel.find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .lean(),
        ScheduledEmailCampaignModel.countDocuments(query)
      ]);

      const [active, completed, failed] = await Promise.all([
        ScheduledEmailCampaignModel.countDocuments({ status: 'active' }),
        ScheduledEmailCampaignModel.countDocuments({ status: 'completed' }),
        ScheduledEmailCampaignModel.countDocuments({ status: 'failed' })
      ]);

      let pendingSchedules = 0;
      for (const campaign of campaigns) {
        pendingSchedules += campaign.sendSchedule.filter(s => s.status === 'pending').length;
      }

      stats = { active, completed, failed, pendingSchedules, total };
      data = { campaigns, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } };
    }

    if (category === 'whatsapp-campaigns') {
      const query = status ? { status } : {};
      const [campaigns, total] = await Promise.all([
        WhatsAppCampaignModel.find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .lean(),
        WhatsAppCampaignModel.countDocuments(query)
      ]);

      const [scheduled, inProgress, completed, failed] = await Promise.all([
        WhatsAppCampaignModel.countDocuments({ status: 'SCHEDULED' }),
        WhatsAppCampaignModel.countDocuments({ status: 'IN_PROGRESS' }),
        WhatsAppCampaignModel.countDocuments({ status: 'COMPLETED' }),
        WhatsAppCampaignModel.countDocuments({ status: 'FAILED' })
      ]);

      stats = { scheduled, inProgress, completed, failed, total };
      data = { campaigns, pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) } };
    }

    return res.json({ success: true, category, stats, data });
  } catch (error) {
    console.error('Dashboard error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function sendNow(req, res) {
  try {
    const { type, id } = req.body;

    if (type === 'call') {
      const call = await ScheduledCallModel.findOne({ callId: id });
      if (!call) {
        return res.status(404).json({ success: false, message: 'Call not found' });
      }
      const { processDueCalls } = await import('../Utils/CallScheduler.js');
      await processDueCalls();
      const updatedCall = await ScheduledCallModel.findOne({ callId: id });
      return res.json({ success: true, message: 'Call processing triggered', status: updatedCall?.status });
    }

    if (type === 'workflow') {
      const log = await WorkflowLogModel.findOne({ logId: id });
      if (!log) {
        return res.status(404).json({ success: false, message: 'Workflow log not found' });
      }
      await executeWorkflowLog(log);
      return res.json({ success: true, message: 'Workflow executed' });
    }

    if (type === 'email-campaign') {
      const campaign = await ScheduledEmailCampaignModel.findById(id);
      if (!campaign) {
        return res.status(404).json({ success: false, message: 'Campaign not found' });
      }
      const dueSchedules = campaign.sendSchedule.filter(s => s.status === 'pending');
      for (const scheduleItem of dueSchedules) {
        await executeScheduledEmailCampaign(campaign, scheduleItem);
      }
      return res.json({ success: true, message: 'Email campaign executed' });
    }

    if (type === 'whatsapp-campaign') {
      const campaign = await WhatsAppCampaignModel.findOne({ campaignId: id });
      if (!campaign) {
        return res.status(404).json({ success: false, message: 'WhatsApp campaign not found' });
      }
      await executeWhatsAppCampaign(campaign);
      return res.json({ success: true, message: 'WhatsApp campaign executed' });
    }

    return res.status(400).json({ success: false, message: 'Invalid type' });
  } catch (error) {
    console.error('Send now error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function renderDashboard(req, res) {
  try {
    const { category = 'calls', page = 1, status } = req.query;

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FlashFire Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: #f5f7fa;
            color: #333;
            padding: 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 12px;
            margin-bottom: 30px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .header h1 { font-size: 32px; margin-bottom: 10px; }
        .header p { opacity: 0.9; font-size: 14px; }
        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        .tab {
            padding: 12px 24px;
            background: white;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 600;
            transition: all 0.3s;
            text-decoration: none;
            color: #333;
        }
        .tab:hover { border-color: #667eea; transform: translateY(-2px); }
        .tab.active {
            background: #667eea;
            color: white;
            border-color: #667eea;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        .stat-card {
            background: white;
            padding: 20px;
            border-radius: 12px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            border-left: 4px solid #667eea;
        }
        .stat-card.pending { border-left-color: #f59e0b; }
        .stat-card.processing { border-left-color: #3b82f6; }
        .stat-card.completed { border-left-color: #10b981; }
        .stat-card.failed { border-left-color: #ef4444; }
        .stat-card h3 {
            font-size: 14px;
            color: #666;
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .stat-card .value {
            font-size: 32px;
            font-weight: 700;
            color: #333;
        }
        .filters {
            background: white;
            padding: 20px;
            border-radius: 12px;
            margin-bottom: 20px;
            display: flex;
            gap: 15px;
            align-items: center;
            flex-wrap: wrap;
        }
        .filter-btn {
            padding: 8px 16px;
            border: 1px solid #e0e0e0;
            background: white;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
            text-decoration: none;
            color: #333;
        }
        .filter-btn:hover { background: #f5f7fa; }
        .filter-btn.active {
            background: #667eea;
            color: white;
            border-color: #667eea;
        }
        .table-container {
            background: white;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        thead {
            background: #f8f9fa;
            border-bottom: 2px solid #e0e0e0;
        }
        th {
            padding: 16px;
            text-align: left;
            font-weight: 600;
            color: #666;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        td {
            padding: 16px;
            border-bottom: 1px solid #f0f0f0;
        }
        tr:hover { background: #f8f9fa; }
        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
        }
        .badge.pending { background: #fef3c7; color: #92400e; }
        .badge.processing { background: #dbeafe; color: #1e40af; }
        .badge.completed { background: #d1fae5; color: #065f46; }
        .badge.failed { background: #fee2e2; color: #991b1b; }
        .badge.scheduled { background: #e0e7ff; color: #3730a3; }
        .badge.executed { background: #d1fae5; color: #065f46; }
        .badge.active { background: #dbeafe; color: #1e40af; }
        .badge.SCHEDULED { background: #e0e7ff; color: #3730a3; }
        .badge.IN_PROGRESS { background: #dbeafe; color: #1e40af; }
        .badge.COMPLETED { background: #d1fae5; color: #065f46; }
        .badge.FAILED { background: #fee2e2; color: #991b1b; }
        .btn {
            padding: 6px 12px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            transition: all 0.2s;
        }
        .btn-primary {
            background: #667eea;
            color: white;
        }
        .btn-primary:hover { background: #5568d3; }
        .pagination {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 10px;
            padding: 20px;
            background: white;
            border-top: 1px solid #e0e0e0;
        }
        .pagination a {
            padding: 8px 12px;
            border: 1px solid #e0e0e0;
            border-radius: 6px;
            text-decoration: none;
            color: #333;
            transition: all 0.2s;
        }
        .pagination a:hover { background: #f5f7fa; }
        .pagination a.active {
            background: #667eea;
            color: white;
            border-color: #667eea;
        }
        .empty {
            text-align: center;
            padding: 60px 20px;
            color: #999;
        }
        .error { color: #ef4444; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 FlashFire Dashboard</h1>
            <p>Monitor MongoDB Calls & Cron Jobs</p>
        </div>

        <div class="tabs">
            <a href="/details?category=calls" class="tab ${category === 'calls' ? 'active' : ''}">📞 Calls</a>
            <a href="/details?category=workflows" class="tab ${category === 'workflows' ? 'active' : ''}">📧 Workflows</a>
            <a href="/details?category=email-campaigns" class="tab ${category === 'email-campaigns' ? 'active' : ''}">✉️ Email Campaigns</a>
            <a href="/details?category=whatsapp-campaigns" class="tab ${category === 'whatsapp-campaigns' ? 'active' : ''}">💬 WhatsApp Campaigns</a>
        </div>

        <div id="stats"></div>
        <div id="filters"></div>
        <div id="table"></div>
        <div id="pagination"></div>
    </div>

    <script>
        const category = '${category}';
        const page = ${page};
        const status = '${status || ''}';

        async function loadData() {
            try {
                const params = new URLSearchParams({ category, page, ...(status && { status }) });
                const res = await fetch('/api/dashboard/data?' + params);
                const json = await res.json();

                if (!json.success) throw new Error(json.error);

                renderStats(json.stats);
                renderFilters(json.stats, category);
                renderTable(json.data, category);
                renderPagination(json.data.pagination, category);
            } catch (error) {
                document.getElementById('table').innerHTML = '<div class="empty"><p class="error">Error: ' + error.message + '</p></div>';
            }
        }

        function renderStats(stats) {
            const statsHtml = '<div class="stats-grid">' + Object.entries(stats).filter(([k]) => k !== 'total').map(([key, value]) => {
                const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1');
                return \`<div class="stat-card \${key}"><h3>\${label}</h3><div class="value">\${value}</div></div>\`;
            }).join('') + '</div>';
            document.getElementById('stats').innerHTML = statsHtml;
        }

        function renderFilters(stats, cat) {
            const filters = [];
            if (cat === 'calls') filters.push(['', 'All'], ['pending', 'Pending'], ['processing', 'Processing'], ['completed', 'Completed'], ['failed', 'Failed']);
            if (cat === 'workflows') filters.push(['', 'All'], ['scheduled', 'Scheduled'], ['executed', 'Executed'], ['failed', 'Failed']);
            if (cat === 'email-campaigns') filters.push(['', 'All'], ['active', 'Active'], ['completed', 'Completed'], ['failed', 'Failed']);
            if (cat === 'whatsapp-campaigns') filters.push(['', 'All'], ['SCHEDULED', 'Scheduled'], ['IN_PROGRESS', 'In Progress'], ['COMPLETED', 'Completed'], ['FAILED', 'Failed']);

            const filtersHtml = '<div class="filters">' + filters.map(([val, label]) => 
                \`<a href="/details?category=\${cat}&status=\${val}" class="filter-btn \${status === val ? 'active' : ''}">\${label}</a>\`
            ).join('') + '</div>';
            document.getElementById('filters').innerHTML = filtersHtml;
        }

        function renderTable(data, cat) {
            if (!data || Object.keys(data).length === 0) {
                document.getElementById('table').innerHTML = '<div class="empty">No data found</div>';
                return;
            }

            let tableHtml = '<div class="table-container"><table><thead><tr>';

            if (cat === 'calls') {
                tableHtml += '<th>Phone</th><th>Name</th><th>Email</th><th>Scheduled For</th><th>Meeting Time</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
                data.calls.forEach(call => {
                    const scheduledDate = new Date(call.scheduledFor).toLocaleString();
                    const meetingDate = new Date(call.meetingStartISO).toLocaleString();
                    tableHtml += \`<tr>
                        <td>\${call.phoneNumber}</td>
                        <td>\${call.inviteeName || 'N/A'}</td>
                        <td>\${call.inviteeEmail || 'N/A'}</td>
                        <td>\${scheduledDate}</td>
                        <td>\${meetingDate}</td>
                        <td><span class="badge \${call.status}">\${call.status}</span></td>
                        <td><button class="btn btn-primary" onclick="sendNow('call', '\${call.callId}')">Send Now</button></td>
                    </tr>\`;
                });
            }

            if (cat === 'workflows') {
                tableHtml += '<th>Workflow</th><th>Client</th><th>Channel</th><th>Template</th><th>Scheduled For</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
                data.logs.forEach(log => {
                    const scheduledDate = new Date(log.scheduledFor).toLocaleString();
                    tableHtml += \`<tr>
                        <td>\${log.workflowName || log.workflowId}</td>
                        <td>\${log.clientEmail}</td>
                        <td>\${log.step.channel}</td>
                        <td>\${log.step.templateName || log.step.templateId}</td>
                        <td>\${scheduledDate}</td>
                        <td><span class="badge \${log.status}">\${log.status}</span></td>
                        <td><button class="btn btn-primary" onclick="sendNow('workflow', '\${log.logId}')">Send Now</button></td>
                    </tr>\`;
                });
            }

            if (cat === 'email-campaigns') {
                tableHtml += '<th>Campaign Name</th><th>Template</th><th>Recipients</th><th>Status</th><th>Pending Schedules</th><th>Actions</th></tr></thead><tbody>';
                data.campaigns.forEach(campaign => {
                    const pendingCount = campaign.sendSchedule.filter(s => s.status === 'pending').length;
                    tableHtml += \`<tr>
                        <td>\${campaign.campaignName}</td>
                        <td>\${campaign.templateName}</td>
                        <td>\${campaign.totalRecipients}</td>
                        <td><span class="badge \${campaign.status}">\${campaign.status}</span></td>
                        <td>\${pendingCount}</td>
                        <td><button class="btn btn-primary" onclick="sendNow('email-campaign', '\${campaign._id}')">Send Now</button></td>
                    </tr>\`;
                });
            }

            if (cat === 'whatsapp-campaigns') {
                tableHtml += '<th>Campaign ID</th><th>Template</th><th>Recipients</th><th>Success</th><th>Failed</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
                data.campaigns.forEach(campaign => {
                    tableHtml += \`<tr>
                        <td>\${campaign.campaignId}</td>
                        <td>\${campaign.templateName}</td>
                        <td>\${campaign.totalRecipients}</td>
                        <td>\${campaign.successCount || 0}</td>
                        <td>\${campaign.failedCount || 0}</td>
                        <td><span class="badge \${campaign.status}">\${campaign.status}</span></td>
                        <td><button class="btn btn-primary" onclick="sendNow('whatsapp-campaign', '\${campaign.campaignId}')">Send Now</button></td>
                    </tr>\`;
                });
            }

            tableHtml += '</tbody></table></div>';
            document.getElementById('table').innerHTML = tableHtml;
        }

        function renderPagination(pagination, cat) {
            if (!pagination || pagination.pages <= 1) {
                document.getElementById('pagination').innerHTML = '';
                return;
            }

            let paginationHtml = '<div class="pagination">';
            for (let i = 1; i <= pagination.pages; i++) {
                const active = i === pagination.page ? 'active' : '';
                const url = \`/details?category=\${cat}&page=\${i}\${status ? '&status=' + status : ''}\`;
                paginationHtml += \`<a href="\${url}" class="\${active}">\${i}</a>\`;
            }
            paginationHtml += '</div>';
            document.getElementById('pagination').innerHTML = paginationHtml;
        }

        async function sendNow(type, id) {
            if (!confirm('Execute this item now?')) return;
            try {
                const res = await fetch('/api/dashboard/send-now', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type, id })
                });
                const json = await res.json();
                if (json.success) {
                    alert('Executed successfully!');
                    loadData();
                } else {
                    alert('Error: ' + json.message);
                }
            } catch (error) {
                alert('Error: ' + error.message);
            }
        }

        loadData();
        setInterval(loadData, 30000);
    </script>
</body>
</html>
    `;

    res.send(html);
  } catch (error) {
    console.error('Dashboard render error:', error);
    res.status(500).send('Error loading dashboard');
  }
}
