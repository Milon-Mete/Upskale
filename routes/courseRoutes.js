const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');

// Import Models
const Course = require('../models/Course');
const User = require('../models/User');
const Order = require('../models/Order');
const Coupon = require('../models/Coupon');
const { adminOnly } = require('../middleware/auth');

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});


// ==========================================
// 1. PUBLIC: GET COURSES
// ==========================================

// ✅ NEW: Get Course by ID (For Cart Refresh)
router.get('/find/:id', async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) return res.status(404).json({ message: "Not Found" });
        res.json(course);
    } catch (err) { res.status(500).json({ message: "Server Error" }); }
});

// ... (Your existing Get All and Get Slug routes remain here) ...

// ==========================================
// 1. PUBLIC: GET COURSES
// ==========================================
router.get('/', async (req, res) => {
    try {
        const list = await Course.find({ isPublished: true }, '-content'); 
        res.json(list);
    } catch (err) { res.status(500).json({ message: "Server Error" }); }
});

router.get('/:slug', async (req, res) => {
    try {
        const item = await Course.findOne({ slug: req.params.slug })
            .select('-content.lessons.videoId'); 
        if (!item) return res.status(404).json({ message: "Not Found" });
        res.json({ courseData: item });
    } catch (err) { res.status(500).json({ message: "Server Error" }); }
});

// ==========================================
// 2. PAYMENT: CREATE ORDER (Updated)
// ==========================================
// create-order
router.post('/create-order', async (req, res) => {
    try {
        // ✅ Receive BOTH planType (Product) and paymentType (Method)
        const { userId, itemId, planType, paymentType, couponCode } = req.body; 

        const product = await Course.findById(itemId);
        if (!product) return res.status(404).json({ message: "Course not found" });

        // --- 1. DETERMINE PRICE ---
        let amountToCharge = 0;

        // Validation: Ensure planType is valid
        if (planType !== 'live' && planType !== 'recorded') {
            return res.status(400).json({ message: "Invalid Plan Type" });
        }

        if (paymentType === 'installment') {
            // Installment Logic (Usually only allowed for Live, but flexible here)
            if (!product.pricing.installment?.enabled) {
                return res.status(400).json({ message: "Installments not enabled" });
            }
            amountToCharge = product.pricing.installment.pricePart1; 
        } else {
            // Full Payment Logic
            amountToCharge = (planType === 'live') ? product.pricing.live : product.pricing.recorded;
        }

        if (!amountToCharge || amountToCharge <= 0) return res.status(400).json({ message: "Invalid Amount" });

        // --- 2. COUPON LOGIC (Same as before) ---
        if (couponCode) {
            const coupon = await Coupon.findOneAndUpdate(
                { 
                    code: couponCode.toUpperCase(), 
                    isActive: true,
                    $or: [{ usageLimit: null }, { $expr: { $lt: ["$usedCount", "$usageLimit"] } }] 
                },
                { $inc: { usedCount: 1 } },
                { returnDocument: 'after' } // Fixed deprecation warning
            );

            if (coupon) {
                if (coupon.validUntil && new Date() > coupon.validUntil) return res.status(400).json({ message: "Coupon Expired" });
                if (amountToCharge < coupon.minOrderValue) return res.status(400).json({ message: `Min order is ₹${coupon.minOrderValue}` });

                let discount = coupon.discountType === 'percentage' 
                    ? (amountToCharge * coupon.discountValue) / 100 
                    : coupon.discountValue;

                amountToCharge = Math.max(0, amountToCharge - discount);
            } else {
                return res.status(400).json({ message: "Invalid Coupon" });
            }
        }

        // --- 3. CREATE RAZORPAY ORDER ---
        const options = {
            amount: Math.round(amountToCharge * 100),
            currency: "INR",
            receipt: `rcpt_${Date.now()}`,
            notes: { planType, paymentType } // Store both in Razorpay notes
        };

        const order = await razorpay.orders.create(options);

        // --- 4. SAVE DB ORDER ---
        const newOrder = new Order({
            userId, 
            item: itemId, 
            itemModel: 'Course',
            amount: amountToCharge,
            planType: planType,       // ✅ Saves 'live' or 'recorded'
            paymentType: paymentType, // ✅ Saves 'installment' or 'full'
            razorpayOrderId: order.id, 
            status: 'pending',
            couponUsed: couponCode || null
        });
        await newOrder.save();

        res.json({
            success: true,
            key_id: process.env.RAZORPAY_KEY_ID,
            order_id: order.id,
            amount: amountToCharge,
            item_name: product.title,
            description: paymentType === 'installment' ? 'Part Payment 1' : 'Full Access'
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Payment Init Failed" });
    }
});

// verify-payment
// ... (imports and initial routes remain the same)

// ==========================================
// 2. PAYMENT: VERIFY PAYMENT (Full Update)
// ==========================================
router.post('/verify-payment', async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        // Verify Signature
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString()).digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ success: false, message: "Invalid Signature" });
        }

        // Find the order in our database
        const order = await Order.findOne({ razorpayOrderId: razorpay_order_id });
        if (!order) return res.status(404).json({ success: false, message: "Order not found" });

        // Update Order Status
        order.status = 'paid';
        order.razorpayPaymentId = razorpay_payment_id;
        order.razorpaySignature = razorpay_signature;
        await order.save();

        // Update User Enrollment
        const user = await User.findById(order.userId);
        if (user) {
            // Check if user is ALREADY enrolled
            const existingEnrollment = user.enrolledCourses.find(
                e => e.item.toString() === order.item.toString()
            );

            if (existingEnrollment) {
                // ✅ LOGIC: If they were 'partial', this payment makes them 'full'
                if (existingEnrollment.paymentStatus === 'partial') {
                    existingEnrollment.paymentStatus = 'full';
                    existingEnrollment.amountPaid += order.amount;
                    user.markModified('enrolledCourses'); // Required for nested array updates
                }
            } else {
                // ✅ LOGIC: New Enrollment
                user.enrolledCourses.push({ 
                    item: order.item, 
                    itemModel: 'Course', 
                    planType: order.planType,
                    // If they used installment, set as partial, otherwise full
                    paymentStatus: order.paymentType === 'installment' ? 'partial' : 'full',
                    amountPaid: order.amount,
                    purchasedAt: new Date()
                });
                
                // Increment Course enrollment count
                await Course.findByIdAndUpdate(order.item, { $inc: { enrolledCount: 1 } });
            }
            await user.save();
        }

        res.json({ success: true, message: "Payment verified and Access updated" });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Verification Error" });
    }
});

// ... (LMS Content and Admin routes remain the same)

// ==========================================
// 5. ADMIN ROUTES
// ==========================================
router.get('/admin/all', async (req, res) => {
    const list = await Course.find({});
    res.json(list);
});

router.post('/admin/create', adminOnly, async (req, res) => {
    try {
        const newItem = new Course(req.body);
        await newItem.save();
        res.status(201).json({ message: "Created", course: newItem });
    } catch (err) { res.status(400).json({ message: err.message }); }
});

router.put('/admin/update/:id', adminOnly, async (req, res) => {
    try {
        const updated = await Course.findByIdAndUpdate(
            req.params.id, 
            req.body, 
            { returnDocument: 'after', runValidators: true }
        );
        res.json({ message: "Updated", course: updated });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/admin/delete/:id', adminOnly, async (req, res) => {
    try {
        await Course.findByIdAndDelete(req.params.id);
        res.json({ message: "Deleted successfully" });
    } catch (err) { 
        res.status(500).json({ message: "Server Error" }); 
    }
});

module.exports = router;