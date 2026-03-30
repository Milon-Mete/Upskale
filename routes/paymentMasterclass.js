const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');

// Import ONLY the Masterclass Model
const Masterclass = require('../models/Masterclass'); 
const User = require('../models/User');
const Order = require('../models/Order');
const Coupon = require('../models/Coupon');

// 🔴 SECURE MIDDLEWARE IMPORTED
const { adminOnly, requireAuth } = require('../middleware/auth');

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ==========================================
// 1. PUBLIC: GET UPCOMING MASTERCLASSES
// ==========================================
// This is for your WEBSITE (Hides expired/drafts)
router.get('/', async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0); 

        const list = await Masterclass.find({
            'schedule.startDate': { $gte: today }, // Only future
            manualStatus: 'published'              // Only published
        }).sort({ 'schedule.startDate': 1 });      // Soonest first

        res.json(list);
    } catch (err) {
        console.error("❌ Fetch Error:", err);
        res.status(500).json({ success: false, message: "Could not fetch masterclasses" });
    }
});

// ==========================================
// 2. ADMIN: GET ALL MASTERCLASSES
// ==========================================
// This is for your DASHBOARD (Shows everything)
router.get('/admin/all', adminOnly, async (req, res) => {
    try {
        const list = await Masterclass.find({}).sort({ createdAt: -1 });
        res.json(list);
    } catch (err) {
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

// ==========================================
// 3. GET SINGLE MASTERCLASS BY SLUG
// ==========================================
router.get('/:slug', async (req, res) => {
    try {
        const item = await Masterclass.findOne({ slug: req.params.slug }).select('-meetingLink');
        if (!item) return res.status(404).json({ message: "Masterclass Not Found" });
        
        res.json({ masterclassData: item });
    } catch (err) {
        res.status(500).json({ message: "Server Error" });
    }
});

// ==========================================
// 4. CREATE MASTERCLASS ORDER (SECURED)
// ==========================================
// 🔒 Added requireAuth
router.post('/create-order', requireAuth, async (req, res) => {
    try {
        const { masterclassId, couponCode } = req.body;
        const userId = req.user._id; // 🔒 Extracted securely from JWT cookie

        const masterclass = await Masterclass.findById(masterclassId);
        if (!masterclass) {
            return res.status(404).json({ success: false, message: "Masterclass not found in DB" });
        }

        let amountToCharge = masterclass.price.discounted;

        // --- 3. COUPON LOGIC START ---
        if (couponCode) {
            // Find Coupon AND check if usage limit is not reached
            const coupon = await Coupon.findOneAndUpdate(
                {
                    code: couponCode.toUpperCase(),
                    isActive: true,
                    // Check if: (usageLimit is null OR usedCount < usageLimit)
                    $or: [
                        { usageLimit: null },
                        { $expr: { $lt: ["$usedCount", "$usageLimit"] } }
                    ]
                },
                { $inc: { usedCount: 1 } }, // Increase usage count atomically
                { new: true }
            );

            if (coupon) {
                // Validate other constraints (Expiry, Min Order)
                if (coupon.validUntil && new Date() > coupon.validUntil) {
                    return res.status(400).json({ message: "Coupon Expired" });
                }
                if (amountToCharge < coupon.minOrderValue) {
                    return res.status(400).json({ message: `Min order value is ₹${coupon.minOrderValue}` });
                }

                // Calculate Discount
                let discount = 0;
                if (coupon.discountType === 'percentage') {
                    discount = (amountToCharge * coupon.discountValue) / 100;
                } else {
                    discount = coupon.discountValue;
                }

                // Apply Discount (Prevent negative)
                amountToCharge = amountToCharge - discount;
                if (amountToCharge < 0) amountToCharge = 0;

            } else {
                return res.status(400).json({ message: "Invalid Coupon or Limit Reached" });
            }
        }
        // --- COUPON LOGIC END ---

        const options = {
            amount: Math.round(amountToCharge * 100), // Razorpay needs paise
            currency: "INR",
            receipt: `mc_rcpt_${Date.now()}_${userId.toString().slice(-4)}`,
            notes: {
                type: "masterclass_booking",
                masterclass_title: masterclass.title
            }
        };

        const order = await razorpay.orders.create(options);

        const newOrder = new Order({
            userId: userId,
            item: masterclass._id,
            itemModel: 'Masterclass',
            amount: amountToCharge,
            razorpayOrderId: order.id,
            status: 'pending',
            couponUsed: couponCode || null // Optional: Track coupon
        });

        await newOrder.save();

        res.json({
            success: true,
            key_id: process.env.RAZORPAY_KEY_ID,
            order_id: order.id,
            amount: amountToCharge,
            title: masterclass.title,
            description: "Live Masterclass Seat"
        });

    } catch (error) {
        console.error("❌ Masterclass Payment Error:", error);
        res.status(500).json({ success: false, message: "Server Payment Error" });
    }
});

// ==========================================
// 5. VERIFY MASTERCLASS PAYMENT (SECURED)
// ==========================================
// 🔒 Added requireAuth
router.post('/verify-payment', requireAuth, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        const userId = req.user._id; // 🔒 Extracted securely from JWT cookie

        // 1. STRICT CRYPTO VERIFICATION (Runs every time, cannot be bypassed)
        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ success: false, message: "Invalid Payment Signature! Transaction rejected." });
        }

        const order = await Order.findOne({ razorpayOrderId: razorpay_order_id });
        if (!order) return res.status(404).json({ message: "Order not found" });

        // 🔒 Ensure the active user owns this order
        if (order.userId.toString() !== userId.toString()) {
            return res.status(403).json({ message: "Forbidden: Order does not belong to this user." });
        }

        // Prevent double processing
        if (order.status === 'paid') {
            return res.json({ success: true, message: "Order already processed" });
        }

        order.status = 'paid';
        order.razorpayPaymentId = razorpay_payment_id;
        order.razorpaySignature = razorpay_signature;
        await order.save();

        const user = await User.findById(order.userId);
        
        const alreadyEnrolled = user.enrolledCourses.some(
            enrollment => enrollment.item.toString() === order.item.toString()
        );

        if (!alreadyEnrolled) {
            user.enrolledCourses.push({
                item: order.item,
                itemModel: 'Masterclass',
                paymentStatus: 'full', 
                amountPaid: order.amount, 
                purchasedAt: new Date() 
            });
            await user.save();

            await Masterclass.findByIdAndUpdate(order.item, { 
                $inc: { enrolledCount: 1 } 
            });
        }

        res.json({ success: true, message: "Masterclass Booked Successfully!" });

    } catch (error) {
        console.error("❌ Verification Error:", error);
        res.status(500).json({ success: false, message: "Verification Failed" });
    }
});

// ==========================================
// 6. ADMIN: MANAGE MASTERCLASSES
// ==========================================

// Create Masterclass
router.post('/admin/create', adminOnly, async (req, res) => {
    try {
        const newItem = new Masterclass(req.body);
        await newItem.save();
        res.status(201).json({ message: "Created", masterclass: newItem });
    } catch (err) {
        if (err.code === 11000) return res.status(400).json({ message: "Title exists" });
        res.status(400).json({ message: err.message });
    }
});

// Update Masterclass
router.put('/admin/update/:id', adminOnly, async (req, res) => {
    try {
        const updated = await Masterclass.findByIdAndUpdate(
            req.params.id, 
            req.body, 
            { returnDocument: 'after', runValidators: true } 
        );
        res.json({ message: "Updated", masterclass: updated });
    } catch (err) { 
        res.status(400).json({ message: err.message }); 
    }
});

// Delete Masterclass
router.delete('/admin/delete/:id', adminOnly, async (req, res) => {
    try {
        await Masterclass.findByIdAndDelete(req.params.id);
        res.json({ message: "Deleted" });
    } catch (err) { 
        res.status(500).json({ message: "Server Error" }); 
    }
});

// ==========================================
// 📊 MASTERCLASS ENROLLMENT STATS (SECURED)
// ==========================================
// 🔒 Added adminOnly to prevent data leak
router.get('/admin/enrollment-stats', adminOnly, async (req, res) => {
    try {
        const stats = await User.aggregate([
            { $unwind: "$enrolledCourses" },
            // Use regex for match to be safe with case sensitivity
            { $match: { "enrolledCourses.itemModel": { $regex: /^masterclass$/i } } },
            {
                $lookup: {
                    from: "masterclasses", 
                    localField: "enrolledCourses.item",
                    foreignField: "_id",
                    as: "masterclassData" 
                }
            },
            { $unwind: "$masterclassData" },
            {
                $group: {
                    _id: "$masterclassData._id",
                    title: { $first: "$masterclassData.title" },
                    expertName: { $first: "$masterclassData.expert.name" },
                    startDate: { $first: "$masterclassData.schedule.startDate" },
                    enrolledCount: { $sum: 1 },
                    students: {
                        $push: {
                            name: "$name",
                            phone: "$phone",
                            email: "$email",
                            // This fallback ensures it grabs the right date field
                            enrolledAt: { $ifNull: ["$enrolledCourses.purchasedAt", "$enrolledCourses.enrolledAt", "$createdAt"] }
                        }
                    }
                }
            }
        ]);

        console.log("Found Stats:", JSON.stringify(stats, null, 2));
        res.json({ success: true, stats });
    } catch (err) {
        console.error("Aggregation Error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;