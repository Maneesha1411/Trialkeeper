const authRoutes = require("./src/routes/authRoutes");
const profileRoutes = require("./src/routes/profileRoutes");
const availabilityRoutes = require("./src/routes/availabilityRoutes");
const bookingRoutes = require("./src/routes/bookingRoutes");
const express = require("express");
require("dotenv").config();
const pool = require("./src/config/db");
const app = express();
const scheduleRoutes = require("./src/routes/scheduleRoutes");
const eventRoutes = require("./src/routes/eventRoutes");

app.use(express.json());
app.use(require("cors")());
app.use("/api/auth", authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/availability", availabilityRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/schedules", scheduleRoutes);
app.use("/api/events", eventRoutes);

app.get("/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT current_database() AS database");

    res.status(200).json({
      status: "ok",
      message: "TrialKeeper backend is running!",
      database: result.rows[0].database,
    });
  } catch (error) {
    console.error("Database connection failed:", error.message);

    res.status(500).json({
      status: "error",
      message: "Database connection failed",
    });
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`TrialKeeper API running on port ${PORT}`);
});
