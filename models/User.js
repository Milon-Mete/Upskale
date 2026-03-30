// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  email: { type: String, default: null },
  age: { type: Number, default: null },
  gender: { type: String, default: null },
  referredBy: { type: String, default: null }, // <- Keeps the original referrer's ID or Phone
  role: { type: String, enum: ['student', 'admin', 'instructor'], default: 'student' },

  // --- ENROLLMENTS ARRAY ---
  enrolledCourses: [
    {
      item: { 
        type: mongoose.Schema.Types.ObjectId, 
        required: true, 
        refPath: 'enrolledCourses.itemModel' // Tells Mongoose where to look dynamically
      },
      itemModel: { 
        type: String, 
        required: true, 
        // ✅ ADDED: 'BiteSizeCourse' (Safe for existing data)
        enum: ['Course', 'Masterclass', 'Cohort', 'BiteSizeCourse'] 
      },
      planType: { 
        type: String, 
        // ✅ ADDED: 'trial' and 'standard' (Safe for existing data)
        enum: ['recorded', 'live', 'trial', 'standard'], 
        default: 'recorded' 
      },
      paymentStatus: { 
        type: String, 
        enum: ['partial', 'full'], 
        default: 'full' 
      },
      amountPaid: { type: Number, default: 0 },
      purchasedAt: { type: Date, default: Date.now },
      progress: { type: Number, default: 0 },
      completedLessons: [{ type: String }],
      certificateUrl: { type: String, default: null },
      issuedDate: { type: String, default: null },
      score: { type: Number, default: null }
    }
  ],

  // --- NEW ADDITION FOR REFERRAL SYSTEM ---
  walletBalance: { type: Number, default: 0 } // Tracks total money earned

}, { timestamps: true });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);