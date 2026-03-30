const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');

const User = require('../models/User');
const Order = require('../models/Order');
const Coupon = require('../models/Coupon');
// 🔴 ADDED requireAuth here
const { adminOnly, requireAuth } = require('../middleware/auth');
const Cohort = require('../models/Cohort');
const Course = require('../models/Course'); // Added missing Course model import
const Masterclass = require('../models/Masterclass'); // Added missing Masterclass import
const Referral = require('../models/Referral');

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// =====================================================
// 1. PUBLIC ROUTES
// =====================================================

router.get('/find/:id', async (req, res) => {
    try {
        const cohort = await Cohort.findById(req.params.id);
        if (!cohort) return res.status(404).json({ message: "Not Found" });
        res.json(cohort);
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

router.get('/', async (req, res) => {
    try {
        const list = await Cohort.find(
            { isPublished: true, category: 'Cohort' },
            '-content'
        );
        res.json(list);
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

router.get('/:slug', async (req, res) => {
    try {
        const item = await Cohort.findOne({
            slug: req.params.slug,
            category: 'Cohort'
        }).select('-content.lessons.videoId');

        if (!item) return res.status(404).json({ message: "Not Found" });

        res.json({ CohortData: item });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 2. CREATE ORDER (SECURED)
// =====================================================

// 🔒 Added requireAuth
router.post('/create-order', requireAuth, async (req, res) => {
    try {
        const { items, couponCode } = req.body;
        const userId = req.user._id; // 🔒 Extracted securely from JWT cookie

        if (!items || items.length === 0) {
            return res.status(400).json({ message: "Cart is empty" });
        }

        let totalAmountToCharge = 0;
        const processedItems = [];

        for (const cartItem of items) {
            let product;
            
            if (cartItem.itemModel === 'Course') {
                product = await Course.findById(cartItem.itemId);
            } else if (cartItem.itemModel === 'Masterclass') {
                product = await Masterclass.findById(cartItem.itemId);
            } else {
                product = await Cohort.findById(cartItem.itemId);
            }

            if (!product) continue;

            let itemPrice = 0;

            if (cartItem.itemModel === 'Masterclass') {
                itemPrice = product.price || 0;
            } else {
                if (cartItem.isPart2Payment) {
                    itemPrice = product.pricing.installment.pricePart2;
                } else if (cartItem.paymentType === 'installment') {
                    if (!product.pricing.installment?.enabled) {
                        return res.status(400).json({ message: `Installments not enabled for ${product.title}` });
                    }
                    itemPrice = product.pricing.installment.pricePart1;
                } else {
                    itemPrice = cartItem.planType === 'live' 
                        ? product.pricing.live.discount 
                        : product.pricing.recorded.discount;
                }
            }

            if (!itemPrice || itemPrice < 0) return res.status(400).json({ message: `Invalid Pricing for ${product.title}` });

            totalAmountToCharge += itemPrice;

            processedItems.push({
                itemId: product._id,
                itemModel: cartItem.itemModel || 'Cohort',
                amount: itemPrice,
                planType: cartItem.planType || 'recorded',
                paymentType: cartItem.isPart2Payment ? 'full' : (cartItem.paymentType || 'full'),
                productTitle: product.title
            });
        }

        if (totalAmountToCharge <= 0 || processedItems.length === 0) {
            return res.status(400).json({ message: "Invalid Total Amount" });
        }

        let appliedCouponCode = null;
        if (couponCode) {
            const coupon = await Coupon.findOne({ code: couponCode.toUpperCase(), isActive: true });

            if (!coupon) return res.status(400).json({ message: "Invalid Coupon" });
            if (coupon.validUntil && new Date() > coupon.validUntil) return res.status(400).json({ message: "Coupon Expired" });
            if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) return res.status(400).json({ message: "Coupon Usage Limit Reached" });
            if (totalAmountToCharge < coupon.minOrderValue) return res.status(400).json({ message: `Min order is ₹${coupon.minOrderValue}` });

            let discountAmount = coupon.discountType === 'percentage'
                ? (totalAmountToCharge * coupon.discountValue) / 100
                : coupon.discountValue;

            totalAmountToCharge = Math.max(0, totalAmountToCharge - discountAmount);
            appliedCouponCode = coupon.code;
        }

        const order = await razorpay.orders.create({
            amount: Math.round(totalAmountToCharge * 100),
            currency: "INR",
            receipt: `rcpt_${Date.now()}`,
            notes: { orderType: 'Multi-Item Checkout' }
        });

        for (const pItem of processedItems) {
            const newOrder = new Order({
                userId,
                item: pItem.itemId,
                itemModel: pItem.itemModel,
                amount: pItem.amount,
                planType: pItem.planType,
                paymentType: pItem.paymentType,
                razorpayOrderId: order.id,
                status: 'pending',
                couponUsed: appliedCouponCode 
            });
            await newOrder.save();
        }

        res.json({
            success: true,
            key_id: process.env.RAZORPAY_KEY_ID,
            order_id: order.id,
            amount: totalAmountToCharge,
            item_name: `${processedItems.length} Item(s)`,
            description: "Checkout Purchase"
        });

    } catch (err) {
        console.error("Order Creation Error:", err);
        res.status(500).json({ message: "Payment Init Failed" });
    }
});

// =====================================================
// 3. VERIFY PAYMENT (SECURED)
// =====================================================

// 🔒 Added requireAuth
router.post('/verify-payment', requireAuth, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        const userId = req.user._id; // 🔒 Extracted securely

        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ success: false, message: "Invalid Payment Signature!" });
        }

        const pendingOrders = await Order.find({ razorpayOrderId: razorpay_order_id });

        if (!pendingOrders || pendingOrders.length === 0) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        // 🔒 Ensure the active user owns this order
        if (pendingOrders[0].userId.toString() !== userId.toString()) {
            return res.status(403).json({ message: "Forbidden: Order does not belong to this user." });
        }

        if (pendingOrders[0].status === 'paid') {
            return res.json({ success: true, message: "Orders already processed" });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: "User not found" });

        let userWasUpdated = false;

        for (const order of pendingOrders) {
            order.status = 'paid';
            order.razorpayPaymentId = razorpay_payment_id;
            order.razorpaySignature = razorpay_signature;
            await order.save();

            const existing = user.enrolledCourses.find(
                e => e.item.toString() === order.item.toString()
            );

            if (existing) {
                if (existing.paymentStatus === 'partial' && order.paymentType === 'full') {
                    existing.paymentStatus = 'full';
                    existing.amountPaid += order.amount;
                    userWasUpdated = true;
                }

                if (existing.planType === 'recorded' && order.planType === 'live') {
                    existing.planType = 'live'; 
                    existing.amountPaid += order.amount; 
                    existing.paymentStatus = order.paymentType === 'installment' ? 'partial' : 'full';
                    userWasUpdated = true;
                }
            } else {
                user.enrolledCourses.push({
                    item: order.item,
                    itemModel: order.itemModel || 'Cohort', 
                    planType: order.planType || 'recorded',
                    paymentStatus: order.paymentType === 'installment' ? 'partial' : 'full',
                    amountPaid: order.amount,
                    purchasedAt: new Date()
                });
                userWasUpdated = true;

                if (order.itemModel === 'Course') {
                    await Course.findByIdAndUpdate(order.item, { $inc: { enrolledCount: 1 } });
                } else if (order.itemModel === 'Masterclass') {
                    await Masterclass.findByIdAndUpdate(order.item, { $inc: { enrolledCount: 1 } });
                } else {
                    await Cohort.findByIdAndUpdate(order.item, { $inc: { enrolledCount: 1 } });
                }
            }
        }

        if (userWasUpdated) {
            user.markModified('enrolledCourses');
            await user.save();
        }

        const sampleOrder = pendingOrders[0];
        if (sampleOrder.couponUsed) {
            await Coupon.findOneAndUpdate(
                { code: sampleOrder.couponUsed },
                { $inc: { usedCount: 1 } } 
            );
        }

        try {
            const buyerId = pendingOrders[0].userId;
            const courseId = pendingOrders[0].item; 

            const pendingReferral = await Referral.findOne({ 
                referredUserId: buyerId, 
                status: 'pending' 
            });

            if (pendingReferral) {
                const REWARD_AMOUNT = 500; 

                pendingReferral.status = 'successful';
                pendingReferral.rewardEarned = REWARD_AMOUNT;
                pendingReferral.purchasedCourseId = courseId;
                await pendingReferral.save();

                await User.findByIdAndUpdate(
                    pendingReferral.referrerId,
                    { $inc: { walletBalance: REWARD_AMOUNT } }
                );
            }
        } catch (refError) {
            console.error("❌ Error processing referral reward:", refError);
        }

        res.json({ success: true, message: "Payment verified, All Items Processed" });

    } catch (err) {
        console.error("Verification Error:", err);
        res.status(500).json({ message: "Verification Error" });
    }
});

// =====================================================
// 4. ADMIN ROUTES
// =====================================================

router.get('/admin/all', adminOnly, async (req, res) => {
    const list = await Cohort.find({ category: 'Cohort' });
    res.json(list);
});

router.post('/admin/create', adminOnly, async (req, res) => {
    try {
        const newItem = new Cohort({
            ...req.body,
            category: 'Cohort'
        });
        await newItem.save();
        res.status(201).json({ message: "Created", Cohort: newItem });
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.put('/admin/update/:id', adminOnly, async (req, res) => {
    try {
        const updated = await Cohort.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true, runValidators: true }
        );
        res.json({ message: "Updated", Cohort: updated });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.delete('/admin/delete/:id', adminOnly, async (req, res) => {
    try {
        await Cohort.findByIdAndDelete(req.params.id);
        res.json({ message: "Deleted successfully" });
    } catch (err) { 
        console.error("Delete Error: ", err);
        res.status(500).json({ message: "Server Error" });
    }
});

// =====================================================
// 5. ENROLLMENT STATS (SECURED)
// =====================================================

// 🔒 Added adminOnly to prevent data leak
router.get('/admin/enrollment-stats', adminOnly, async (req, res) => {
    try {
        const stats = await User.aggregate([
            { $unwind: "$enrolledCourses" },
            {
                $lookup: {
                    from: "cohorts",
                    localField: "enrolledCourses.item",
                    foreignField: "_id",
                    as: "cohortData"
                }
            },
            { $unwind: "$cohortData" }, 
            {
                $group: {
                    _id: "$cohortData._id",
                    title: { $first: "$cohortData.title" }, 
                    category: { $first: "$cohortData.category" },
                    totalRevenue: { $sum: "$enrolledCourses.amountPaid" },
                    enrolledCount: { $sum: 1 },
                    students: {
                        $push: {
                            name: { $ifNull: ["$name", "Unknown Student"] },
                            phone: { $ifNull: ["$phone", "No Phone"] },
                            planType: { $ifNull: ["$enrolledCourses.planType", "recorded"] },
                            paymentStatus: { $ifNull: ["$enrolledCourses.paymentStatus", "partial"] },
                            progress: { $ifNull: ["$enrolledCourses.progress", 0] },
                            amountPaid: { $ifNull: ["$enrolledCourses.amountPaid", 0] }
                        }
                    }
                }
            },
            { $sort: { enrolledCount: -1 } }
        ]);

        res.json({ success: true, stats });

    } catch (err) {
        console.error("Aggregation Error:", err);
        res.status(500).json({ success: false });
    }
});

// =====================================================
// 6. COURSE PLAYER CONTENT (SECURED)
// =====================================================

// 🔒 Added requireAuth and Ownership Check
router.get('/content/:id', requireAuth, async (req, res) => {
    try {
        const courseId = req.params.id;
        const user = req.user;

        // 🔒 Verify if the user owns this cohort or is an admin
        if (user.role !== 'admin') {
            const hasAccess = user.enrolledCourses.some(
                c => c.item.toString() === courseId && c.itemModel === 'Cohort'
            );

            if (!hasAccess) {
                return res.status(403).json({ message: "Forbidden. You have not purchased this cohort." });
            }
        }

        const courseData = await Cohort.findById(courseId);
        
        if (!courseData) {
            return res.status(404).json({ message: "Course not found" });
        }

        res.json(courseData);
        
    } catch (err) {
        console.error("Fetch Content Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
});

module.exports = router;