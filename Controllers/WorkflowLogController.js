import { WorkflowLogModel } from '../Schema_Models/WorkflowLog.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import sgMail from '@sendgrid/mail';

sgMail.setApiKey(process.env.SENDGRID_API_KEY_1 || process.env.SENDGRID_API_KEY);

// ==================== GET WORKFLOW LOGS WITH PAGINATION ====================
export const getWorkflowLogs = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      workflowId,
      bookingId,
      triggerAction,
      startDate,
      endDate
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build query
    const query = {};

    if (status) {
      query.status = status;
    }

    if (workflowId) {
      query.workflowId = workflowId;
    }

    if (bookingId) {
      query.bookingId = bookingId;
    }

    if (triggerAction) {
      query.triggerAction = triggerAction;
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        query.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        query.createdAt.$lte = new Date(endDate);
      }
    }

    // Get total count
    const total = await WorkflowLogModel.countDocuments(query);

    // Get logs
    const logs = await WorkflowLogModel.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    return res.status(200).json({
      success: true,
      data: logs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });

  } catch (error) {
    console.error('Error fetching workflow logs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch workflow logs',
      error: error.message
    });
  }
};

// ==================== GET LOG BY ID ====================
export const getWorkflowLogById = async (req, res) => {
  try {
    const { logId } = req.params;

    const log = await WorkflowLogModel.findOne({ logId });

    if (!log) {
      return res.status(404).json({
        success: false,
        message: 'Workflow log not found'
      });
    }

    return res.status(200).json({
      success: true,
      data: log
    });

  } catch (error) {
    console.error('Error fetching workflow log:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch workflow log',
      error: error.message
    });
  }
};

// ==================== GET LOG STATISTICS ====================
export const getWorkflowLogStats = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const query = {};
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        query.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        query.createdAt.$lte = new Date(endDate);
      }
    }

    const stats = await WorkflowLogModel.aggregate([
      { $match: query },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const total = await WorkflowLogModel.countDocuments(query);
    const scheduled = await WorkflowLogModel.countDocuments({ ...query, status: 'scheduled' });
    const executed = await WorkflowLogModel.countDocuments({ ...query, status: 'executed' });
    const failed = await WorkflowLogModel.countDocuments({ ...query, status: 'failed' });

    return res.status(200).json({
      success: true,
      data: {
        total,
        scheduled,
        executed,
        failed,
        breakdown: stats
      }
    });

  } catch (error) {
    console.error('Error fetching workflow log stats:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch workflow log statistics',
      error: error.message
    });
  }
};

// ==================== SEND WORKFLOW LOG EMAIL NOW ====================
export const sendWorkflowLogNow = async (req, res) => {
  try {
    const { logId } = req.params;

    // Find the log
    const log = await WorkflowLogModel.findOne({ logId });
    if (!log) {
      return res.status(404).json({
        success: false,
        message: 'Workflow log not found'
      });
    }

    // Only allow sending emails (not WhatsApp)
    if (log.step.channel !== 'email') {
      return res.status(400).json({
        success: false,
        message: 'This endpoint only supports email workflow steps'
      });
    }

    // Only allow sending scheduled or failed logs
    if (log.status === 'executed') {
      return res.status(400).json({
        success: false,
        message: 'This workflow step has already been executed'
      });
    }

    // Get booking details
    const booking = await CampaignBookingModel.findOne({ bookingId: log.bookingId }).lean();
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Use domainName from step if provided, otherwise fallback to env or default
    const domainName = log.step.domainName || process.env.DOMAIN_NAME || 'flashfirejobs.com';

    // Determine sender email with priority:
    // 1. Explicit senderEmail from step
    // 2. If domainName is provided, construct: elizabeth@${domainName}
    // 3. Default: elizabeth@flashfirehq.com
    // 4. Fallback to env variable (SENDGRID_FROM_EMAIL)
    let senderEmail;
    if (log.step.senderEmail) {
      senderEmail = log.step.senderEmail;
    } else {
      const stepDomainName = log.step.domainName || process.env.DOMAIN_NAME || null;
      if (stepDomainName) {
        senderEmail = `elizabeth@${stepDomainName}`;
      } else {
        senderEmail = process.env.SENDER_EMAIL || process.env.SENDGRID_FROM_EMAIL || 'elizabeth@flashfirehq.com';
      }
    }

    if (!senderEmail) {
      return res.status(500).json({
        success: false,
        message: 'Sender email not configured'
      });
    }

    // Send email via SendGrid
    const msg = {
      to: log.clientEmail,
      from: senderEmail,
      templateId: log.step.templateId,
      dynamicTemplateData: {
        domain: domainName,
        clientName: booking.clientName || log.clientName || 'Client',
        bookingId: log.bookingId
      }
    };

    let responseData = null;
    try {
      const result = await sgMail.send(msg);
      responseData = { 
        statusCode: result[0]?.statusCode, 
        messageId: result[0]?.headers?.['x-message-id'] 
      };
      
      console.log(`✅ [Send Now] Email sent immediately for log ${logId} to ${log.clientEmail} from ${senderEmail} using domain ${domainName}`);

      // Update log status to executed
      await WorkflowLogModel.updateOne(
        { logId },
        {
          $set: {
            status: 'executed',
            executedAt: new Date(),
            responseData
          },
          $unset: {
            error: '',
            errorDetails: ''
          }
        }
      );

      return res.status(200).json({
        success: true,
        message: 'Email sent successfully',
        data: {
          logId: log.logId,
          status: 'executed',
          executedAt: new Date(),
          responseData,
          senderEmail,
          domainName
        }
      });

    } catch (emailError) {
      console.error(`❌ [Send Now] Failed to send email for log ${logId}:`, emailError);
      
      // Update log status to failed
      await WorkflowLogModel.updateOne(
        { logId },
        {
          $set: {
            status: 'failed',
            error: emailError.message || 'Failed to send email',
            errorDetails: emailError.response?.body || emailError
          }
        }
      );

      return res.status(500).json({
        success: false,
        message: 'Failed to send email',
        error: emailError.message,
        errorDetails: emailError.response?.body || emailError
      });
    }

  } catch (error) {
    console.error('Error sending workflow log email:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send workflow log email',
      error: error.message
    });
  }
};

