const pool = require("../config/db");

const isValidTimestamp = (value) => {
  if (typeof value !== "string") {
    return false;
  }

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|([+-])(\d{2}):(\d{2}))$/
  );

  if (!match) {
    return false;
  }

  const [, year, month, day, hour, minute, second = "0", timezone, , offsetHour, offsetMinute] =
    match;
  const numericYear = Number(year);
  const numericMonth = Number(month);
  const isLeapYear =
    numericYear % 4 === 0 &&
    (numericYear % 100 !== 0 || numericYear % 400 === 0);
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][numericMonth - 1];

  if (
    Number(month) < 1 ||
    Number(month) > 12 ||
    Number(day) < 1 ||
    Number(day) > daysInMonth ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    return false;
  }

  if (
    timezone !== "Z" &&
    (Number(offsetHour) > 23 || Number(offsetMinute) > 59)
  ) {
    return false;
  }

  return !Number.isNaN(Date.parse(value));
};

const listOwnAvailability = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, start_time, end_time, created_at
       FROM interviewer_availability
       WHERE interviewer_id = $1
       ORDER BY start_time ASC`,
      [req.user.userId]
    );

    return res.status(200).json({
      availability: result.rows,
    });
  } catch (error) {
    console.error("Availability lookup error:", error.message);

    return res.status(500).json({
      message: "Could not retrieve availability due to a server error.",
    });
  }
};

const createAvailability = async (req, res) => {
  const { startTime, endTime } = req.body || {};
  const requestFields = req.body && typeof req.body === "object"
    ? Object.keys(req.body)
    : [];

  if (
    !req.body ||
    typeof req.body !== "object" ||
    Array.isArray(req.body) ||
    requestFields.some(
      (field) => !["startTime", "endTime"].includes(field)
    )
  ) {
    return res.status(400).json({
      message: "Request body must contain only startTime and endTime.",
    });
  }

  if (!isValidTimestamp(startTime) || !isValidTimestamp(endTime)) {
    return res.status(400).json({
      message: "startTime and endTime must be valid ISO 8601 timestamps with a timezone.",
    });
  }

  if (Date.parse(endTime) <= Date.parse(startTime)) {
    return res.status(400).json({
      message: "endTime must be later than startTime.",
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO interviewer_availability
         (interviewer_id, start_time, end_time)
       VALUES ($1, $2, $3)
       RETURNING id, start_time, end_time, created_at`,
      [req.user.userId, startTime, endTime]
    );

    return res.status(201).json({
      message: "Availability created successfully.",
      availability: result.rows[0],
    });
  } catch (error) {
    if (error.code === "23P01") {
      return res.status(409).json({
        message: "This availability overlaps an existing slot.",
      });
    }

    console.error("Availability creation error:", error.message);

    return res.status(500).json({
      message: "Could not create availability due to a server error.",
    });
  }
};

const deleteOwnFutureAvailability = async (req, res) => {
  const { id } = req.params;

  if (!/^[1-9]\d*$/.test(id) || BigInt(id) > 9223372036854775807n) {
    return res.status(400).json({
      message: "Availability id must be a positive integer.",
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
      `SELECT id
       FROM interviewer_availability
       WHERE id = $1
         AND interviewer_id = $2
         AND start_time > clock_timestamp()
       FOR UPDATE`,
      [id, req.user.userId]
    );

    if (slotResult.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(404).json({
        message: "Future availability slot not found.",
      });
    }

    const activeHoldResult = await client.query(
      `SELECT availability_id
       FROM availability_holds
       WHERE availability_id = $1
         AND expires_at > clock_timestamp()`,
      [id]
    );

    const bookingResult = await client.query(
      `SELECT availability_id
       FROM interview_bookings
       WHERE availability_id = $1`,
      [id]
    );

    if (activeHoldResult.rows.length > 0 || bookingResult.rows.length > 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(409).json({
        message: "Availability with an active hold or confirmed booking cannot be deleted.",
      });
    }

    const result = await client.query(
      `DELETE FROM interviewer_availability
       WHERE id = $1
         AND interviewer_id = $2
       RETURNING id`,
      [id, req.user.userId]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(404).json({
        message: "Future availability slot not found.",
      });
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(200).json({
      message: "Availability deleted successfully.",
    });
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        clientError = rollbackError;
        console.error("Availability deletion rollback error:", rollbackError.code || "database error");
      }
    }

    if (error.code === "23503") {
      return res.status(409).json({
        message: "Availability with a confirmed booking cannot be deleted.",
      });
    }

    console.error("Availability deletion error:", error.code || "database error");

    return res.status(500).json({
      message: "Could not delete availability due to a server error.",
    });
  } finally {
    if (client) {
      client.release(clientError);
    }
  }
};

module.exports = {
  listOwnAvailability,
  createAvailability,
  deleteOwnFutureAvailability,
};
