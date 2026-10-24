
const express = require("express");
const authenticateToken = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");
const {
  generateSchedule,
} = require("../controllers/scheduleController");

const router = express.Router();

router.use(authenticateToken, authorizeRoles("coordinator"));

router.post("/generate", generateSchedule);

module.exports = router;
