const mongoose = require('mongoose');

const pricingSchema = new mongoose.Schema({
  price: { type: Number, required: true },
  duration: { type: String, required: true }, // e.g., "Month", "3 Days"
  active: { type: Boolean, default: true }
}, { _id: false });

const biteSizeCourseSchema = new mongoose.Schema({
  title: { type: String, required: true },
  highlight: { type: String, required: true }, // e.g., "EXCEL WITH AI"
  tag: { type: String, required: true }, // e.g., "AI Automation"
  highlightColor: { type: String, default: "text-emerald-400" },
  glowColor: { type: String, default: "md:group-hover:shadow-emerald-500/20" },
  image: { type: String, required: true }, // Cloudinary URL
  iconName: { type: String, required: true }, // e.g., "FileSpreadsheet"
  slug: { type: String, required: true, unique: true },
  isLocked: { type: Boolean, default: false },
  // Add this inside your biteSizeCourseSchema definition
  content: [{
    title: { type: String, required: true },
    videoUrl: { type: String, required: true }, // Link to Cloudinary/AWS/Mux
    description: { type: String },
    order: { type: Number, default: 0 }
  }],
  pricing: {
    trial: pricingSchema,
    standard: pricingSchema
  }
}, { timestamps: true });

module.exports = mongoose.model('BiteSizeCourse', biteSizeCourseSchema);