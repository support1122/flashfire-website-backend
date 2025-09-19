import { sendWelcomeEmail } from "../Utils/SendGridHelper.js";
export default async function SendEmailReminder(req, res) {
    try {
        const {name, email} = req.body;
        await sendWelcomeEmail(email, name);
        console.log(`reminder sent to :- ${req.body.name} ( ${req.body.email})`);
        
    } catch (error) {
        console.log(error);
    }
    
}