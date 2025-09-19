// import { InterestedClientsModel } from "../Schema_Models/InterestedClients.js";
// import dotenv from 'dotenv'
// import { DiscordConnect } from "../Utils/DiscordConnect.js";
// import { appendToGoogleSheet } from "../Utils/GoogleSheetsHelper.js";
// dotenv.config();
// export default async function VerifyInterestedClient(req, res, next){
//     console.log("req.body:",req.body);
//     try {
//         await appendToGoogleSheet({name : req.body.name,
//                                     email : req.body.email,
//                                     mobile : req.body.mobile,
//                                     timestamp : new Date().toLocaleString('en-IN',{timeZone : 'Asia/Kolkata'})                   
//                                 });
//         // console.log('data added to ggogle sheets');
//         //first checking for the email and mobile in the database..
//         let checkingInDatabaseForEmail = await InterestedClientsModel.find({email : req.body.email});
//         let checkingInDatabaseForMobile = await InterestedClientsModel.find({mobile : req.body.mobile});
//         //if both the mobile and email entered by the user doesnot already exists in our database.........
//         if( checkingInDatabaseForEmail.length == 0 && checkingInDatabaseForMobile.length == 0){
//             let checkEmail = await fetch(`https://emailvalidation.abstractapi.com/v1/?api_key=${process.env.ABSTRACT_API_EMAIL_VERIFICATION_API_KEY}&email=${req.body.email}`);
//             let responseCheckEmail = await checkEmail.json();
//             console.log(responseCheckEmail);

//             let checkMobile = await fetch(`https://phonevalidation.abstractapi.com/v1/?api_key=${process.env.ABSTRACT_API_MOBILE_VERIFICATION_API_KEY}&phone=${req.body.mobile}`)
//             let responseCheckMobile = await checkMobile.json();
//             console.log(responseCheckMobile);
//             //we verify if the number and email are real or fake..........
//             //this if checks when both number and email are valid......
//             if((responseCheckMobile?.carrier !=='' && responseCheckMobile?.location !=='') && responseCheckEmail?.is_smtp_valid?.value){
//                 //here we attach the verification details to body so that the controller should not work again for this..
//                 req.body.carrier = responseCheckMobile?.carrier;
//                 req.body.location = responseCheckMobile?.location;
//                 req.body.is_smtp_valid = responseCheckEmail?.is_smtp_valid?.value;
//                 next();
//                 return;
//             }
//             //this if condition checks when the mobile is invalid and the email is valid..
//            else if((responseCheckMobile?.carrier == '' || responseCheckMobile?.location == ''  ) && responseCheckEmail?.is_smtp_valid?.value ){
//             //again we attach the valid details for the controller...
//             req.body.is_smtp_valid = responseCheckEmail?.is_smtp_valid?.value;
//             req.body.carrier = responseCheckMobile?.carrier;
//             req.body.location = responseCheckMobile?.location;
//             next();
//             return;
//            }
//            //this if check when email is invalid and mobile is valid..
//            else if((responseCheckMobile?.carrier !== '' && responseCheckMobile?.location !== ''  ) && !responseCheckEmail?.is_smtp_valid?.value) { 
//             //again we attach the valid details for the controller...
//             req.body.carrier = responseCheckMobile?.carrier;
//             req.body.location = responseCheckMobile?.location;
//             next();
//             return;
//            }
//            // if none of the if block trigger then we give the message to enter the details properly..
//            else{
//             return res.status(400).json({message : 'enter details correctly..!'});
//            }            
//         }
//         //this outer if block checks when we already have an record with the same mobile but we dont have the record for email..
//         else if(checkingInDatabaseForEmail.length == 0 && checkingInDatabaseForMobile.length > 0){
//             let checkEmail = await fetch(`https://emailvalidation.abstractapi.com/v1/?api_key=${process.env.ABSTRACT_API_EMAIL_VERIFICATION_API_KEY}&email=${req.body.email}`);
//             let responseCheckEmail = await checkEmail.json();
//             console.log(responseCheckEmail);
//             let checkMobile = await fetch(`https://phonevalidation.abstractapi.com/v1/?api_key=${process.env.ABSTRACT_API_MOBILE_VERIFICATION_API_KEY}&phone=${req.body.mobile}`)
//             let responseCheckMobile = await checkMobile.json();
//             console.log(responseCheckMobile);
//             //verifies through api and attaches to request.body for controller....
//             req.body.carrier = responseCheckMobile?.carrier;
//             req.body.location = responseCheckMobile?.location;
//             req.body.is_smtp_valid = responseCheckEmail?.is_smtp_valid?.value;
//             next();
//             return;
//         }
//         //if none of the outer if gets triggered then this else will be triggered..
//         else{
//             //this if checks if the user entered a email and phone number that alrady exists in db
//             //in this we should not store anything in the DB but allow the user to continue to book a session..
//             //here the handling challange is mostly in the frontend..
//             if(checkingInDatabaseForEmail?.length > 0 && checkingInDatabaseForMobile.length > 0){
//                 let duplicateMessage = {
//                     "Message" : "Duplicate user detected..!",
//                     "Duplicate Values" : {
//                         "Duplicate Client Name" : req.body.name,
//                         "Duplicate Client Email" : req.body.email,
//                         "Duplicate Client Mobile" :req.body.mobile,
//                     },
//                     "Original/ Old Values":{
//                         "Client Name" :checkingInDatabaseForEmail?.[0].name,
//                         "Client Email":checkingInDatabaseForEmail?.[0].email,
//                         "Client Mobile" : checkingInDatabaseForEmail?.[0].mobile
                        
//                     }
//                 }
//                 DiscordConnect(JSON.stringify(duplicateMessage, null, 2))
//                 return res.status(400).json({message : 'User already exist with this Email and Mobile No.'});
//             }
//             //this if is checked when the email user enters already exists in the database and phone is not there in the DB
//             else if(checkingInDatabaseForEmail?.length > 0 && checkingInDatabaseForMobile.length == 0){
//                 let duplicateMessage = {
//                     "Message" : "duplicate user detected..!",
//                     "Duplicate Values":{
//                         "Duplicate Client Name" : req.body.name,
//                         "Duplicate Client Email" : req.body.email,
//                     },
//                     "Original/ Old Values":{
//                         "Client Name" :checkingInDatabaseForEmail?.[0].name,
//                         "Client Email":checkingInDatabaseForEmail?.[0].email,                
//                     }
                    
//                 }
//                 DiscordConnect(JSON.stringify(duplicateMessage, null, 2));
//                 return res.status(400).json({message : 'User already exist with this Email '});       
            
//             }     
//         }    
//     } catch (error) {
//         console.log(error)
//     }   
// }
import { InterestedClientsModel } from "../Schema_Models/InterestedClients.js";
import dotenv from 'dotenv';
import axios from 'axios';
import https from 'https';
import { DiscordConnect } from "../Utils/DiscordConnect.js";
import { appendToGoogleSheet } from "../Utils/GoogleSheetsHelper.js";
dotenv.config();

const isDev = process.env.NODE_ENV !== 'production';
const httpsAgent = new https.Agent({ rejectUnauthorized: !isDev });

//         const validateEmail = async (email) => {
//             try {
//                 const res = await axios.get(`https://emailvalidation.abstractapi.com/v1/`, {
//                     params: {
//                         api_key: process.env.ABSTRACT_API_EMAIL_VERIFICATION_API_KEY,
//                         email
//                     },
//                     httpsAgent,
//                     headers: {
//                         'User-Agent': 'FlashFire/1.0'
//                     }});
//             return res.data;

//             } catch (error) {
//                 console.log(error)
//             }
    
// };
const validateEmail = async (email) => {
  try {
    const res = await axios.get("https://api.kickbox.com/v2/verify", {
      params: {
        email,
        apikey: process.env.KICKBOX_API_KEY, // your Kickbox API key here
      },
      httpsAgent,
      headers: {
        "User-Agent": "FlashFire/1.0",
      },
    });
    console.log(res.data);
    return res.data; // same style as before
  } catch (error) {
    console.log(error);
  }
};

        const validateMobile = async (phone) => {
            try {
                const res = await axios.get(`https://phonevalidation.abstractapi.com/v1/`, {
                    params: {
                        api_key: process.env.ABSTRACT_API_MOBILE_VERIFICATION_API_KEY,
                        phone
                    },
                    httpsAgent,
                    headers: {
                        'User-Agent': 'FlashFire/1.0'
                    }});
            return res.data;
                
            } catch (error) {
                console.log(error)
            }
    
};
//
export default async function VerifyInterestedClient(req, res, next){
    console.log("req.body:", req.body);
    try {
        await appendToGoogleSheet({
            name: req.body.name,
            email: req.body.email,
            mobile: req.body.mobile,
            timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
        });
      if(req.body.email =='' && req.body.mobile == '' && req.body.name ==''){
        return;
      }

        const checkingInDatabaseForEmail = await InterestedClientsModel.find({ email: req.body.email });
        const checkingInDatabaseForMobile = await InterestedClientsModel.find({ mobile: req.body.mobile });


        if (checkingInDatabaseForEmail.length === 0 && checkingInDatabaseForMobile.length === 0) {
            const responseCheckEmail = await validateEmail(req.body.email);
            const responseCheckMobile = await validateMobile(req.body.mobile);
            console.log(responseCheckEmail, responseCheckMobile);

            const isMobileValid = responseCheckMobile?.carrier !== '' && responseCheckMobile?.location !== '';
            const isEmailValid = responseCheckEmail?.result=='deliverable';

            req.body.carrier = responseCheckMobile?.carrier;
            req.body.location = responseCheckMobile?.location;
            req.body.is_smtp_valid = isEmailValid;

            if (isMobileValid && isEmailValid) return next();
            else if (!isMobileValid && isEmailValid) return next();
            else if (isMobileValid && !isEmailValid) return next();
            else return res.status(400).json({ message: 'Enter details correctly..!' });

        } else if (checkingInDatabaseForEmail.length === 0 && checkingInDatabaseForMobile.length > 0) {
            const responseCheckEmail = await validateEmail(req.body.email);
            const responseCheckMobile = await validateMobile(req.body.mobile);

            req.body.carrier = responseCheckMobile?.carrier;
            req.body.location = responseCheckMobile?.location;
            req.body.is_smtp_valid = responseCheckEmail?.result=='deliverable';
            return next();
        } else {
            if (checkingInDatabaseForEmail.length > 0 && checkingInDatabaseForMobile.length > 0) {
                const duplicateMessage = {
                    Message: "Duplicate user detected..!",
                    "Duplicate Values": {
                        "Duplicate Client Name": req.body.name,
                        "Duplicate Client Email": req.body.email,
                        "Duplicate Client Mobile": req.body.mobile,
                    },
                    "Original/ Old Values": {
                        "Client Name": checkingInDatabaseForEmail?.[0].name,
                        "Client Email": checkingInDatabaseForEmail?.[0].email,
                        "Client Mobile": checkingInDatabaseForEmail?.[0].mobile
                    }
                };
                // DiscordConnect(JSON.stringify(duplicateMessage, null, 2));
              await DiscordConnect(process.env.DISCORD_WEB_HOOK_URL,JSON.stringify(duplicateMessage, null, 2));
                return res.status(400).json({ message: 'User already exists with this Email and Mobile No.' });
            } else if (checkingInDatabaseForEmail.length > 0 && checkingInDatabaseForMobile.length === 0) {
                const duplicateMessage = {
                    Message: "Duplicate user detected..!",
                    "Duplicate Values": {
                        "Duplicate Client Name": req.body.name,
                        "Duplicate Client Email": req.body.email,
                    },
                    "Original/ Old Values": {
                        "Client Name": checkingInDatabaseForEmail?.[0].name,
                        "Client Email": checkingInDatabaseForEmail?.[0].email,
                    }
                };
                // DiscordConnect(JSON.stringify(duplicateMessage, null, 2));
                await DiscordConnect(process.env.DISCORD_WEB_HOOK_URL,JSON.stringify(duplicateMessage, null, 2));
                return res.status(400).json({ message: 'User already exists with this Email' });
            }
        }
    } catch (error) {
    console.error("❌ Error in VerifyInterestedClient:", error.message);
    if (error.response) {
        console.error("🚨 API Response Error:", error.response.data);
    }
    return res.status(500).json({ message: "Internal Server Error in verification." });
}
}


