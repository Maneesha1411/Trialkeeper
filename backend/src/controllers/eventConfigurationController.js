const pool = require("../config/db");

const WEEKDAYS = new Set([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);
const MAX_BIGINT = 9223372036854775807n;
const MAX_INTEGER = 2147483647;

const errorResponse = (res, status, code, message) =>
  res.status(status).json({ error: { code, message } });

const isPositiveId = (value, maximum = MAX_BIGINT) => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    return false;
  }
  try {
    return BigInt(value) <= maximum;
  } catch {
    return false;
  }
};

const requestCoordinatorId = (req) => {
  const value = req.user && req.user.userId;
  const text = typeof value === "number" ? String(value) : value;
  return isPositiveId(text, BigInt(MAX_INTEGER)) ? text : null;
};

const validateEventRoute = (req, res) => {
  if (!isPositiveId(req.params.id)) {
    errorResponse(res, 400, "INVALID_EVENT_ID", "Event id must be a positive integer.");
    return false;
  }
  const coordinatorId = requestCoordinatorId(req);
  if (coordinatorId === null) {
    errorResponse(res, 401, "INVALID_TOKEN", "The authenticated coordinator is invalid.");
    return false;
  }
  return true;
};

const validateOwnedEvent = async (req, res) => {
  const result = await pool.query(
    "SELECT id FROM events WHERE id = $1 AND coordinator_id = $2",
    [req.params.id, requestCoordinatorId(req)]
  );
  if (result.rows.length === 0) {
    errorResponse(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    return false;
  }
  return true;
};

const respondToDatabaseError = (res, error, operation) => {
  if (error.code === "23505") {
    return errorResponse(
      res,
      409,
      "CONFIGURATION_CONFLICT",
      "The requested event configuration conflicts with an existing entry."
    );
  }
  if (error.code === "23514" || error.code === "22P02") {
    return errorResponse(
      res,
      400,
      "INVALID_CONFIGURATION",
      "The event configuration violates a database constraint."
    );
  }
  if (error.code === "23503") {
    return errorResponse(res, 404, "EVENT_NOT_FOUND", "Event not found.");
  }
  console.error(`${operation} error:`, error.code || "database error");
  return errorResponse(
    res,
    500,
    "EVENT_CONFIGURATION_FAILED",
    "Event configuration could not be processed due to a server error."
  );
};

const withOwnedEvent = async (req, res, operation, action) => {
  if (!validateEventRoute(req, res)) {
    return;
  }
  try {
    if (!(await validateOwnedEvent(req, res))) {
      return;
    }
    await action();
  } catch (error) {
    respondToDatabaseError(res, error, operation);
  }
};

const isRequestObject = (body) =>
  body !== null && typeof body === "object" && !Array.isArray(body);

const validateTime = (value) => {
  if (
    typeof value !== "string" ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/.test(value)
  ) {
    return null;
  }
  const [hours, minutes, seconds = "0"] = value.split(":");
  const totalSeconds =
    Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return { value, totalSeconds };
};

const validateWorkingHour = (body) => {
  if (!isRequestObject(body)) {
    return { error: "Request body must be a JSON object." };
  }
  const allowedFields = new Set(["dayOfWeek", "startTime", "endTime"]);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    return { error: "Only dayOfWeek, startTime, and endTime may be provided." };
  }

  const dayOfWeek =
    typeof body.dayOfWeek === "string" ? body.dayOfWeek.toUpperCase() : "";
  const startTime = validateTime(body.startTime);
  const endTime = validateTime(body.endTime);
  if (!WEEKDAYS.has(dayOfWeek)) {
    return { error: "dayOfWeek must be a valid weekday." };
  }
  if (!startTime || !endTime) {
    return { error: "startTime and endTime must be valid local times in HH:MM format." };
  }
  if (endTime.totalSeconds <= startTime.totalSeconds) {
    return { error: "endTime must be later than startTime." };
  }
  return {
    value: {
      dayOfWeek,
      startTime: startTime.value,
      endTime: endTime.value,
    },
  };
};

const validateSkills = (skills) =>
  Array.isArray(skills) &&
  skills.length <= 50 &&
  skills.every(
    (skill) =>
      typeof skill === "string" &&
      skill.trim().length > 0 &&
      skill.trim().length <= 100
  );

const validateRoundValues = (body, { partial = false } = {}) => {
  if (!isRequestObject(body)) {
    return { error: "Request body must be a JSON object." };
  }
  const allowedFields = partial
    ? new Set(["order", "durationMinutes", "requiredSkills"])
    : new Set(["roundId", "order", "durationMinutes", "requiredSkills"]);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    return {
      error: partial
        ? "Only order, durationMinutes, and requiredSkills may be updated."
        : "Only roundId, order, durationMinutes, and requiredSkills may be provided.",
    };
  }
  if (Object.keys(body).length === 0) {
    return {
      error: partial
        ? "Provide at least one round field to update."
        : "Round details are required.",
    };
  }

  const value = {};
  if (!partial || Object.hasOwn(body, "roundId")) {
    if (
      typeof body.roundId !== "string" ||
      !body.roundId.trim() ||
      body.roundId.trim().length > 100
    ) {
      return { error: "roundId must be a non-empty string of at most 100 characters." };
    }
    value.roundId = body.roundId.trim();
  }
  if (!partial || Object.hasOwn(body, "order")) {
    if (!Number.isInteger(body.order) || body.order < 1 || body.order > MAX_INTEGER) {
      return { error: "order must be a positive integer." };
    }
    value.order = body.order;
  }
  if (!partial || Object.hasOwn(body, "durationMinutes")) {
    if (
      !Number.isInteger(body.durationMinutes) ||
      body.durationMinutes < 1 ||
      body.durationMinutes > MAX_INTEGER
    ) {
      return { error: "durationMinutes must be a positive integer." };
    }
    value.durationMinutes = body.durationMinutes;
  }
  if (Object.hasOwn(body, "requiredSkills")) {
    if (!validateSkills(body.requiredSkills)) {
      return {
        error: "requiredSkills must be an array of up to 50 non-empty strings, each at most 100 characters.",
      };
    }
    value.requiredSkills = [...new Set(body.requiredSkills.map((skill) => skill.trim()))];
  } else if (!partial) {
    value.requiredSkills = [];
  }
  return { value };
};

const mapWorkingHour = (row) => ({
  id: String(row.id),
  dayOfWeek: row.day_of_week,
  startTime: row.start_time,
  endTime: row.end_time,
});

const mapRound = (row) => ({
  roundId: row.round_id,
  order: Number(row.round_order),
  durationMinutes: Number(row.duration_minutes),
  requiredSkills: row.required_skills,
});

const getWorkingHours = async (req, res) => {
  await withOwnedEvent(req, res, "Working-hours lookup", async () => {
    const result = await pool.query(
      `SELECT id, day_of_week, start_time, end_time
       FROM event_working_hours
       WHERE event_id = $1
       ORDER BY day_of_week, start_time, id`,
      [req.params.id]
    );
    return res.status(200).json({
      workingHours: result.rows.map(mapWorkingHour),
    });
  });
};

const createWorkingHour = async (req, res) => {
  const validated = validateWorkingHour(req.body);
  if (validated.error) {
    return errorResponse(res, 400, "INVALID_WORKING_HOURS", validated.error);
  }
  await withOwnedEvent(req, res, "Working-hours creation", async () => {
    const { dayOfWeek, startTime, endTime } = validated.value;
    const result = await pool.query(
      `INSERT INTO event_working_hours
         (event_id, day_of_week, start_time, end_time)
       VALUES ($1, $2, $3, $4)
       RETURNING id, day_of_week, start_time, end_time`,
      [req.params.id, dayOfWeek, startTime, endTime]
    );
    return res.status(201).json({ workingHour: mapWorkingHour(result.rows[0]) });
  });
};

const deleteWorkingHour = async (req, res) => {
  if (!isPositiveId(req.params.workingHourId)) {
    return errorResponse(
      res,
      400,
      "INVALID_WORKING_HOUR_ID",
      "Working-hour id must be a positive integer."
    );
  }
  await withOwnedEvent(req, res, "Working-hours deletion", async () => {
    const result = await pool.query(
      `DELETE FROM event_working_hours
       WHERE id = $1 AND event_id = $2
       RETURNING id`,
      [req.params.workingHourId, req.params.id]
    );
    if (result.rows.length === 0) {
      return errorResponse(res, 404, "WORKING_HOUR_NOT_FOUND", "Working hour not found.");
    }
    return res.status(200).json({
      message: "Working hour deleted successfully.",
      workingHourId: String(result.rows[0].id),
    });
  });
};

const getRounds = async (req, res) => {
  await withOwnedEvent(req, res, "Round lookup", async () => {
    const result = await pool.query(
      `SELECT round_id, round_order, duration_minutes, required_skills
       FROM event_rounds
       WHERE event_id = $1
       ORDER BY round_order`,
      [req.params.id]
    );
    return res.status(200).json({ rounds: result.rows.map(mapRound) });
  });
};

const createRound = async (req, res) => {
  const validated = validateRoundValues(req.body);
  if (validated.error) {
    return errorResponse(res, 400, "INVALID_ROUND", validated.error);
  }
  await withOwnedEvent(req, res, "Round creation", async () => {
    const { roundId, order, durationMinutes, requiredSkills } = validated.value;
    const result = await pool.query(
      `INSERT INTO event_rounds
         (event_id, round_id, round_order, duration_minutes, required_skills)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING round_id, round_order, duration_minutes, required_skills`,
      [req.params.id, roundId, order, durationMinutes, requiredSkills]
    );
    return res.status(201).json({ round: mapRound(result.rows[0]) });
  });
};

const updateRound = async (req, res) => {
  const validated = validateRoundValues(req.body, { partial: true });
  if (validated.error) {
    return errorResponse(res, 400, "INVALID_ROUND", validated.error);
  }
  await withOwnedEvent(req, res, "Round update", async () => {
    const columns = {
      order: "round_order",
      durationMinutes: "duration_minutes",
      requiredSkills: "required_skills",
    };
    const values = [];
    const assignments = [];
    for (const [field, column] of Object.entries(columns)) {
      if (Object.hasOwn(validated.value, field)) {
        values.push(validated.value[field]);
        assignments.push(`${column} = $${values.length}`);
      }
    }
    values.push(req.params.id, req.params.roundId);
    const result = await pool.query(
      `UPDATE event_rounds
       SET ${assignments.join(", ")}
       WHERE event_id = $${values.length - 1} AND round_id = $${values.length}
       RETURNING round_id, round_order, duration_minutes, required_skills`,
      values
    );
    if (result.rows.length === 0) {
      return errorResponse(res, 404, "ROUND_NOT_FOUND", "Interview round not found.");
    }
    return res.status(200).json({ round: mapRound(result.rows[0]) });
  });
};

const deleteRound = async (req, res) => {
  await withOwnedEvent(req, res, "Round deletion", async () => {
    const result = await pool.query(
      `DELETE FROM event_rounds
       WHERE event_id = $1 AND round_id = $2
       RETURNING round_id`,
      [req.params.id, req.params.roundId]
    );
    if (result.rows.length === 0) {
      return errorResponse(res, 404, "ROUND_NOT_FOUND", "Interview round not found.");
    }
    return res.status(200).json({
      message: "Interview round deleted successfully.",
      roundId: result.rows[0].round_id,
    });
  });
};

module.exports = {
  getWorkingHours,
  createWorkingHour,
  deleteWorkingHour,
  getRounds,
  createRound,
  updateRound,
  deleteRound,
};
