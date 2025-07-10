import mongoose from "mongoose";



export const InterestedClientsSchema = new mongoose.Schema({
    name : {
        type : String,
        required : true, 
        default : '<UNNAMED USER>'
    },
    email : {
        type : String,
        default : '<UNKNOWN EMAIL>',
        // unique : true
    },
    mobile : {
        type : String,
        default : ' '
    },
    time : {
        type: String,
        default : ()=>new Date(),
        required : true
    },
    workAuthorization : {
        type : String,
        default : ' '
    }
    
});
 export const InterestedClientsModel = mongoose.model('InterestedClientList', InterestedClientsSchema  )