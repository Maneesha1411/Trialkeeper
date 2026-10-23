const pool = require("../config/db");

const isValidAvailabilityId = (value) =>
  typeof value === "string" &&
  /^[1-9]\d*$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;

const rollback = async (client) => {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    console.error("Booking transaction rollback error:", error.code || "database error");
    return error;
  }
};

const createHold = async (req, res) => {
  const { availabilityId } = req.body || {};
  const fields = req.body && typeof req.body === "object"
    ? Object.keys(req.body)
    : [];

  if (
    !req.body ||
    typeof req.body !== "object" ||
    Array.isArray(req.body) ||
    fields.length !== 1 ||
    fields[0] !== "availabilityId" ||
    !isValidAvailabilityId(availabilityId)
  ) {
    return res.status(400).json({
      message: "Provide a valid availabilityId.",
    });
  }

  let client;
  let clientError;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    const slotResult = await client.query(
      `SELECT id, start_time > clock_timestamp() AS is_future
       FROM interviewer_availability
       WHERE id = $1
       FOR UPDATE`,
      [availabilityId]
    );

    if (slotResult.rows.length === 0) {
      clientError = await rollback(client);
      transactionStarted = false;
      return res.status(404).json({
        message: "Availability slot not found.",
      });
    }

    if (!slotResult.rows[0].is_future) {
      clientError = await rollback(client);
      transactionStarted = false;
      return res.status(409).json({
        message: "Past availability slots cannot be held.",
      });
    }

    const bookingResult = await client.query(
      `SELECT id
       FROM interview_bookings
       WHERE availability_id = $1`,
      [availabilityId]
    );

    if (bookingResult.rows.length > 0) {
      clientError = await rollback(client);
      transactionStarted = false;
      return res.status(409).json({
        message: "This availability slot is already booked.",
      });
    }

    await client.query(
      `DELETE FROM availability_holds
       WHERE availability_id = $1
         AND expires_at <= clock_timestamp()`,
      [availabilityId]
    );

    const existingHoldResult = await client.query(
      `SELECT candidate_id, expires_at,
              expires_at > clock_timestamp() AS is_active
       FROM availability_holds
       WHERE availability_id = $1
         AND expires_at > clock_timestamp()
       FOR UPDATE`,
      [availabilityId]
    );

    const existingHold = existingHoldResult.rows[0];

    if (existingHold) {
      if (String(existingHold.candidate_id) !== String(req.user.userId)) {
        clientError = await rollback(client);
        transactionStarted = false;
        return res.status(409).json({
          message: "This availability slot is held by another candidate.",
        });
      }

      await client.query("COMMIT");
      transactionStarted = false;
      return res.status(200).json({
        message: "Availability slot is already held by you.",
        hold: {
          availabilityId,
          expiresAt: existingHold.expires_at,
        },
      });
    }

    const holdResult = await client.query(
      `WITH hold_clock AS (
         SELECT clock_timestamp() AS created_at
       )
       INSERT INTO availability_holds
         (availability_id, candidate_id, expires_at, created_at)
       SELECT $1, $2, hold_clock.created_at + INTERVAL '5 minutes',
              hold_clock.created_at
       FROM hold_clock
       RETURNING availability_id, candidate_id, expires_at, created_at`,
      [availabilityId, req.user.userId]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(201).json({
      message: "Availability slot held for five minutes.",
      hold: holdResult.rows[0],
    });
  } catch (error) {
    if (transactionStarted) {
      clientError = await rollback(client);
    }

    if (error.code === "23505") {
      return res.status(409).json({
        message: "This availability slot is no longer available.",
      });
    }

    console.error("Availability hold error:", error.code || "database error");

    return res.status(500).json({
      message: "Could not hold availability due to a server error.",
    });
  } finally {
    if (client) {
      client.release(clientError);
    }
  }
};

const confirmBooking = async (req, res) => {
  const { availabilityId } = req.body || {};
  const fields = req.body && typeof req.body === "object"
    ? Object.keys(req.body)
    : [];

  if (
    !req.body ||
    typeof req.body !== "object" ||
    Array.isArray(req.body) ||
    fields.length !== 1 ||
    fields[0] !== "availabilityId" ||
    !isValidAvailabilityId(availabilityId)
  ) {
    return res.status(400).json({
      message: "Provide a valid availabilityId.",
    });
  }

  let client;
  let clientError;
  let transactionStarted = false;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    const slotResult = await client.query(
      `SELECT id, start_time > clock_timestamp() AS is_future
       FROM interviewer_availability
       WHERE id = $1
       FOR UPDATE`,
      [availabilityId]
    );

    if (slotResult.rows.length === 0) {
      clientError = await rollback(client);
      transactionStarted = false;
      return res.status(404).json({
        message: "Availability slot not found.",
      });
    }

    if (!slotResult.rows[0].is_future) {
      clientError = await rollback(client);
      transactionStarted = false;
      return res.status(409).json({
        message: "Past availability slots cannot be booked.",
      });
    }

    const bookingResult = await client.query(
      `SELECT id
       FROM interview_bookings
       WHERE availability_id = $1`,
      [availabilityId]
    );

    if (bookingResult.rows.length > 0) {
      clientError = await rollback(client);
      transactionStarted = false;
      return res.status(409).json({
        message: "This availability slot is already booked.",
      });
    }

    const holdResult = await client.query(
      `SELECT candidate_id, expires_at,
              expires_at > clock_timestamp() AS is_active
       FROM availability_holds
       WHERE availability_id = $1
       FOR UPDATE`,
      [availabilityId]
    );

    const hold = holdResult.rows[0];

    if (!hold) {
      clientError = await rollback(client);
      transactionStarted = false;
      return res.status(409).json({
        message: "No active hold exists for this availability slot.",
      });
    }

    if (!hold.is_active) {
      await client.query(
        `DELETE FROM availability_holds
         WHERE availability_id = $1
           AND expires_at <= clock_timestamp()`,
        [availabilityId]
      );
      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(410).json({
        message: "The availability hold has expired.",
      });
    }

    if (String(hold.candidate_id) !== String(req.user.userId)) {
      clientError = await rollback(client);
      transactionStarted = false;
      return res.status(409).json({
        message: "This availability slot is held by another candidate.",
      });
    }

    const newBookingResult = await client.query(
      `INSERT INTO interview_bookings (availability_id, candidate_id)
       SELECT availability_id, $2
       FROM availability_holds
       WHERE availability_id = $1
         AND candidate_id = $2
         AND expires_at > clock_timestamp()
       RETURNING id, availability_id, candidate_id, created_at`,
      [availabilityId, req.user.userId]
    );

    if (newBookingResult.rows.length === 0) {
      await client.query(
        `DELETE FROM availability_holds
         WHERE availability_id = $1
           AND expires_at <= clock_timestamp()`,
        [availabilityId]
      );
      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(410).json({
        message: "The availability hold has expired.",
      });
    }

    const deletedHoldResult = await client.query(
      `DELETE FROM availability_holds
       WHERE availability_id = $1
         AND candidate_id = $2
       RETURNING availability_id`,
      [availabilityId, req.user.userId]
    );

    if (deletedHoldResult.rows.length !== 1) {
      throw new Error("The candidate hold changed during booking confirmation.");
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(201).json({
      message: "Interview booking confirmed.",
      booking: newBookingResult.rows[0],
    });
  } catch (error) {
    if (transactionStarted) {
      clientError = await rollback(client);
    }

    if (error.code === "23505") {
      return res.status(409).json({
        message: "This availability slot is already booked.",
      });
    }

    console.error("Booking confirmation error:", error.code || "database error");

    return res.status(500).json({
      message: "Could not confirm booking due to a server error.",
    });
  } finally {
    if (client) {
      client.release(clientError);
    }
  }
};

module.exports = { createHold, confirmBooking };
