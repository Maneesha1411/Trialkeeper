const express = require("express");
const authenticateToken = require("../middleware/authMiddleware");
const {
  getOwnProfile,
  updateOwnProfile,
} = require("../controllers/profileController");

const router = express.Router();

router.use(authenticateToken);
router.get("/me", getOwnProfile);
router.patch("/me", updateOwnProfile);

module.exports = router;
