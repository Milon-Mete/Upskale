const User = require('../models/User');

const adminOnly = async (req, res, next) => {
  try {
    // ✅ FIX: Check Headers FIRST.
    // Also use safe navigation (req.body?) just in case body is undefined.
    const userId = req.headers['user-id'] || (req.body && req.body.userId);

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized: No User ID found in headers." });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(401).json({ message: "Unauthorized: User not found." });
    }

    if (user.role !== 'admin') {
      return res.status(403).json({ message: "Forbidden: Admins only." });
    }

    next(); // Permission granted
  } catch (error) {
    console.error("Middleware Crash:", error); // Log the actual error to your terminal
    res.status(500).json({ message: "Auth Error: Server crashed checking ID" });
  }
};

module.exports = { adminOnly };