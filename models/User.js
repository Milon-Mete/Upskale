const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  email: { type: String, default: null },
  age: { type: Number, default: null },
  gender: { type: String, default: null },
  referredBy: { type: String, default: null },
  role: {
    type: String,
    enum: ['student', 'admin', 'instructor'],
    default: 'student'
  },

  enrolledCourses: [
    {
      item: { 
        type: mongoose.Schema.Types.ObjectId, 
        required: true, 
        refPath: 'enrolledCourses.itemModel' 
      },
      itemModel: { 
        type: String, 
        required: true, 
        enum: ['Course', 'Masterclass'] 
      },
      planType: { 
        type: String, 
        enum: ['recorded', 'live', 'masterclass'], 
        default: 'recorded' 
      },

      // --- 👇 NEW FIELDS FOR INSTALLMENT TRACKING 👇 ---
      paymentStatus: { 
        type: String, 
        enum: ['partial', 'full'], 
        default: 'full' 
      },
      amountPaid: { 
        type: Number, 
        default: 0 
      },
      // --------------------------------------------------

      purchasedAt: { type: Date, default: Date.now },
      progress: { type: Number, default: 0 },
      completedLessons: [{ type: String }],
      certificateUrl: { type: String, default: null }
    }
  ]
}, { timestamps: true });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);