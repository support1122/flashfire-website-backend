import mongoose from 'mongoose'

export const ContactUsSchema = new mongoose.Schema({
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
        default: ''
    },
    phone: {
        type: String,
        default: ''
    },
    message: {
        type: String,
        required: true
    },
    workAuthorization: {
        type: String,
        default: ''
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
})

export const ContactUsModel = mongoose.model('ContactUs', ContactUsSchema);