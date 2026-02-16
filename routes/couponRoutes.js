const express = require('express');
const router = express.Router();
const Coupon = require('../models/Coupon');
const { adminOnly } = require('../middleware/auth'); // <--- Import Security

// ==========================================
// 1. PUBLIC: VERIFY COUPON (For Cart Page)
// ==========================================
router.post('/verify', async (req, res) => {
    try {
        const { code, orderAmount } = req.body;
        const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });
        
        if (!coupon) return res.status(404).json({ message: "Invalid Coupon" });
        if (coupon.validUntil && new Date() > coupon.validUntil) return res.status(400).json({ message: "Coupon Expired" });
        if (orderAmount < coupon.minOrderValue) return res.status(400).json({ message: `Min order value is ₹${coupon.minOrderValue}` });
        if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) return res.status(400).json({ message: "Usage limit reached" });

        let discount = coupon.discountType === 'percentage' 
            ? (orderAmount * coupon.discountValue) / 100 
            : coupon.discountValue;

        if (discount > orderAmount) discount = orderAmount;

        res.json({ success: true, discount: Math.floor(discount), code: coupon.code, message: "Applied!" });
    } catch (err) { res.status(500).json({ message: "Server Error" }); }
});

// ==========================================
// 2. ADMIN: MANAGE COUPONS
// ==========================================

// Get All Coupons
router.get('/admin/all', adminOnly, async (req, res) => {
    try {
        const coupons = await Coupon.find({}).sort({ createdAt: -1 });
        res.json(coupons);
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// Create Coupon
router.post('/admin/create', adminOnly, async (req, res) => {
    try {
        const newCoupon = new Coupon({
            ...req.body,
            code: req.body.code.toUpperCase() // Force Uppercase
        });
        await newCoupon.save();
        res.json({ message: "Created", coupon: newCoupon });
    } catch (err) {
        if(err.code === 11000) return res.status(400).json({ message: "Code already exists" });
        res.status(500).json({ message: err.message }); 
    }
});

// Delete Coupon
router.delete('/admin/delete/:id', adminOnly, async (req, res) => {
    try {
        await Coupon.findByIdAndDelete(req.params.id);
        res.json({ message: "Deleted" });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;