import mongoose from 'mongoose'

export const ContactUsSchema = new mongoose.Schema({
    firstName : {
        type: String,
        required : true,
        default : 'Not Specified'
    },
    lastName :{
        type: String,
        required : true,
        default : 'Not Specified'
    },
    email : {
        type: String,
        required : true,
        default : 'Not Specified'
    },
    message : {
        type: String,
        required : true,
        default : 'Not Specified'
    },
    currentRole : {
        type: String,
        required : true,
        default : 'Not Specified'
    }
})

export const ContactUsModel = mongoose.model('ContactUs', ContactUsSchema);