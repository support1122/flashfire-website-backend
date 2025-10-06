import { Logger } from '../Utils/Logger.js';
import { sendWhatsAppMessage } from '../Utils/WatiHelper.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { callQueue } from '../Utils/queue.js';


export const schedulePaymentReminder = async (req, res) => {
  try {
    const { bookingId, clientName, clientPhone, paymentLink, reminderDays } = req.body;

    // Validate required fields
    if (!bookingId || !clientName || !clientPhone || !paymentLink || !reminderDays) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: bookingId, clientName, clientPhone, paymentLink, reminderDays'
      });
    }

    // Validate reminder days (1-30)
    if (reminderDays < 1 || reminderDays > 30) {
      return res.status(400).json({
        success: false,
        message: 'Reminder days must be between 1 and 30'
      });
    }

    // Validate payment link format
    try {
      new URL(paymentLink);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment link format'
      });
    }

    // Find the booking record
    const booking = await CampaignBookingModel.findOne({ bookingId });
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Calculate the delay in milliseconds (days * 24 * 60 * 60 * 1000)
    const delayMs = reminderDays * 24 * 60 * 60 * 1000;
    const scheduledTime = new Date(Date.now() + delayMs);

    // Create payment reminder job data
    const jobData = {
      type: 'payment_reminder',
      bookingId,
      clientName,
      clientPhone,
      paymentLink,
      scheduledTime: scheduledTime.toISOString(),
      reminderDays
    };

    // Add job to queue with delay
    const job = await callQueue.add('payment-reminder', jobData, {
      delay: delayMs,
      removeOnComplete: 10,
      removeOnFail: 5,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    });

    // Update booking record with payment reminder info
    const paymentReminderData = {
      jobId: job.id.toString(),
      paymentLink,
      reminderDays,
      scheduledTime,
      status: 'scheduled'
    };

    await CampaignBookingModel.findOneAndUpdate(
      { bookingId },
      { $push: { paymentReminders: paymentReminderData } },
      { upsert: false }
    );

    Logger.info('Payment reminder scheduled successfully', {
      bookingId,
      clientName,
      clientPhone,
      reminderDays,
      scheduledTime: scheduledTime.toISOString(),
      jobId: job.id
    });

    res.status(200).json({
      success: true,
      message: 'Payment reminder scheduled successfully',
      data: {
        bookingId,
        clientName,
        reminderDays,
        scheduledTime: scheduledTime.toISOString(),
        jobId: job.id
      }
    });

  } catch (error) {
    Logger.error('Error scheduling payment reminder', {
      error: error.message,
      stack: error.stack,
      body: req.body
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error scheduling payment reminder'
    });
  }
};


export const getPaymentReminders = async (req, res) => {
  try {
    const { bookingId } = req.params;

    // Find booking with payment reminders
    const booking = await CampaignBookingModel.findOne({ bookingId });
    
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    const reminders = booking.paymentReminders || [];

    res.status(200).json({
      success: true,
      data: {
        bookingId,
        reminders
      }
    });

  } catch (error) {
    Logger.error('Error getting payment reminders', {
      error: error.message,
      stack: error.stack,
      bookingId: req.params.bookingId
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error getting payment reminders'
    });
  }
};

/**
 * Cancel a scheduled payment reminder
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const cancelPaymentReminder = async (req, res) => {
  try {
    const { jobId } = req.params;

    // Remove job from queue
    const job = await callQueue.getJob(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Payment reminder job not found'
      });
    }

    const { bookingId } = job.data;
    await job.remove();

    // Update database to mark reminder as cancelled
    await CampaignBookingModel.findOneAndUpdate(
      { 
        bookingId,
        'paymentReminders.jobId': jobId
      },
      { 
        $set: { 
          'paymentReminders.$.status': 'cancelled'
        }
      }
    );

    Logger.info('Payment reminder cancelled successfully', {
      jobId,
      bookingId
    });

    res.status(200).json({
      success: true,
      message: 'Payment reminder cancelled successfully',
      data: {
        jobId,
        bookingId
      }
    });

  } catch (error) {
    Logger.error('Error cancelling payment reminder', {
      error: error.message,
      stack: error.stack,
      jobId: req.params.jobId
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error cancelling payment reminder'
    });
  }
};
