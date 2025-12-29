import {ContactUsWebsiteModel} from "../Schema_Models/ContactUsWebsite.js";

export default async function Contact(req, res) {
    try {
        const {fullName, email, company, phone, message} = req.body;
        
        // Validate required fields
        if (!fullName || !email || !message) {
            return res.status(400).json({ 
                error: "Missing required fields. Please provide fullName, email, and message." 
            });
        }

        // Create new contact us entry in the database
        await ContactUsWebsiteModel.create({
            fullName,
            email,
            company: company || '',
            phone: phone || '',
            message
        });
        
        return res.status(201).json({ message: "Contact form submitted successfully." });
       
    } catch (error) {
        console.error('Error in Contact controller:', error);
        return res.status(500).json({ 
            error: "Internal server error. Please try again later." 
        });
    }
}
