import mongoose from 'mongoose'

export const ContactUsWebsiteSchema = new mongoose.Schema({
    fullName: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true
    },
    company: {
        type: String,
        required: false
    },
    phone: {
        type: String,
        required: false
    },
    message: {
        type: String,
        required: true
    }
}, {
    timestamps: true // This will add createdAt and updatedAt fields automatically
})

// Use the collection name 'contact_us_website' explicitly
export const ContactUsWebsiteModel = mongoose.model('ContactUsWebsite', ContactUsWebsiteSchema, 'contact_us_website');

