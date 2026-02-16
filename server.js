require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');

// --- TWILIO INITIALIZATION ---
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
const client = require('twilio')(accountSid, authToken);

const User = require('./models/User');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ DB Error:", err));

// ==========================================
// 👤 REAL TWILIO AUTH ROUTES
// ==========================================

// 1. Send OTP via Twilio
app.post('/api/send-otp', async (req, res) => {
    let { phone } = req.body;
    
    if (!phone) return res.status(400).json({ message: "Phone number required" });

    // ✅ FIX: Auto-format to E.164 (+91 format)
    // Remove any spaces or dashes first
    let cleanPhone = phone.replace(/[\s-]/g, '');
    
    // If it's a 10-digit number, add +91
    if (cleanPhone.length === 10 && !cleanPhone.startsWith('+')) {
        cleanPhone = `+91${cleanPhone}`;
    } 
    // If it starts with 91 but no +, add +
    else if (cleanPhone.length === 12 && cleanPhone.startsWith('91')) {
        cleanPhone = `+${cleanPhone}`;
    }

    try {
        console.log(`[Twilio] Attempting to send OTP to: ${cleanPhone}`);
        
        const verification = await client.verify.v2.services(verifyServiceSid)
            .verifications
            .create({ to: cleanPhone, channel: 'sms' });

        res.json({ success: true, message: "OTP Sent Successfully" });
    } catch (error) {
        console.error("❌ Twilio Send Error:", error.message);
        // Specifically catch the "Invalid Parameter" error to give a better message
        if (error.code === 60200) {
            return res.status(400).json({ message: "Invalid phone number format. Use +91xxxxxxxxxx" });
        }
        res.status(500).json({ message: "Failed to send OTP", error: error.message });
    }
});

// 2. Verify OTP via Twilio
app.post('/api/verify-otp', async (req, res) => {
    let { phone, otp } = req.body;

    if (!phone || !otp) return res.status(400).json({ message: "Phone and OTP required" });

    // ✅ FIX: Re-apply formatting here to match the 'To' sent originally
    let cleanPhone = phone.replace(/[\s-]/g, '');
    if (cleanPhone.length === 10 && !cleanPhone.startsWith('+')) cleanPhone = `+91${cleanPhone}`;
    else if (cleanPhone.length === 12 && cleanPhone.startsWith('91')) cleanPhone = `+${cleanPhone}`;

    try {
        const verificationCheck = await client.verify.v2.services(verifyServiceSid)
            .verificationChecks
            .create({ to: cleanPhone, code: otp });

        if (verificationCheck.status === 'approved') {
            const user = await User.findOne({ phone: cleanPhone });
            
            if (user) {
                return res.json({ message: "Login Success", isNewUser: false, user });
            } else {
                return res.json({ message: "OTP Verified", isNewUser: true });
            }
        } else {
            res.status(400).json({ message: "Invalid or Expired OTP" });
        }
    } catch (error) {
        console.error("❌ Twilio Verify Error:", error.message);
        res.status(500).json({ message: "Verification process failed" });
    }
});

// ==========================================
// 👤 USER PROFILE & REGISTRATION
// ==========================================

app.post('/api/complete-profile', async (req, res) => {
    try {
        let { name, phone, email, age, gender } = req.body;
        
        // Format phone before saving to DB
        if (phone.length === 10 && !phone.startsWith('+')) phone = `+91${phone}`;

        let user = await User.findOne({ phone });
        if (user) return res.status(400).json({ message: "User already exists" });

        const newUser = new User({ 
            name, phone, email, age, gender, 
            enrolledCourses: [],
            role: 'student' 
        });

        await newUser.save();
        res.status(201).json({ message: "Profile Created", user: newUser });
    } catch (err) {
        res.status(500).json({ message: "Error saving profile" });
    }
});

app.get('/api/user/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id)
            .populate({
                path: 'enrolledCourses.item', 
                select: 'title thumbnail bannerImage slug schedule liveStartDate pricing meetingLink' 
            });
        if (!user) return res.status(404).json({ message: "User not found" });
        res.json(user);
    } catch (err) { res.status(500).json({ message: "Server Error" }); }
});

app.use('/api/masterclasses', require('./routes/paymentMasterclass'));
app.use('/api/courses', require('./routes/courseRoutes'));
app.use('/api/coupons', require('./routes/couponRoutes'));

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));