const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');

// Models
const BiteSizeCourse = require('../models/BiteSizeCourse');
const User = require('../models/User');
const Order = require('../models/Order');

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
            '-content' // NEVER send premium content in the public list
        ).sort({ createdAt: -1 });
        
        res.json(list);
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

router.get('/:slug', async (req, res) => {
    try {
        const item = await BiteSizeCourse.findOne({ slug: req.params.slug })
            .select('-content.videoUrl'); // Hide actual video URLs

        if (!item) return res.status(404).json({ message: "Course Not Found" });

        res.json(item);
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 2. DIRECT CHECKOUT (SECURED)
// =====================================================

// 🔒 requireAuth added
router.post('/create-checkout', requireAuth, async (req, res) => {
    try {
        const { courseId, planType } = req.body; 
        const userId = req.user._id; // Extracted securely from the JWT cookie

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

// 🔒 requireAuth added
router.post('/verify-payment', requireAuth, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        const userId = req.user._id; // Extracted securely from the JWT cookie

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

        // 🛡️ Extra Security: Ensure the user verifying the payment actually owns the order
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

// 🗑️ BYPASS ROUTE COMPLETELY DELETED FOR PRODUCTION SAFETY

// =====================================================
// 4. PROTECTED CONTENT ROUTE (SECURED)
// =====================================================

// 🔒 requireAuth added
router.get('/content/:id', requireAuth, async (req, res) => {
    try {
        const courseId = req.params.id;
        const userId = req.user._id; // Extracted securely from the JWT cookie

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

        const courseData = await BiteSizeCourse.findById(courseId);
        if (!courseData) return res.status(404).json({ message: "Course not found" });

        res.json(courseData);
        
    } catch (err) {
        console.error("Fetch Content Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 5. ADMIN ROUTES
// =====================================================

router.get('/admin/all', adminOnly, async (req, res) => {
    try {
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