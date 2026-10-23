const express = require("express");
const authenticateToken = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");
const {
  createHold,
  confirmBooking,
} = require("../controllers/bookingController");

const router = express.Router();

router.use(authenticateToken, authorizeRoles("candidate"));
router.post("/holds", createHold);
router.post("/confirm", confirmBooking);

module.exports = router;
