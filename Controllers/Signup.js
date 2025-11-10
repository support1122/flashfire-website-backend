import { UserModel } from "../Schema_Models/User.js";

export default async function Signup(req, res) {
    try {
        const { name, email, mobile, workAuthorization } = req.body;
        
        let phone = mobile || '';
        let countryCode = '+1'; 
        
        if (mobile && mobile.startsWith('+')) {
            if (mobile.startsWith('+1')) {
                countryCode = '+1';
            } else if (mobile.startsWith('+91')) {
                countryCode = '+91';
            } else {
                const match = mobile.match(/^\+(\d{1,3})/);
                if (match) {
                    countryCode = '+' + match[1];
                }
            }
            phone = mobile; 
        }
        
        await UserModel.create({
            fullName: name || 'Not Specified',
            email: email || 'Not Specified',
            phone: phone,
            countryCode: countryCode,
            workAuthorization: workAuthorization || 'Not Specified'
        });
        
        return res.status(201).json({ 
            message: "Signup successful. User details saved.",
            success: true
        });
       
    } catch (error) {
        console.error('Error in Signup controller:', error);
        return res.status(500).json({ 
            message: "Server error occurred",
            success: false,
            error: error.message 
        });
    }
}

