
const authorizeRoles = require("../middleware/roleMiddleware");
const express = require("express");

const {
  register,
  login,
} = require("../controllers/authController");

const authenticateToken = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/register", register);
router.post("/login", login);

// Protected endpoint: requires a valid JWT.
router.get("/me", authenticateToken, (req, res) => {
  res.status(200).json({
    message: "Authentication successful.",
    user: {
      id: req.user.userId,
      role: req.user.role,
    },
  });
});

router.get(
  "/coordinator-test",
  authenticateToken,
  authorizeRoles("coordinator"),
  (req, res) => {
    res.status(200).json({
      message: "Coordinator access granted!",
      role: req.user.role,
    });
  }
);

module.exports = router;
