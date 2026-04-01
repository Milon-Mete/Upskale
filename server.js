require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

// 🔴 IMPORT SECURITY MIDDLEWARE
const { requireAuth, adminOnly } = require('./middleware/auth');

// --- TWILIO INITIALIZATION ---
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
const client = require('twilio')(accountSid, authToken);

const User = require('./models/User');
const Course = require('./models/Course');
const Certificate = require('./models/Certificate');
const Cohort = require('./models/Cohort'); 
const Masterclass = require('./models/Masterclass');
const Referral = require('./models/Referral');
const BiteSizeCourse = require('./models/BiteSizeCourse');

const app = express();
const PORT = process.env.PORT || 5000;

// 🔴 SECURE CORS FOR COOKIES
app.use(cors({
    origin: [
        'http://localhost:5173', 
        'https://upskale-demo.netlify.app'
    ],
    credentials: true 
}));
app.use(bodyParser.json());
app.use(cookieParser()); // 🔴 READS COOKIES

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ DB Error:", err));

// ==========================================
// 👤 REAL TWILIO AUTH ROUTES (PUBLIC)
// ==========================================

app.post('/api/send-otp', async (req, res) => {
    let { phone } = req.body;
    
    if (!phone) return res.status(400).json({ message: "Phone number required" });

    let cleanPhone = phone.replace(/[\s-]/g, '');
    if (cleanPhone.length === 10 && !cleanPhone.startsWith('+')) {
        cleanPhone = `+91${cleanPhone}`;
    } else if (cleanPhone.length === 12 && cleanPhone.startsWith('91')) {
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
        if (error.code === 60200) {
            return res.status(400).json({ message: "Invalid phone number format. Use +91xxxxxxxxxx" });
        }
        res.status(500).json({ message: "Failed to send OTP", error: error.message });
    }
});

app.post('/api/verify-otp', async (req, res) => {
    let { phone, otp } = req.body;

    if (!phone || !otp) return res.status(400).json({ message: "Phone and OTP required" });

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
                // 🔴 SET SECURE COOKIE FOR EXISTING USER
                const token = jwt.sign(
                    { id: user._id, role: user.role }, 
                    process.env.JWT_SECRET, 
                    { expiresIn: '7d' }
                );

                res.cookie('jwt', token, {
                    httpOnly: true,
                    secure: process.env.NODE_ENV === 'production',
                    sameSite: 'none',
                    maxAge: 7 * 24 * 60 * 60 * 1000
                });

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
// 👤 USER PROFILE & REGISTRATION (PUBLIC)
// ==========================================

app.post('/api/complete-profile', async (req, res) => {
    try {
        let { name, phone, email, age, gender, referredBy } = req.body; 
        
        if (phone.length === 10 && !phone.startsWith('+')) phone = `+91${phone}`;

        let user = await User.findOne({ phone });
        if (user) return res.status(400).json({ message: "User already exists" });

        const newUser = new User({ 
            name, phone, email, age, gender, 
            referredBy: referredBy || null, 
            enrolledCourses: [], 
            role: 'student' 
        });

        await newUser.save();

        if (referredBy) {
            try {
                await Referral.create({
                    referrerId: referredBy,
                    referredUserId: newUser._id,
                    status: 'pending',
                    rewardEarned: 0
                });
            } catch (refErr) {
                console.error("❌ Failed to create referral record:", refErr.message);
            }
        }

        // 🔴 SET SECURE COOKIE FOR NEW USER
        const token = jwt.sign(
            { id: newUser._id, role: newUser.role }, 
            process.env.JWT_SECRET, 
            { expiresIn: '7d' }
        );

        res.cookie('jwt', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'none',
            maxAge: 7 * 24 * 60 * 60 * 1000 
        });

        res.status(201).json({ message: "Profile Created", user: newUser });
    } catch (err) {
        res.status(500).json({ message: "Error saving profile" });
    }
});

app.post('/api/logout', (req, res) => {
    res.cookie('jwt', '', {
        httpOnly: true,
        expires: new Date(0),
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'none'
    });
    res.json({ success: true, message: 'Logged out successfully' });
});

// ==========================================
// USER & ADMIN QUERIES (SECURED)
// ==========================================

// 🔒 Added requireAuth to protect user data
app.get('/api/user/:id', requireAuth, async (req, res) => {
    try {
        // 1. Prevent users from fetching other users' data (Security Check)
        if (req.user._id.toString() !== req.params.id && req.user.role !== 'admin') {
            return res.status(403).json({ message: "Forbidden. You can only view your own profile." });
        }

        // 2. The Fetching Logic
        const user = await User.findById(req.params.id)
            .populate({
                path: 'enrolledCourses.item', 
                // We select ALL possible fields across ALL models so nothing gets stripped out
                select: 'title highlight image thumbnail bannerImage slug schedule liveStartDate pricing meetingLink' 
            })
            .populate({
                path: 'referredBy', 
                select: 'name _id' 
            });
            
        if (!user) return res.status(404).json({ message: "User not found" });

        // Bypass Mongoose nested-array bugs for certificates by fetching directly
        const myCertificates = await Certificate.find({ user: req.params.id }).sort({ issuedDate: -1 });

        const myReferrals = await Referral.find({ referrerId: req.params.id })
            .populate('referredUserId', 'name _id createdAt') 
            .sort({ createdAt: -1 }); 

        // 3. Assemble the final payload
        const userData = user.toObject();
        userData.referralHistory = myReferrals; 
        userData.earnedCertificates = myCertificates; 

        res.json(userData);
    } catch (err) { 
        console.error(err);
        res.status(500).json({ message: "Server Error" }); 
    }
});

// 🔒 Added adminOnly to prevent massive data leak
app.get('/api/admin/all-users', adminOnly, async (req, res) => {
  try {
    const users = await User.find({})
      .select('-password')
      .populate({ path: 'enrolledCourses.item', select: 'title' })
      .lean();

    const userData = users.map(user => {
      const totalSpent = user.enrolledCourses?.reduce((acc, c) => acc + (c.amountPaid || 0), 0) || 0;

      const allPurchases = user.enrolledCourses?.map(c => ({
          title: c.item ? c.item.title : 'Unknown Item', 
          planType: c.planType || 'recorded',
          score: c.score,
          issuedDate: c.issuedDate,
          type: c.itemModel 
      })) || [];

      return {
        id: user._id,
        name: user.name,
        email: user.email || 'N/A',
        phone: user.phone,
        role: user.role,
        joinedAt: user.createdAt,
        coursesCount: allPurchases.length,
        totalRevenue: totalSpent,
        courseList: allPurchases
      };
    });

    res.status(200).json({
      success: true,
      users: userData
    });

  } catch (error) {
    console.error("❌ Admin Fetch Error:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
});

// ==========================================
// 🎓 CERTIFICATE ROUTES
// ==========================================

// 🔒 Added adminOnly to prevent fake certificate generation
app.post('/api/admin/issue-certificate', adminOnly, async (req, res) => {
  const { phone, courseName, certificateDate, planType, score, itemModel } = req.body;

  if (!phone || !courseName || !certificateDate) {
    return res.status(400).json({ message: "Phone, Course Name, and Date are required" });
  }

  try {
    const user = await User.findOne({ phone: phone });
    if (!user) return res.status(404).json({ message: "User not found." });

    let courseObj = null;
    let foundModelType = itemModel || 'Course';

    const safeCourseName = courseName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const titleRegex = new RegExp(`^${safeCourseName}$`, 'i');

    if (foundModelType === 'Cohort') {
        courseObj = await Cohort.findOne({ title: titleRegex });
    } else if (foundModelType === 'Masterclass') {
        courseObj = await Masterclass.findOne({ title: titleRegex });
    } else if (foundModelType === 'Course') {
        courseObj = await Course.findOne({ title: titleRegex });
    }

    if (!courseObj) {
        courseObj = await Course.findOne({ title: titleRegex });
        if (courseObj) foundModelType = 'Course';
    }
    if (!courseObj) {
        courseObj = await Cohort.findOne({ title: titleRegex });
        if (courseObj) foundModelType = 'Cohort';
    }
    if (!courseObj) {
        courseObj = await Masterclass.findOne({ title: titleRegex });
        if (courseObj) foundModelType = 'Masterclass';
    }

    if (!courseObj) return res.status(404).json({ message: `"${courseName}" not found in database. Check spelling/spaces.` });

    const uniqueCertId = `CERT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const certificateLink = `/view-certificate/${uniqueCertId}`;

    const newCertificate = new Certificate({
        certificateId: uniqueCertId,
        user: user._id,
        studentName: user.name,
        phone: user.phone,          
        course: courseObj._id,
        itemModel: foundModelType,
        courseName: courseObj.title,
        planType: planType || 'recorded',
        score: score || null,
        issuedDate: certificateDate,
        certificateUrl: certificateLink
    });
    await newCertificate.save();

    let updateRes = await User.updateOne(
        { _id: user._id, "enrolledCourses.item": courseObj._id },
        {
            $set: {
                "enrolledCourses.$.certificateUrl": certificateLink,
                "enrolledCourses.$.issuedDate": certificateDate,
                "enrolledCourses.$.score": score,
                "enrolledCourses.$.progress": 100,
                "enrolledCourses.$.completedLessons": ["ALL"]
            }
        }
    );

    if (updateRes.modifiedCount === 0) {
        await User.updateOne(
            { _id: user._id },
            {
                $push: {
                    enrolledCourses: { 
                        item: courseObj._id,
                        itemModel: foundModelType,
                        planType: planType || 'recorded', 
                        paymentStatus: 'full', 
                        amountPaid: 0, 
                        purchasedAt: new Date(certificateDate || Date.now()), 
                        progress: 100,
                        completedLessons: ["ALL"],
                        certificateUrl: certificateLink,
                        issuedDate: certificateDate, 
                        score: score || null
                    }
                }
            }
        );
        
        return res.json({ 
            success: true, 
            message: `New record created and certificate saved!`, 
            certificateId: uniqueCertId 
        });
    }

    return res.json({ 
        success: true, 
        message: `Certificate issued and saved to existing record!`, 
        certificateId: uniqueCertId 
    });

  } catch (error) {
    console.error("❌ Certificate Issue Error:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
});

// 🔒 Added adminOnly
app.post('/api/admin/issue-external-certificate', adminOnly, async (req, res) => {
  const { studentName, phone, courseName, certificateDate, planType, score } = req.body;

  if (!studentName || !courseName || !certificateDate) {
    return res.status(400).json({ message: "Student Name, Course Name, and Date are required" });
  }

  try {
    let courseObj = await Course.findOne({ title: { $regex: new RegExp(`^${courseName}$`, 'i') } });
    let foundModelType = 'Course'; 

    if (!courseObj) {
        courseObj = await Cohort.findOne({ title: { $regex: new RegExp(`^${courseName}$`, 'i') } });
        if(courseObj) foundModelType = 'Cohort'; 
    }
    if (!courseObj) {
        courseObj = await Masterclass.findOne({ title: { $regex: new RegExp(`^${courseName}$`, 'i') } });
        if(courseObj) foundModelType = 'Masterclass'; 
    }

    if (!courseObj) {
        return res.status(404).json({ 
            success: false, 
            message: `"${courseName}" not found in database. Please ensure the spelling is exactly correct.` 
        });
    }

    let cleanPhone = phone ? phone.replace(/[\s-]/g, '') : null;
    if (cleanPhone && cleanPhone.length === 10 && !cleanPhone.startsWith('+')) {
        cleanPhone = `+91${cleanPhone}`;
    }

    let existingUser = null;
    if (cleanPhone) {
        existingUser = await User.findOne({ phone: cleanPhone });
    }

    const uniqueCertId = `CERT-EXT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const certificateLink = `/view-certificate/${uniqueCertId}`;

    const newCertificate = new Certificate({
        certificateId: uniqueCertId,
        user: existingUser ? existingUser._id : null, 
        studentName: studentName,
        phone: cleanPhone || "N/A", 
        courseName: courseName,
        course: courseObj._id, 
        itemModel: foundModelType, 
        planType: planType || 'recorded',
        score: score || null,
        issuedDate: certificateDate,
        certificateUrl: certificateLink
    });

    await newCertificate.save();

    return res.json({ 
        success: true, 
        message: existingUser 
            ? "External certificate generated and linked to existing user!" 
            : "External certificate generated for new student!", 
        certificateId: uniqueCertId 
    });

  } catch (error) {
    console.error("❌ External Certificate Error:", error);
    res.status(500).json({ message: "Server Error", error: error.message });
  }
});

// ✅ Public Route: Anyone can verify a certificate ID
app.get('/api/public/certificate/:id', async (req, res) => {
    try {
        const certId = req.params.id;
        const cert = await Certificate.findOne({ certificateId: certId });

        if (!cert) {
            return res.status(404).json({ success: false, message: "Certificate not found or invalid ID" });
        }

        res.json({
            success: true,
            data: {
                name: cert.studentName,
                course: cert.courseName,
                issuedDate: cert.issuedDate,
                planType: cert.planType,
                score: cert.score,
                date: cert.issuedDate
            }
        });

    } catch (err) {
        console.error("Certificate Fetch Error:", err);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// 🔒 Added requireAuth
app.get('/api/user/certificates/:phone', requireAuth, async (req, res) => {
    try {
        let phone = req.params.phone;
        let cleanPhone = phone.replace(/[\s-]/g, '');
        if (cleanPhone.length === 10) cleanPhone = `+91${cleanPhone}`;

        const user = await User.findOne({ phone: cleanPhone });
        let searchQuery = { phone: cleanPhone };
        
        if (user) {
            searchQuery = {
                $or: [
                    { phone: cleanPhone },      
                    { user: user._id }          
                ]
            };
        }

        const userCertificates = await Certificate.find(searchQuery).sort({ createdAt: -1 });
        res.json({ success: true, certificates: userCertificates });
    } catch (error) {
        console.error("Fetch User Certificates Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// 🔒 Added adminOnly
app.get('/api/admin/search-certificates', adminOnly, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) {
            return res.json({ success: true, certificates: [] });
        }

        const searchRegex = new RegExp(q, 'i');
        const certificates = await Certificate.find({
            $or: [
                { studentName: searchRegex },
                { phone: searchRegex },
                { certificateId: searchRegex }
            ]
        }).sort({ createdAt: -1 }).limit(20);

        res.json({ success: true, certificates });
    } catch (error) {
        console.error("Search Certificates Error:", error);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ==========================================
// 🔌 ROUTE MOUNTS
// ==========================================

app.use('/api/masterclasses', require('./routes/paymentMasterclass'));
app.use('/api/courses', require('./routes/courseRoutes'));
app.use('/api/coupons', require('./routes/couponRoutes'));
app.use('/api/cohorts', require('./routes/cohortRoutes')) 
app.use('/api/bitesize-courses', require('./routes/biteSizeRoutes'));

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
