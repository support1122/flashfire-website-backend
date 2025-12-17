import { WorkflowModel } from '../Schema_Models/Workflow.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { WorkflowLogModel } from '../Schema_Models/WorkflowLog.js';
import sgMail from '@sendgrid/mail';
import watiService from '../Utils/WatiService.js';

sgMail.setApiKey(process.env.SENDGRID_API_KEY_1 || process.env.SENDGRID_API_KEY);

// ==================== CREATE WORKFLOW ====================
export const createWorkflow = async (req, res) => {
  try {
    const { triggerAction, steps, name, description } = req.body;

    if (!triggerAction || !steps || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Trigger action and at least one step are required'
      });
    }

    const validActions = ['no-show', 'complete', 'cancel', 're-schedule'];
    if (!validActions.includes(triggerAction)) {
      return res.status(400).json({
        success: false,
        message: `Invalid trigger action. Must be one of: ${validActions.join(', ')}`
      });
    }

    // Validate steps
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step.channel || !['email', 'whatsapp'].includes(step.channel)) {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: Invalid channel. Must be 'email' or 'whatsapp'`
        });
      }
      if (typeof step.daysAfter !== 'number' || step.daysAfter < 0) {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: daysAfter must be a non-negative number`
        });
      }
      if (!step.templateId || step.templateId.trim() === '') {
        return res.status(400).json({
          success: false,
          message: `Step ${i + 1}: templateId is required`
        });
      }
    }

    // Sort steps by order
    const sortedSteps = steps.map((step, index) => ({
      ...step,
      order: step.order !== undefined ? step.order : index
    })).sort((a, b) => a.order - b.order);

    const workflow = new WorkflowModel({
      triggerAction,
      steps: sortedSteps,
      name: name || null,
      description: description || null,
      isActive: true
    });

    await workflow.save();

    return res.status(201).json({
      success: true,
      message: 'Workflow created successfully',
      data: workflow
    });

  } catch (error) {
    console.error('Error creating workflow:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create workflow',
      error: error.message
    });
  }
};

// ==================== GET ALL WORKFLOWS ====================
export const getAllWorkflows = async (req, res) => {
  try {
    const { triggerAction, isActive } = req.query;

    let query = {};
    if (triggerAction) query.triggerAction = triggerAction;
    if (isActive !== undefined) query.isActive = isActive === 'true';

    const workflows = await WorkflowModel.find(query)
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: workflows.length,
      data: workflows
    });

  } catch (error) {
    console.error('Error fetching workflows:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch workflows',
      error: error.message
    });
  }
};

// ==================== GET WORKFLOW BY ID ====================
export const getWorkflowById = async (req, res) => {
  try {
    const { workflowId } = req.params;

    const workflow = await WorkflowModel.findOne({ workflowId });

    if (!workflow) {
      return res.status(404).json({
        success: false,
        message: 'Workflow not found'
      });
    }

    return res.status(200).json({
      success: true,
      data: workflow
    });

  } catch (error) {
    console.error('Error fetching workflow:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch workflow',
      error: error.message
    });
  }
};

// ==================== UPDATE WORKFLOW ====================
export const updateWorkflow = async (req, res) => {
  try {
    const { workflowId } = req.params;
    const { triggerAction, steps, name, description, isActive } = req.body;

    const workflow = await WorkflowModel.findOne({ workflowId });

    if (!workflow) {
      return res.status(404).json({
        success: false,
        message: 'Workflow not found'
      });
    }

    // Validate triggerAction if provided
    if (triggerAction) {
      const validActions = ['no-show', 'complete', 'cancel', 're-schedule'];
      if (!validActions.includes(triggerAction)) {
        return res.status(400).json({
          success: false,
          message: `Invalid trigger action. Must be one of: ${validActions.join(', ')}`
        });
      }
      workflow.triggerAction = triggerAction;
    }

    // Validate and update steps if provided
    if (steps && Array.isArray(steps)) {
      if (steps.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'At least one step is required'
        });
      }

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step.channel || !['email', 'whatsapp'].includes(step.channel)) {
          return res.status(400).json({
            success: false,
            message: `Step ${i + 1}: Invalid channel. Must be 'email' or 'whatsapp'`
          });
        }
        if (typeof step.daysAfter !== 'number' || step.daysAfter < 0) {
          return res.status(400).json({
            success: false,
            message: `Step ${i + 1}: daysAfter must be a non-negative number`
          });
        }
        if (!step.templateId || step.templateId.trim() === '') {
          return res.status(400).json({
            success: false,
            message: `Step ${i + 1}: templateId is required`
          });
        }
      }

      // Sort steps by order
      const sortedSteps = steps.map((step, index) => ({
        ...step,
        order: step.order !== undefined ? step.order : index
      })).sort((a, b) => a.order - b.order);

      workflow.steps = sortedSteps;
    }

    if (name !== undefined) workflow.name = name || null;
    if (description !== undefined) workflow.description = description || null;
    if (isActive !== undefined) workflow.isActive = isActive;

    await workflow.save();

    return res.status(200).json({
      success: true,
      message: 'Workflow updated successfully',
      data: workflow
    });

  } catch (error) {
    console.error('Error updating workflow:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update workflow',
      error: error.message
    });
  }
};

// ==================== DELETE WORKFLOW ====================
export const deleteWorkflow = async (req, res) => {
  try {
    const { workflowId } = req.params;

    const workflow = await WorkflowModel.findOneAndDelete({ workflowId });

    if (!workflow) {
      return res.status(404).json({
        success: false,
        message: 'Workflow not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Workflow deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting workflow:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete workflow',
      error: error.message
    });
  }
};

// ==================== TRIGGER WORKFLOW ====================
export const triggerWorkflow = async (bookingId, action) => {
  try {
    // Map action to triggerAction format
    const actionMap = {
      'no-show': 'no-show',
      'completed': 'complete',
      'canceled': 'cancel',
      'rescheduled': 're-schedule'
    };

    const triggerAction = actionMap[action];
    if (!triggerAction) {
      console.log(`⚠️ No workflow trigger for action: ${action}`);
      return { success: false, message: `No workflow trigger for action: ${action}` };
    }

    // Find active workflows for this action
    const workflows = await WorkflowModel.find({
      triggerAction,
      isActive: true
    }).lean();

    if (workflows.length === 0) {
      console.log(`ℹ️ No active workflows found for action: ${triggerAction}`);
      return { success: true, triggered: false, message: 'No workflows to trigger' };
    }

    // Get booking details
    const booking = await CampaignBookingModel.findOne({ bookingId }).lean();
    if (!booking) {
      return { success: false, message: 'Booking not found' };
    }

    const results = {
      triggered: true,
      workflowsTriggered: [],
      errors: []
    };

    const { calculateScheduledDate } = await import('../Utils/cronScheduler.js');

    for (const workflow of workflows) {
      for (const step of workflow.steps) {
        try {
          if (step.daysAfter === 0) {
            await executeWorkflowStep(step, booking, workflow.workflowId, workflow.name, triggerAction);
            results.workflowsTriggered.push({
              workflowId: workflow.workflowId,
              workflowName: workflow.name,
              step: step,
              executed: true,
              executedAt: new Date()
            });
          } else {
            const executionDate = calculateScheduledDate(new Date(), step.daysAfter);
            await scheduleWorkflowStep(bookingId, step, workflow.workflowId, executionDate, booking, workflow.name, triggerAction);
            results.workflowsTriggered.push({
              workflowId: workflow.workflowId,
              workflowName: workflow.name,
              step: step,
              scheduled: true,
              scheduledFor: executionDate
            });
          }
        } catch (error) {
          console.error(`Error processing workflow step:`, error);
          // Log failed execution
          await logWorkflowExecution({
            workflowId: workflow.workflowId,
            workflowName: workflow.name,
            triggerAction,
            bookingId,
            booking,
            step,
            status: 'failed',
            error: error.message,
            scheduledFor: new Date()
          });
          results.errors.push({
            workflowId: workflow.workflowId,
            step: step,
            error: error.message
          });
        }
      }
    }

    return { success: true, ...results };

  } catch (error) {
    console.error('Error triggering workflow:', error);
    return { success: false, error: error.message };
  }
};

// ==================== EXECUTE WORKFLOW STEP ====================
async function executeWorkflowStep(step, booking, workflowId, workflowName = null, triggerAction = null) {
  let responseData = null;
  const executedAt = new Date();
  
  try {
    if (step.channel === 'email') {
      const domainName = step.domainName || 'flashfiremails.com';

      let senderEmail;
      if (step.senderEmail) {
        senderEmail = step.senderEmail;
      } else {
        senderEmail = process.env.SENDER_EMAIL || process.env.SENDGRID_FROM_EMAIL || 'elizabeth@flashfirehq.com';
      }

      if (!senderEmail) {
        throw new Error('Sender email not configured');
      }

      const msg = {
        to: booking.clientEmail,
        from: senderEmail,
        templateId: step.templateId,
        dynamicTemplateData: {
          domain: domainName,
          clientName: booking.clientName,
          bookingId: booking.bookingId
        }
      };

      const result = await sgMail.send(msg);
      responseData = { statusCode: result[0]?.statusCode, messageId: result[0]?.headers?.['x-message-id'] };
      console.log(`✅ Email sent via workflow ${workflowId} to ${booking.clientEmail}`);

      // Log successful execution
      await logWorkflowExecution({
        workflowId,
        workflowName,
        triggerAction,
        bookingId: booking.bookingId,
        booking,
        step,
        status: 'executed',
        executedAt,
        responseData
      });

    } else if (step.channel === 'whatsapp') {
      // Send WhatsApp via WATI
      if (!booking.clientPhone) {
        throw new Error('Client phone number not available');
      }

      const result = await watiService.sendTemplateMessage({
        mobileNumber: booking.clientPhone,
        templateName: step.templateId, // Using templateId as templateName for WATI
        parameters: [],
        campaignId: `workflow_${workflowId}_${Date.now()}`
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to send WhatsApp message');
      }

      responseData = result.data;
      console.log(`✅ WhatsApp sent via workflow ${workflowId} to ${booking.clientPhone}`);

      // Log successful execution
      await logWorkflowExecution({
        workflowId,
        workflowName,
        triggerAction,
        bookingId: booking.bookingId,
        booking,
        step,
        status: 'executed',
        executedAt,
        responseData
      });
    }

    return { success: true, responseData };

  } catch (error) {
    console.error('Error executing workflow step:', error);
    
    // Log failed execution
    await logWorkflowExecution({
      workflowId,
      workflowName,
      triggerAction,
      bookingId: booking.bookingId,
      booking,
      step,
      status: 'failed',
      executedAt,
      error: error.message,
      errorDetails: error.response || error
    });
    
    throw error;
  }
}

// ==================== SCHEDULE WORKFLOW STEP ====================
async function scheduleWorkflowStep(bookingId, step, workflowId, executionDate, booking, workflowName = null, triggerAction = null) {
  try {
    // Store scheduled workflow execution in booking document
    // We'll add a field to track scheduled workflows
    // Always fetch the booking document (not lean) so we can save it
    let bookingDoc = await CampaignBookingModel.findOne({ bookingId });
    if (!bookingDoc) {
      throw new Error('Booking not found');
    }

    // Initialize scheduledWorkflows array if it doesn't exist
    if (!bookingDoc.scheduledWorkflows) {
      bookingDoc.scheduledWorkflows = [];
    }

    // Add scheduled workflow step
    bookingDoc.scheduledWorkflows.push({
      workflowId,
      step,
      scheduledFor: executionDate,
      status: 'scheduled',
      createdAt: new Date()
    });

    await bookingDoc.save();

    // Log scheduled execution
    await logWorkflowExecution({
      workflowId,
      workflowName,
      triggerAction,
      bookingId,
      booking,
      step,
      status: 'scheduled',
      scheduledFor: executionDate
    });

    console.log(`📅 Scheduled workflow step for booking ${bookingId} at ${executionDate}`);

    return { success: true };

  } catch (error) {
    console.error('Error scheduling workflow step:', error);
    throw error;
  }
}

// ==================== LOG WORKFLOW EXECUTION ====================
async function logWorkflowExecution({ workflowId, workflowName, triggerAction, bookingId, booking, step, status, scheduledFor, executedAt = null, error = null, errorDetails = null, responseData = null }) {
  try {
    const log = new WorkflowLogModel({
      workflowId,
      workflowName: workflowName || null,
      triggerAction: triggerAction || null,
      bookingId,
      clientEmail: booking.clientEmail,
      clientName: booking.clientName || null,
      clientPhone: booking.clientPhone || null,
      step: {
        channel: step.channel,
        daysAfter: step.daysAfter,
        templateId: step.templateId,
        templateName: step.templateName || null,
        domainName: step.domainName || null,
        senderEmail: step.senderEmail || null,
        order: step.order || 0
      },
      status,
      scheduledFor: scheduledFor || executedAt || new Date(),
      executedAt: executedAt || null,
      error: error || null,
      errorDetails: errorDetails || null,
      responseData: responseData || null
    });

    await log.save();
    return log;
  } catch (error) {
    console.error('Error logging workflow execution:', error);
    // Don't throw - logging errors shouldn't break workflow execution
    return null;
  }
}

// ==================== PROCESS SCHEDULED WORKFLOWS ====================
export const processScheduledWorkflows = async () => {
  try {
    const now = new Date();
    
    // Find bookings with scheduled workflows that are due
    const bookings = await CampaignBookingModel.find({
      'scheduledWorkflows.status': 'scheduled',
      'scheduledWorkflows.scheduledFor': { $lte: now }
    }).lean();

    console.log(`🔍 Found ${bookings.length} bookings with due workflow steps`);

    for (const booking of bookings) {
      for (const scheduledWorkflow of booking.scheduledWorkflows || []) {
        if (scheduledWorkflow.status === 'scheduled' && 
            new Date(scheduledWorkflow.scheduledFor) <= now) {
          try {
            // Get workflow details for logging
            const workflow = await WorkflowModel.findOne({ workflowId: scheduledWorkflow.workflowId }).lean();
            
            await executeWorkflowStep(
              scheduledWorkflow.step,
              booking,
              scheduledWorkflow.workflowId,
              workflow?.name || null,
              workflow?.triggerAction || null
            );

            // Update status to executed
            await CampaignBookingModel.updateOne(
              { bookingId: booking.bookingId, 'scheduledWorkflows._id': scheduledWorkflow._id },
              { $set: { 'scheduledWorkflows.$.status': 'executed', 'scheduledWorkflows.$.executedAt': new Date() } }
            );

            console.log(`✅ Executed scheduled workflow step for booking ${booking.bookingId}`);
          } catch (error) {
            console.error(`❌ Error executing scheduled workflow for booking ${booking.bookingId}:`, error);
            
            // Update status to failed
            await CampaignBookingModel.updateOne(
              { bookingId: booking.bookingId, 'scheduledWorkflows._id': scheduledWorkflow._id },
              { $set: { 'scheduledWorkflows.$.status': 'failed', 'scheduledWorkflows.$.error': error.message } }
            );
          }
        }
      }
    }

    return { success: true, processed: bookings.length };

  } catch (error) {
    console.error('Error processing scheduled workflows:', error);
    return { success: false, error: error.message };
  }
};

