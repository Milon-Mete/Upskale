const mongoose = require('mongoose');

const courseSchema = new mongoose.Schema({
  title: { type: String, required: true },
  slug: { type: String, unique: true },
  category: { 
    type: String, 
    required: true, 
    enum: ['bitsize', 'cohort', 'comprehensive'] 
  },

  pricing: {
    recorded: { type: Number, required: true }, // Full One-Time Price
    original: { type: Number }, // Crossed out price
    live: { type: Number },
    
    // ✅ 2-Part Manual Pricing
    installment: {
      enabled: { type: Boolean, default: false }, 
      pricePart1: { type: Number, default: 0 }, // First Payment
      pricePart2: { type: Number, default: 0 }, // Second Payment
      totalParts: { type: Number, default: 2 }  // Fixed at 2 parts
    }
  },

  thumbnail: { type: String, required: true },
  demoVideoUrl: { type: String },
  description: { type: String },
  tags: [String],
  level: { type: String, enum: ['Beginner', 'Intermediate', 'Advanced'], default: 'Beginner' },
  language: { type: String, default: 'English' },
  liveStartDate: { type: Date },
  enrolledCount: { type: Number, default: 0 },
  isPublished: { type: Boolean, default: false },
  averageRating: { type: Number, default: 0 },
  reviews: [{ studentName: String, rating: Number, comment: String }],
  content: [
    {
      chapterTitle: String,
      lessons: [
        {
          title: String,
          videoId: String,
          duration: String,
          isFreePreview: { type: Boolean, default: false },
          resources: [{ title: String, url: String }]
        }
      ]
    }
  ]
}, { timestamps: true });

// Auto-Slug Logic
courseSchema.pre('save', async function () {
  if (this.isModified('title') || this.isNew) {
    if (this.title) {
      this.slug = this.title.toLowerCase().trim()
        .replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '')
        + '-' + Date.now();
    }
  }
});

// ✅ FIX: Use this check to prevent "Cannot overwrite model once compiled" error
module.exports = mongoose.models.Course || mongoose.model('Course', courseSchema);