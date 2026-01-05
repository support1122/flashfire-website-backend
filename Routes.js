
import VerifyInterestedClient from "./Middlewares/VerifyInterestedClient.js";
import { getDashboardData, sendNow, renderDashboard } from "./Controllers/DashboardController.js";
import Register_Sessions from "./Controllers/Register_Sessions.js";
import Contact from "./Controllers/Contact.js";
import Signup from "./Controllers/Signup.js";
import GetUsersWithoutBookings from "./Controllers/GetUsersWithoutBookings.js";
import GetUsersWithoutBookingsDetailed from "./Controllers/GetUsersWithoutBookingsDetailed.js";
import GetUsersWithoutBookingsPaginated from "./Controllers/GetUsersWithoutBookingsPaginated.js";
import DeleteUserRecords from "./Controllers/DeleteUserRecords.js";
import SendEmailCampaign from "./Controllers/SendEmailCampaign.js";
import GetEmailCampaigns from "./Controllers/GetEmailCampaigns.js";
import CreateScheduledEmailCampaign from "./Controllers/CreateScheduledEmailCampaign.js";
import GetScheduledEmailCampaigns from "./Controllers/GetScheduledEmailCampaigns.js";
import UpdateScheduledEmailCampaignStatus from "./Controllers/UpdateScheduledEmailCampaignStatus.js";
import GetUserCampaigns from "./Controllers/GetUserCampaigns.js";
import GetCampaignDetails from "./Controllers/GetCampaignDetails.js";
import ResendEmailCampaign from "./Controllers/ResendEmailCampaign.js";
import { saveEmailTemplate, getEmailTemplates, deleteEmailTemplate, updateEmailTemplateFields } from "./Controllers/EmailTemplateController.js";
import EmployerForm from "./Controllers/EmployerForm.js";
import TwilioReminder from "./Controllers/TwilioReminder.js";
import twilio from 'twilio';
import SendEmailReminder from "./Controllers/SendEmailReminder.js";
// Campaign Controllers
import {
  createCampaign,
  getAllCampaigns,
  getCampaignById,
  trackPageVisit,
  trackButtonClick,
  updateCampaign,
  deleteCampaign,
  getCampaignStatistics
} from "./Controllers/CampaignController.js";
import {
  getAllBookings,
  getAllBookingsPaginated,
  getMeetingsBookedToday,
  getMeetingsByDate,
  getBookingById,
  updateBookingStatus,
  getBookingsByEmail,
  exportBookingsForMicroservice,
  markBookingsAsSynced,
  captureFrontendBooking,
  rescheduleBooking,
  updateBookingNotes,
  createBookingManually,
  getLeadsPaginated,
  updateBookingAmount,
  bulkCreateLeads,
  handlePaidClientFromMicroservice
} from "./Controllers/CampaignBookingController.js";
import ScheduleFollowUp from "./Controllers/ScheduleFollowUpController.js";
// Webhook Controllers
import { handleCalendlyWebhook, testWebhook } from "./Controllers/CalendlyWebhookController.js";
// Payment Reminder Controllers
import { schedulePaymentReminder, getPaymentReminders, cancelPaymentReminder } from "./Controllers/PaymentReminderController.js";
// Payment Controllers
import { createPayment, getAllPayments, getPaymentById, getPaymentsByEmail } from "./Controllers/PaymentController.js";
import { getMessageTypes, sendMessage, testConnection, sendSimpleMessage } from "./Controllers/WhatsAppController.js";
// WhatsApp Campaign Controllers
import { 
  getWatiTemplates, 
  getMobileNumbersByStatus, 
  createWhatsAppCampaign, 
  getAllWhatsAppCampaigns, 
  getScheduledWhatsAppCampaigns,
  sendWhatsAppCampaignNow
} from "./Controllers/WhatsAppCampaignController.js";
// Workflow Controllers
import {
  createWorkflow,
  getAllWorkflows,
  getWorkflowById,
  updateWorkflow,
  deleteWorkflow,
  processScheduledWorkflows,
  getBookingsByStatusForBulk,
  triggerWorkflowsForAllByStatus
} from "./Controllers/WorkflowController.js";
// Workflow Log Controllers
import {
  getWorkflowLogs,
  getWorkflowLogById,
  getWorkflowLogStats,
  sendWorkflowLogNow
} from "./Controllers/WorkflowLogController.js";
// Bull Board imports for queue monitoring
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { callQueue, emailQueue, whatsappQueue, redisConnection } from './Utils/queue.js';
import { crmAdminLogin, listCrmUsers, createCrmUser, updateCrmUser, deleteCrmUser } from './Controllers/CrmAdminController.js';
import { requestCrmOtp, verifyCrmOtp, crmMe } from './Controllers/CrmAuthController.js';
import { requireCrmAdmin, requireCrmUser } from './Middlewares/CrmAuth.js';
// import {GetMeetDetails} from "./Utils/GetMeetDetails.js";
// import Calendly_Meet_Integration from "./Controllers/Calendly_Meet_Integration.js";



//these routes are defined and codes are written only requires minor modification to suit on a case by case basis..


export default function Routes(app) {
  try {
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/auth/logs');

    const queues = [];
    if (callQueue) {
      queues.push(new BullMQAdapter(callQueue));
      console.log('✅ [BullBoard] Added callQueue to dashboard');
    }
    if (emailQueue) {
      queues.push(new BullMQAdapter(emailQueue));
      console.log('✅ [BullBoard] Added emailQueue to dashboard');
    }
    if (whatsappQueue) {
      queues.push(new BullMQAdapter(whatsappQueue));
      console.log('✅ [BullBoard] Added whatsappQueue to dashboard');
    }

    if (queues.length > 0) {
      const boardConfig = {
        queues: queues,
        serverAdapter: serverAdapter,
      };

      if (redisConnection) {
        console.log('✅ [BullBoard] Redis connection available for stats');
      }

      createBullBoard(boardConfig);

      app.use('/auth/logs', serverAdapter.getRouter());
      console.log('✅ [BullBoard] Dashboard available at /auth/logs');
      console.log('ℹ️  [BullBoard] Note: Clicking Redis logo may show errors with managed Redis (this is a Bull Board limitation, not affecting queue monitoring)');
    } else {
      console.warn('⚠️  [BullBoard] No queues available for monitoring');
    }
  } catch (error) {
    console.error('❌ [BullBoard] Failed to initialize dashboard:', error.message);
    console.error('❌ [BullBoard] Error stack:', error.stack);
  }

  //login routes and registration routes :
  //the login and registraion routes works but we should or can use supabase auth system
  // the login and registraion routes doesnot have email verification integrated in it..
  //since login and registration routes are not required as of now...



  //admin routes to add a job...
  //CheckJobExistance is the middleware that checks if the job being added is already present to avoid duplicate records..
  //CheckJobExistance uses job ID as parameter , job id is generated by ()=>date.now()...it keeps the id unique..
  //  job adding by admin routes....here a auth is required for enabling only authenticated admin to add job and authenticated user 
  //LocalTokenValidator can be used 


  //this is the place where all the paid users will appear to the BDE and also the relevant jobs will also appear
  //my idea is that on clicking each of the paid user we open the student dashboard where all the details like education,
  // skills, jobs applied, interview status etc can be done..
  //apart from these only an admin can create a new admin or a paid user and the admin can post a job to db using the '''/admin/addjobs route'''



  //this is the route when a new user clicks on the try now button..it verifies the details and adds details to the database..
  app.post('/', VerifyInterestedClient, Register_Sessions);
  //this is the route that calandly posts on for sending meeting details..from here meeting details or sessions can be added to DB for sales people..
  //  app.post("/calendly-webhook",GetMeetDetails);
  //the routes that handles contact us page..
  app.post('/api/contact', Contact);
  app.post('/signup', Signup);
  app.get('/api/users/without-bookings', GetUsersWithoutBookings);
  app.get('/api/users/without-bookings/detailed', GetUsersWithoutBookingsDetailed);
  app.get('/api/users/without-bookings/paginated', GetUsersWithoutBookingsPaginated);
  app.delete('/api/users/delete/:email', DeleteUserRecords);
  app.post('/api/email-campaign/send', SendEmailCampaign);
  app.post('/api/email-campaign/scheduled', CreateScheduledEmailCampaign);
  app.get('/api/email-campaigns', GetEmailCampaigns);
  app.get('/api/email-campaigns/scheduled', GetScheduledEmailCampaigns);
  app.put('/api/email-campaigns/scheduled/:campaignId/status', UpdateScheduledEmailCampaignStatus);
  app.get('/api/email-campaigns/user/:email', GetUserCampaigns);
  app.get('/api/email-campaigns/:campaignId/details/:userEmail', GetCampaignDetails);
  app.post('/api/email-campaign/resend', ResendEmailCampaign);

  // ==================== CRM AUTH (OTP) + ADMIN ====================
  app.post('/api/crm/admin/login', crmAdminLogin);
  app.get('/api/crm/admin/users', requireCrmAdmin, listCrmUsers);
  app.post('/api/crm/admin/users', requireCrmAdmin, createCrmUser);
  app.put('/api/crm/admin/users/:id', requireCrmAdmin, updateCrmUser);
  app.delete('/api/crm/admin/users/:id', requireCrmAdmin, deleteCrmUser);

  app.post('/api/crm/auth/request-otp', requestCrmOtp);
  app.post('/api/crm/auth/verify-otp', verifyCrmOtp);
  app.get('/api/crm/auth/me', requireCrmUser, crmMe);
  
  // Email Template Routes
  app.post('/api/email-templates', saveEmailTemplate);
  app.get('/api/email-templates', getEmailTemplates);
  app.put('/api/email-templates/fields', updateEmailTemplateFields);
  app.delete('/api/email-templates/:templateId', deleteEmailTemplate);
  
  // WhatsApp Campaign Routes
  app.get('/api/whatsapp-campaigns/templates', getWatiTemplates);
  app.get('/api/whatsapp-campaigns/mobile-numbers', getMobileNumbersByStatus);
  app.post('/api/whatsapp-campaigns', createWhatsAppCampaign);
  app.get('/api/whatsapp-campaigns/scheduled', getScheduledWhatsAppCampaigns);
  app.post('/api/whatsapp-campaigns/:campaignId/send-now', sendWhatsAppCampaignNow);
  app.get('/api/whatsapp-campaigns', getAllWhatsAppCampaigns);
  
  app.post('/employerform', EmployerForm);
  // app.post('/calendly-webhook',Calendly_Meet_Integration);
  //  app.post("/twilio-ivr", TwilioReminder);

  // ==================== CAMPAIGN ROUTES ====================
  // Campaign Management
  app.post('/api/campaigns', createCampaign); // Create new campaign
  app.get('/api/campaigns', getAllCampaigns); // Get all campaigns
  app.get('/api/campaigns/stats', getCampaignStatistics); // Get overall statistics
  app.get('/api/campaigns/:campaignId', getCampaignById); // Get specific campaign with details
  app.put('/api/campaigns/:campaignId', updateCampaign); // Update campaign
  app.delete('/api/campaigns/:campaignId', deleteCampaign); // Delete campaign

  // Tracking
  app.post('/api/campaigns/track/visit', trackPageVisit); // Track page visit with UTM
  app.post('/api/campaigns/track/button-click', trackButtonClick); // Track button click with UTM

  // Booking Management
  app.post('/api/campaign-bookings/manual', createBookingManually); // Create booking manually
  app.post('/api/leads/bulk-create', bulkCreateLeads); // Bulk create leads from CSV
  app.get('/api/campaign-bookings', getAllBookings); // Get all bookings (legacy)
  app.get('/api/campaign-bookings/paginated', getAllBookingsPaginated); // Get paginated bookings with filters
  app.get('/api/campaign-bookings/today', getMeetingsBookedToday); // Get meetings booked today
  app.get('/api/campaign-bookings/by-date', getMeetingsByDate); // Get meetings by date
  app.get('/api/campaign-bookings/debug/all', async (req, res) => {
    // DEBUG ENDPOINT - Shows ALL bookings with full details
    try {
      const { CampaignBookingModel } = await import('./Schema_Models/CampaignBooking.js');
      const bookings = await CampaignBookingModel.find().sort({ bookingCreatedAt: -1 }).limit(20);
      return res.status(200).json({
        success: true,
        count: bookings.length,
        bookings: bookings.map(b => ({
          bookingId: b.bookingId,
          campaignId: b.campaignId,
          utmSource: b.utmSource,
          clientName: b.clientName,
          clientEmail: b.clientEmail,
          clientPhone: b.clientPhone,
          calendlyMeetLink: b.calendlyMeetLink,
          scheduledEventStartTime: b.scheduledEventStartTime,
          bookingCreatedAt: b.bookingCreatedAt,
          bookingStatus: b.bookingStatus
        }))
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });
  app.get('/api/campaign-bookings/:bookingId', getBookingById); // Get specific booking
  app.get('/api/campaign-bookings/email/:email', getBookingsByEmail); // Get bookings by email
  app.put('/api/campaign-bookings/:bookingId/status', updateBookingStatus); // Update booking status
  app.post('/api/campaign-bookings/:bookingId/reschedule', rescheduleBooking); // Reschedule booking and refresh queue
  app.put('/api/campaign-bookings/:bookingId/notes', updateBookingNotes); // Update booking notes
  app.put('/api/campaign-bookings/:bookingId/amount', updateBookingAmount); // Update booking amount (leads only)
  app.post('/api/campaign-bookings/:bookingId/follow-up', ScheduleFollowUp); // Schedule follow-up (email, call, WhatsApp)
  app.post('/api/campaign-bookings/frontend-capture', captureFrontendBooking); // Capture from frontend (backup)
  app.get('/api/leads/paginated', getLeadsPaginated); // Get paginated leads (paid bookings only)

  // Microservice Integration
  app.get('/api/campaign-bookings/export', exportBookingsForMicroservice); // Export bookings
  app.post('/api/campaign-bookings/mark-synced', markBookingsAsSynced); // Mark as synced
  app.post('/api/microservice/paid', handlePaidClientFromMicroservice); // Handle paid client webhook from microservice

  // ==================== WEBHOOK ROUTES ====================
  // Calendly Webhooks
  app.post('/api/webhooks/calendly', handleCalendlyWebhook); // Handle Calendly webhook events
  app.get('/api/webhooks/test', testWebhook); // Test webhook functionality

  // ==================== PAYMENT REMINDER ROUTES ====================
  app.post('/api/payment-reminders', schedulePaymentReminder); // Schedule payment reminder
  app.get('/api/payment-reminders/:bookingId', getPaymentReminders); // Get scheduled reminders for booking
  app.delete('/api/payment-reminders/:jobId', cancelPaymentReminder); // Cancel scheduled reminder

  // ==================== PAYMENT ROUTES ====================
  app.post('/api/payments', createPayment); // Create new payment record
  app.get('/api/payments', getAllPayments); // Get all payments
  app.get('/api/payments/:paymentId', getPaymentById); // Get payment by ID
  app.get('/api/payments/email/:email', getPaymentsByEmail); // Get payments by customer email

  // ==================== WHATSAPP MESSAGING ROUTES ====================
  app.get('/api/whatsapp/message-types', getMessageTypes); // Get available message types
  app.post('/api/whatsapp/send-message', sendMessage); // Send WhatsApp message
  app.get('/api/whatsapp/test', testConnection); // Test WhatsApp connection
  app.post('/api/whatsapp/send-simple', sendSimpleMessage); // Send simple WhatsApp message (mobile + message only)

  // ==================== WORKFLOW ROUTES ====================
  app.post('/api/workflows', createWorkflow); // Create new workflow
  app.get('/api/workflows', getAllWorkflows); // Get all workflows
  app.get('/api/workflows/:workflowId', getWorkflowById); // Get workflow by ID
  app.put('/api/workflows/:workflowId', updateWorkflow); // Update workflow
  app.delete('/api/workflows/:workflowId', deleteWorkflow); // Delete workflow
  app.post('/api/workflows/process-scheduled', processScheduledWorkflows); // Process scheduled workflows (cron job)
  app.get('/api/workflows/bulk/bookings-by-status', getBookingsByStatusForBulk); // Get bookings by status for bulk actions
  app.post('/api/workflows/bulk/trigger-by-status', triggerWorkflowsForAllByStatus); // Trigger workflows for all bookings with status

  // ==================== WORKFLOW LOG ROUTES ====================
  app.get('/api/workflow-logs', getWorkflowLogs); // Get workflow logs with pagination
  app.get('/api/workflow-logs/stats', getWorkflowLogStats); // Get workflow log statistics
  app.get('/api/workflow-logs/:logId', getWorkflowLogById); // Get workflow log by ID
  app.post('/api/workflow-logs/:logId/send-now', sendWorkflowLogNow); // Send workflow log email immediately

  app.get('/details', renderDashboard);
  app.get('/api/dashboard/data', getDashboardData);
  app.post('/api/dashboard/send-now', sendNow);

  // // Handle Gather result
  // app.post("/twilio/response", (req, res) => {
  //   const VoiceResponse = twilio.twiml.VoiceResponse;
  //   const twiml = new VoiceResponse();

  //   const digit = (req.body?.Digits || "").trim();
  //   if (digit === "1") {
  //     twiml.say("Great. See you in the meeting. Goodbye!");
  //   } else {
  //     twiml.say("Input received. Goodbye!");
  //   }
  //   res.status(200).type("text/xml").send(twiml.toString());
  // });

  // app.post('/sendReminderEmail', SendEmailReminder);
}

// LoginVerifier, LocalTokenValidator
// LoginVerifier, LocalTokenValidator
