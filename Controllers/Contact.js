import {ContactUsWebsiteModel} from "../Schema_Models/ContactUsWebsite.js";

export default async function Contact(req, res) {
    try {
        console.log('Contact form endpoint hit');
        console.log('Request body:', req.body);
        
        const {fullName, email, company, phone, message} = req.body;
        
        // Validate required fields
        if (!fullName || !email || !message) {
            console.log('Validation failed - missing required fields');
            return res.status(400).json({ 
                error: "Missing required fields. Please provide fullName, email, and message." 
            });
        }

        console.log('Creating contact entry in database...');
        
        // Create new contact us entry in the database
        const savedContact = await ContactUsWebsiteModel.create({
            fullName,
            email,
            company: company || '',
            phone: phone || '',
            message
        });
        
        console.log('Contact entry saved successfully:', savedContact._id);
        
        return res.status(201).json({ 
            message: "Contact form submitted successfully.",
            id: savedContact._id
        });
       
    } catch (error) {
        console.error('Error in Contact controller:', error);
        console.error('Error stack:', error.stack);
        return res.status(500).json({ 
            error: "Internal server error. Please try again later.",
            details: error.message
        });
    }
}
