const mongoose = require('mongoose');

const CouponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true },
  discountType: { type: String, enum: ['flat', 'percentage'], required: true },
  discountValue: { type: Number, required: true },
  minOrderValue: { type: Number, default: 0 },
  validUntil: { type: Date },
  isActive: { type: Boolean, default: true },
  
  // --- NEW LIMIT FIELDS ---
  usageLimit: { type: Number, default: null }, // null = unlimited
  usedCount: { type: Number, default: 0 }      // Tracks how many times it has been used
});

module.exports = mongoose.model('Coupon', CouponSchema);