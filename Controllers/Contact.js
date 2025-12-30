import { ContactUsModel } from "../Schema_Models/ContactUs.js";
import { DiscordConnect } from "../Utils/DiscordConnect.js";
import dotenv from 'dotenv';

dotenv.config();

export default async function Contact(req, res) {
    try {
        const { fullName, email, company, phone, message, workAuthorization } = req.body;

        if (!fullName || !email || !message) {
            return res.status(400).json({ 
                error: "Missing required fields. Please provide fullName, email, and message." 
            });
        }

        const contactData = {
            fullName,
            email,
            company: company || '',
            phone: phone || '',
            message,
            workAuthorization: workAuthorization || ''
        };

        const savedContact = await ContactUsModel.create(contactData);

        const discordMessage = {
            "Message": "📧 New Contact Form Submission - Contact This Lead",
            "Source": "Contact Us Page",
            "Client Name": fullName,
            "Client E-Mail": email,
            "Client Mobile": phone || "Not provided",
            "Work Authorization": workAuthorization || "Not provided",
            "Company": company || "Not provided",
            "Message": message.substring(0, 200) + (message.length > 200 ? "..." : "")
        };

        try {
            await DiscordConnect(
                process.env.DISCORD_WEB_HOOK_URL,
                JSON.stringify(discordMessage, null, 2)
            );
            console.log('✅ Contact form notification sent to Discord');
        } catch (discordError) {
            console.error('❌ Failed to send Discord notification:', discordError);
        }

        return res.status(201).json({ 
            success: true,
            message: "Contact form submitted successfully." 
        });

    } catch (error) {
        console.error('❌ Error processing contact form:', error);
        return res.status(500).json({ 
            error: "Failed to submit contact form. Please try again later." 
        });
    }
}
