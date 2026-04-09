import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { CampaignModel } from '../Schema_Models/Campaign.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file from parent directory
dotenv.config({ path: path.join(__dirname, '..', '.env') });

/**
 * Migration Script: Assign all bookings with null campaignId to default Calendly campaign
 * 
 * This script will:
 * 1. Find or create a default "Calendly Direct Bookings" campaign
 * 2. Find all bookings with campaignId: null
 * 3. Update them to use the default Calendly campaign ID
 */

async function migrateNullCampaignBookings() {
  try {
    console.log('🔄 Starting migration of null campaign bookings...\n');

    // Connect to MongoDB
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI is not defined in .env file');
    }
    
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Step 1: Get or create default Calendly campaign
    let defaultCampaign = await CampaignModel.findOne({ utmSource: 'calendly_direct' });
    
    if (!defaultCampaign) {
      console.log('📝 Creating default Calendly campaign...');
      defaultCampaign = new CampaignModel({
        campaignName: 'Calendly Direct Bookings',
        utmSource: 'ajrocks',
        utmMedium: 'email',
        utmCampaign: 'direct_booking',
        generatedUrl: 'https://calendly.com/feedback-flashfire/15min?utm_source=ajrocks&utm_medium=email&utm_campaign=direct_booking',
        baseUrl: 'https://www.flashfirejobs.com',
        createdBy: 'system'
      });
      await defaultCampaign.save();
      console.log('✅ Default Calendly campaign created');
      console.log(`   Campaign ID: ${defaultCampaign.campaignId}`);
      console.log(`   Campaign Name: ${defaultCampaign.campaignName}\n`);
    } else {
      console.log('✅ Default Calendly campaign already exists');
      console.log(`   Campaign ID: ${defaultCampaign.campaignId}`);
      console.log(`   Campaign Name: ${defaultCampaign.campaignName}\n`);
    }

    // Step 2: Find all bookings with null campaignId
    const nullCampaignBookings = await CampaignBookingModel.find({ 
      campaignId: null 
    });

    console.log(`📊 Found ${nullCampaignBookings.length} bookings with null campaignId\n`);

    if (nullCampaignBookings.length === 0) {
      console.log('✅ No bookings to migrate. All bookings already have campaigns assigned.\n');
      await mongoose.connection.close();
      return;
    }

    // Step 3: Update all null campaign bookings
    console.log('🔄 Updating bookings...');
    
    const updateResult = await CampaignBookingModel.updateMany(
      { campaignId: null },
      { 
        $set: { 
          campaignId: defaultCampaign.campaignId 
        } 
      }
    );

    console.log(`✅ Migration completed!`);
    console.log(`   Matched: ${updateResult.matchedCount} bookings`);
    console.log(`   Modified: ${updateResult.modifiedCount} bookings`);
    console.log(`   All bookings with null campaignId have been assigned to: "${defaultCampaign.campaignName}"\n`);

    // Step 4: Verify the migration
    const remainingNullBookings = await CampaignBookingModel.countDocuments({ 
      campaignId: null 
    });

    if (remainingNullBookings === 0) {
      console.log('✅ Verification passed: No bookings with null campaignId remaining\n');
    } else {
      console.log(`⚠️  Warning: ${remainingNullBookings} bookings still have null campaignId\n`);
    }

    // Show some sample updated bookings
    const sampleBookings = await CampaignBookingModel.find({
      campaignId: defaultCampaign.campaignId
    }).limit(5).select('bookingId clientName clientEmail campaignId utmSource createdAt');

    console.log('📋 Sample updated bookings:');
    sampleBookings.forEach((booking, index) => {
      console.log(`   ${index + 1}. ${booking.clientName} (${booking.clientEmail})`);
      console.log(`      Booking ID: ${booking.bookingId}`);
      console.log(`      Campaign ID: ${booking.campaignId}`);
      console.log(`      UTM Source: ${booking.utmSource}`);
      console.log(`      Created: ${booking.createdAt.toLocaleString()}\n`);
    });

    // Close connection
    await mongoose.connection.close();
    console.log('✅ Database connection closed');
    console.log('🎉 Migration completed successfully!');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

// Run the migration
migrateNullCampaignBookings();

