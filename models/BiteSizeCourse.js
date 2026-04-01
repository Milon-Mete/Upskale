const mongoose = require('mongoose');

// 1. Pricing Structure
const pricingSchema = new mongoose.Schema({
  price: { type: Number, required: true },
  duration: { type: String, required: true }, // e.g., "Month", "3 Days"
  active: { type: Boolean, default: true }
}, { _id: false });

// 2. Quiz Question Structure (For the 10-question certificate system)
const questionSchema = new mongoose.Schema({
  questionText: { type: String, required: true },
  options: [{ type: String, required: true }], // Array of 4 possible answers
  correctAnswer: { type: String, required: true } // Must match one of the options exactly
});

// 3. Main Bite-Sized Course Schema
const biteSizeCourseSchema = new mongoose.Schema({
  title: { type: String, required: true },
  highlight: { type: String, required: true }, // e.g., "EXCEL WITH AI"
  tag: { type: String, required: true }, // e.g., "AI Automation"
  highlightColor: { type: String, default: "text-emerald-400" },
  glowColor: { type: String, default: "md:group-hover:shadow-emerald-500/20" },
  image: { type: String, required: true }, // Main Course Thumbnail (Cloudinary URL)
  iconName: { type: String, required: true }, // e.g., "FileSpreadsheet"
  slug: { type: String, required: true, unique: true },
  isLocked: { type: Boolean, default: false },
  
  // 🔴 UPDATED CONTENT ARRAY (Seekho/Zudo Style Shorts)
  content: [{
    title: { type: String, required: true },
    description: { type: String },
    thumbnail: { type: String }, // Individual thumbnail for each short video
    videoUrl: { type: String, required: true }, // Link to Cloudinary
    order: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
  }],
  
  pricing: {
    trial: pricingSchema,
    standard: pricingSchema
  },

  // 🔴 NEW: CERTIFICATE QUIZ SYSTEM
  quiz: {
    enabled: { type: Boolean, default: false },
    passingScore: { type: Number, default: 70 }, // 70% threshold required to pass
    questions: [questionSchema] // Will hold the 10 questions the admin adds
  }
}, { timestamps: true });

module.exports = mongoose.model('BiteSizeCourse', biteSizeCourseSchema);