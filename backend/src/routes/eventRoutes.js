const express = require("express");
const authenticateToken = require("../middleware/authMiddleware");
const authorizeRoles = require("../middleware/roleMiddleware");
const {
  createEvent,
  getEvents,
  getEventById,
  updateEvent,
} = require("../controllers/eventController");
const {
  getWorkingHours,
  createWorkingHour,
  deleteWorkingHour,
  getRounds,
  createRound,
  updateRound,
  deleteRound,
} = require("../controllers/eventConfigurationController");

const router = express.Router();

router.use(authenticateToken);
router.get("/", getEvents);
router.get("/:id/working-hours", authorizeRoles("coordinator"), getWorkingHours);
router.post("/:id/working-hours", authorizeRoles("coordinator"), createWorkingHour);
router.delete(
  "/:id/working-hours/:workingHourId",
  authorizeRoles("coordinator"),
  deleteWorkingHour
);
router.get("/:id/rounds", authorizeRoles("coordinator"), getRounds);
router.post("/:id/rounds", authorizeRoles("coordinator"), createRound);
router.patch("/:id/rounds/:roundId", authorizeRoles("coordinator"), updateRound);
router.delete("/:id/rounds/:roundId", authorizeRoles("coordinator"), deleteRound);
router.get("/:id", getEventById);
router.post("/", authorizeRoles("coordinator"), createEvent);
router.patch("/:id", authorizeRoles("coordinator"), updateEvent);

module.exports = router;
