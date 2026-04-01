const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');

// Models
const BiteSizeCourse = require('../models/BiteSizeCourse');
const User = require('../models/User');
const Order = require('../models/Order');
const Certificate = require('../models/Certificate'); // 🔴 NEW: Added for auto-certificates

// 🔴 SECURE MIDDLEWARE IMPORTED
const { requireAuth, adminOnly } = require('../middleware/auth'); 

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// =====================================================
// 1. PUBLIC ROUTES (Slider & Course Page)
// =====================================================

router.get('/', async (req, res) => {
    try {
        const list = await BiteSizeCourse.find(
            { isLocked: false },
            '-content -quiz' // 🔴 Hide premium content and quiz details from public list
        ).sort({ createdAt: -1 });
        
        res.json(list);
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

router.get('/:slug', async (req, res) => {
    try {
        const item = await BiteSizeCourse.findOne({ slug: req.params.slug })
            // 🔴 ANTI-CHEAT: Hide video URLs AND correct quiz answers from public view
            .select('-content.videoUrl -quiz.questions.correctAnswer'); 

        if (!item) return res.status(404).json({ message: "Course Not Found" });

        res.json(item);
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 2. DIRECT CHECKOUT (SECURED)
// =====================================================

router.post('/create-checkout', requireAuth, async (req, res) => {
    try {
        const { courseId, planType } = req.body; 
        const userId = req.user._id; 

        const course = await BiteSizeCourse.findById(courseId);
        if (!course) return res.status(404).json({ message: "Course not found" });

        const pricingTier = course.pricing[planType];
        if (!pricingTier || !pricingTier.active) {
            return res.status(400).json({ message: `The ${planType} plan is not available.` });
        }

        const amountToCharge = pricingTier.price;
        if (amountToCharge <= 0) return res.status(400).json({ message: "Invalid Pricing" });

        const order = await razorpay.orders.create({
            amount: Math.round(amountToCharge * 100), 
            currency: "INR",
            receipt: `bs_${Date.now()}`,
            notes: { orderType: 'BiteSize Direct Checkout' }
        });

        const newOrder = new Order({
            userId,
            item: course._id,
            itemModel: 'BiteSizeCourse',
            amount: amountToCharge,
            planType: planType,
            paymentType: 'full', 
            razorpayOrderId: order.id,
            status: 'pending'
        });
        await newOrder.save();

        res.json({
            success: true,
            key_id: process.env.RAZORPAY_KEY_ID,
            order_id: order.id,
            amount: amountToCharge,
            item_name: course.title,
            description: `${planType.toUpperCase()} Access`
        });

    } catch (err) {
        console.error("Checkout Init Failed:", err);
        res.status(500).json({ message: "Payment Initialization Failed" });
    }
});

// =====================================================
// 3. VERIFY PAYMENT & GRANT ACCESS (SECURED)
// =====================================================

router.post('/verify-payment', requireAuth, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        const userId = req.user._id; 

        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ success: false, message: "Invalid Payment Signature!" });
        }

        const pendingOrder = await Order.findOne({ razorpayOrderId: razorpay_order_id });
        if (!pendingOrder || pendingOrder.status === 'paid') {
            return res.status(400).json({ success: false, message: "Order not found or already processed" });
        }

        if (pendingOrder.userId.toString() !== userId.toString()) {
            return res.status(403).json({ message: "Forbidden: Order does not belong to this user." });
        }

        pendingOrder.status = 'paid';
        pendingOrder.razorpayPaymentId = razorpay_payment_id;
        pendingOrder.razorpaySignature = razorpay_signature;
        await pendingOrder.save();

        const user = await User.findById(userId);
        
        const alreadyEnrolled = user.enrolledCourses.some(
            c => c.item.toString() === pendingOrder.item.toString() && c.itemModel === 'BiteSizeCourse'
        );

        if (!alreadyEnrolled) {
            user.enrolledCourses.push({
                item: pendingOrder.item,
                itemModel: pendingOrder.itemModel,
                planType: pendingOrder.planType, 
                paymentStatus: 'full',
                amountPaid: pendingOrder.amount,
                purchasedAt: new Date()
            });
            await user.save();

            await BiteSizeCourse.findByIdAndUpdate(pendingOrder.item, { $inc: { enrolledCount: 1 } });
        }

        res.json({ success: true, message: "Payment verified, access granted." });

    } catch (err) {
        console.error("Verification Error:", err);
        res.status(500).json({ message: "Verification Error" });
    }
});

// =====================================================
// 4. PROTECTED CONTENT & ENGAGEMENT ROUTES (SECURED)
// =====================================================

// Fetch the actual videos
router.get('/content/:id', requireAuth, async (req, res) => {
    try {
        const courseId = req.params.id;
        const userId = req.user._id; 

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: "User not found" });

        // Admins bypass ownership checks
        if (user.role !== 'admin') {
            const hasAccess = user.enrolledCourses.some(
                course => course.item.toString() === courseId && course.itemModel === 'BiteSizeCourse'
            );

            if (!hasAccess) {
                return res.status(403).json({ message: "Forbidden. You must purchase this course." });
            }
        }

        // 🔴 ANTI-CHEAT: Strips the correct answers before sending to frontend
        const courseData = await BiteSizeCourse.findById(courseId)
            .select('-quiz.questions.correctAnswer'); 

        if (!courseData) return res.status(404).json({ message: "Course not found" });

        res.json(courseData);
        
    } catch (err) {
        console.error("Fetch Content Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
});

// 🔴 NEW: Toggle Like on a specific short video
router.post('/content/:courseId/like/:contentId', requireAuth, async (req, res) => {
    try {
        const { courseId, contentId } = req.params;
        const userId = req.user._id;

        const course = await BiteSizeCourse.findById(courseId);
        if (!course) return res.status(404).json({ message: "Course not found" });

        const video = course.content.id(contentId);
        if (!video) return res.status(404).json({ message: "Video not found" });

        const hasLiked = video.likes.includes(userId);
        
        if (hasLiked) {
            video.likes.pull(userId); // Unlike
        } else {
            video.likes.push(userId); // Like
        }

        await course.save();
        res.json({ success: true, liked: !hasLiked, totalLikes: video.likes.length });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// 🔴 NEW: Record a view for analytics
router.post('/content/:courseId/view/:contentId', requireAuth, async (req, res) => {
    try {
        const { courseId, contentId } = req.params;

        await BiteSizeCourse.updateOne(
            { _id: courseId, "content._id": contentId },
            { $inc: { "content.$.views": 1 } }
        );

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 5. AUTOMATED QUIZ & CERTIFICATE ISSUANCE (SECURED)
// =====================================================

// 🔴 NEW: The magic TV route - Grading the quiz and issuing the certificate instantly
router.post('/submit-quiz/:id', requireAuth, async (req, res) => {
    try {
        const courseId = req.params.id;
        const userId = req.user._id;
        const { answers } = req.body; 

        // 🔴 DEBUG TRACER: THIS PRINTS IN YOUR TERMINAL
        console.log("\n=== QUIZ SUBMISSION DEBUG ===");
        console.log("1. Raw Answers from React:", answers);

        const user = await User.findById(userId);
        const course = await BiteSizeCourse.findById(courseId);

        if (!course || !course.quiz.enabled) {
            return res.status(400).json({ message: "Quiz is not active for this course." });
        }

        let correctCount = 0;
        const totalQuestions = course.quiz.questions.length;

        if (totalQuestions === 0) return res.status(400).json({ message: "No questions found." });

        course.quiz.questions.forEach((q, index) => {
            const questionIdStr = q._id.toString();
            const userAnswer = answers[questionIdStr];
            const actualAnswer = q.correctAnswer;

            // 🔴 DEBUG TRACER: THIS SHOWS THE EXACT MISMATCH
            console.log(`\nQ${index + 1}: ID = ${questionIdStr}`);
            console.log(` -> User picked : "${userAnswer}"`);
            console.log(` -> Correct is  : "${actualAnswer}"`);

            // I added .trim() to ensure accidental spaces in your database don't fail the user
            if (userAnswer && userAnswer.trim() === actualAnswer.trim()) {
                console.log(` -> RESULT: ✅ MATCH!`);
                correctCount++;
            } else {
                console.log(` -> RESULT: ❌ WRONG!`);
            }
        });

        const scorePercentage = Math.round((correctCount / totalQuestions) * 100);
        console.log(`\nFinal Score: ${correctCount}/${totalQuestions} (${scorePercentage}%)`);
        console.log("=============================\n");

        const passed = scorePercentage >= course.quiz.passingScore;

        if (!passed) {
            return res.json({ 
                success: true, 
                passed: false, 
                score: scorePercentage, 
                message: `You scored ${scorePercentage}%. You need ${course.quiz.passingScore}% to pass.` 
            });
        }

        const existingCert = await Certificate.findOne({ user: userId, course: courseId });
        if (existingCert) {
            return res.json({ success: true, passed: true, score: scorePercentage, certificateUrl: existingCert.certificateUrl });
        }

        const uniqueCertId = `CERT-BS-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const certificateLink = `/bitesize-certificate/${uniqueCertId}`;

        const newCert = new Certificate({
            certificateId: uniqueCertId,
            user: userId,
            studentName: user.name,
            phone: user.phone || "N/A",
            course: courseId,
            itemModel: 'BiteSizeCourse',
            courseName: `${course.title.toUpperCase()} ${course.highlight}`,
            planType: 'standard', 
            score: scorePercentage,
            issuedDate: new Date(),
            certificateUrl: certificateLink
        });
        await newCert.save();

        await User.updateOne(
            { _id: userId, "enrolledCourses.item": courseId },
            {
                $set: {
                    "enrolledCourses.$.certificateUrl": certificateLink,
                    "enrolledCourses.$.score": scorePercentage,
                    "enrolledCourses.$.issuedDate": new Date(),
                    "enrolledCourses.$.progress": 100
                }
            }
        );

        res.json({ 
            success: true, passed: true, score: scorePercentage, certificateUrl: certificateLink
        });

    } catch (err) {
        console.error("Quiz Submission Error:", err);
        res.status(500).json({ message: "Server Error during quiz grading." });
    }
});

// =====================================================
// 6. ADMIN ROUTES (SECURED)
// =====================================================

router.get('/admin/all', adminOnly, async (req, res) => {
    try {
        // Admin needs the correct answers to see/edit them, so we do NOT exclude them here
        const list = await BiteSizeCourse.find({}).sort({ createdAt: -1 });
        res.json(list);
    } catch (err) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

router.post('/admin/create', adminOnly, async (req, res) => {
    try {
        const newItem = new BiteSizeCourse(req.body);
        await newItem.save();
        res.status(201).json({ message: "Created", course: newItem });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.put('/admin/update/:id', adminOnly, async (req, res) => {
    try {
        const updated = await BiteSizeCourse.findByIdAndUpdate(
            req.params.id, 
            req.body, 
            { new: true, runValidators: true } 
        );
        res.json({ message: "Updated", course: updated });
    } catch (err) { 
        res.status(400).json({ message: err.message }); 
    }
});

router.delete('/admin/delete/:id', adminOnly, async (req, res) => {
    try {
        await BiteSizeCourse.findByIdAndDelete(req.params.id);
        res.json({ message: "Deleted" });
    } catch (err) { 
        res.status(500).json({ message: "Server Error" }); 
    }
});

module.exports = router;