const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  item: { type: mongoose.Schema.Types.ObjectId, refPath: 'itemModel', required: true },
  itemModel: { type: String, required: true, enum: ['Course', 'Masterclass'] },
  amount: { type: Number, required: true },
  planType: { type: String, enum: ['recorded', 'live'], default: 'recorded' },
  paymentType: { type: String, enum: ['full', 'installment'], default: 'full' },
  razorpayOrderId: { type: String, required: true },
  razorpayPaymentId: { type: String },
  razorpaySignature: { type: String },
  status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
  couponUsed: { type: String },
  createdAt: { type: Date, default: Date.now }
});

// ✅ FIX: Check if model exists before compiling
module.exports = mongoose.models.Order || mongoose.model('Order', orderSchema);