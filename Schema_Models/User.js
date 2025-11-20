import mongoose from 'mongoose'

export const UserSchema = new mongoose.Schema({
    fullName: {
        type: String,
        required: true,
        default: 'Not Specified'
    },
    email: {
        type: String,
        required: true,
        default: 'Not Specified'
    },
    phone: {
        type: String,
        required: true,
        default: 'Not Specified'
    },
    countryCode: {
        type: String,
        default: '+1'
    },
    workAuthorization: {
        type: String,
        required: true,
        default: 'Not Specified'
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    booked: {
        type: Boolean,
        default: false
    }
})

export const UserModel = mongoose.model('User', UserSchema);

