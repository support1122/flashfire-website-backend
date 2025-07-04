import mongoose from 'mongoose'

export const ContactUsSchema = new mongoose.Schema({
    firstName : {
        type: String,

    },
    lastName :{
        type: String,
    },
    email : {
        type: String,
    },
    message : {
        type: String,
    },
    currentRole : {
        type: String,
    }
})

export const ContactUsModel = mongoose.model('ContactUs', ContactUsSchema);