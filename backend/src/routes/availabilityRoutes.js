const express = require("express");
const authenticateToken = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");
const {
  listOwnAvailability,
  createAvailability,
  deleteOwnFutureAvailability,
} = require("../controllers/availabilityController");

const router = express.Router();

router.use(authenticateToken, authorizeRoles("interviewer"));
router.get("/", listOwnAvailability);
router.post("/", createAvailability);
router.delete("/:id", deleteOwnFutureAvailability);

module.exports = router;
