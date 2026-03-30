const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  item: { type: mongoose.Schema.Types.ObjectId, refPath: 'itemModel', required: true },
  
  // ✅ FIX 1: Added 'BiteSizeCourse'
  itemModel: { 
    type: String, 
    required: true, 
    enum: ['Course', 'Masterclass', 'Cohort', 'BiteSizeCourse'] 
  },
  
  amount: { type: Number, required: true },
  
  // ✅ FIX 2: Added 'trial' and 'standard'
  planType: { 
    type: String, 
    enum: ['recorded', 'live', 'trial', 'standard'], 
    default: 'recorded' 
  },
  
  paymentType: { type: String, enum: ['full', 'installment'], default: 'full' },
  razorpayOrderId: { type: String, required: true },
  razorpayPaymentId: { type: String },
  razorpaySignature: { type: String },
  status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
  couponUsed: { type: String }
  
}, { 
  // ✅ FIX 3: Automatically handles both createdAt and updatedAt
  timestamps: true 
});

module.exports = mongoose.models.Order || mongoose.model('Order', orderSchema);