const pool = require("../config/db");

const EVENT_FIELDS = [
  "id",
  "coordinator_id",
  "name",
  "time_zone",
  "start_date",
  "end_date",
  "candidate_buffer_minutes",
  "interviewer_buffer_minutes",
  "is_active",
  "created_at",
];

const CREATE_FIELDS = new Set([
  "name",
  "timeZone",
  "startDate",
  "endDate",
  "candidateBufferMinutes",
  "interviewerBufferMinutes",
]);

const PATCH_COLUMNS = {
  name: "name",
  timeZone: "time_zone",
  startDate: "start_date",
  endDate: "end_date",
  candidateBufferMinutes: "candidate_buffer_minutes",
  interviewerBufferMinutes: "interviewer_buffer_minutes",
  isActive: "is_active",
};

const errorResponse = (res, status, code, message) =>
  res.status(status).json({ error: { code, message } });

const isValidDatabaseId = (value, maxValue) => {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  ) {
    return false;
  }

  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) {
    return false;
  }

  try {
    return BigInt(text) <= BigInt(maxValue);
  } catch {
    return false;
  }
};

const isValidDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  if (year < 1) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
};

const isValidTimeZone = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() });
    return true;
  } catch (error) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
};

const isValidBuffer = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 2147483647;

const validateEventValues = (values) => {
  if (typeof values.name !== "string" || !values.name.trim()) {
    return "name must be a non-empty string.";
  }
  if (!isValidTimeZone(values.timeZone)) {
    return "timeZone must be a valid IANA timezone.";
  }
  if (!isValidDate(values.startDate) || !isValidDate(values.endDate)) {
    return "startDate and endDate must be valid dates in YYYY-MM-DD format.";
  }
  if (values.endDate < values.startDate) {
    return "endDate must be on or after startDate.";
  }
  if (!isValidBuffer(values.candidateBufferMinutes)) {
    return "candidateBufferMinutes must be a non-negative integer.";
  }
  if (!isValidBuffer(values.interviewerBufferMinutes)) {
    return "interviewerBufferMinutes must be a non-negative integer.";
  }
  return null;
};

const mapEvent = (row) => ({
  id: String(row.id),
  coordinatorId: row.coordinator_id,
  name: row.name,
  timeZone: row.time_zone,
  startDate: row.start_date,
  endDate: row.end_date,
  candidateBufferMinutes: row.candidate_buffer_minutes,
  interviewerBufferMinutes: row.interviewer_buffer_minutes,
  isActive: row.is_active,
  createdAt: row.created_at,
});

const requestUserId = (req) => {
  const max = req.user.role === "coordinator" ||
    req.user.role === "candidate" ||
    req.user.role === "interviewer"
    ? 2147483647
    : 0;
  return isValidDatabaseId(req.user.userId, max)
    ? Number(req.user.userId)
    : null;
};

const getEvents = async (req, res) => {
  const userId = requestUserId(req);
  if (userId === null) {
    return errorResponse(res, 401, "INVALID_TOKEN", "The authenticated user is invalid.");
  }

  let query;
  let values;
  if (req.user.role === "coordinator") {
    query = `SELECT ${EVENT_FIELDS.join(", ")}
             FROM events
             WHERE coordinator_id = $1
             ORDER BY start_date, id`;
    values = [userId];
  } else if (req.user.role === "candidate") {
    query = `SELECT ${EVENT_FIELDS.map((field) => `e.${field}`).join(", ")}
             FROM events e
             JOIN event_candidates ec ON ec.event_id = e.id
             WHERE ec.candidate_id = $1 AND e.is_active = TRUE
             ORDER BY e.start_date, e.id`;
    values = [userId];
  } else if (req.user.role === "interviewer") {
    query = `SELECT ${EVENT_FIELDS.map((field) => `e.${field}`).join(", ")}
             FROM events e
             WHERE e.is_active = TRUE
               AND EXISTS (
                 SELECT 1
                 FROM interviewer_availability a
                 WHERE a.interviewer_id = $1
                   AND a.start_time < ((e.end_date + 1)::timestamp AT TIME ZONE e.time_zone)
                   AND a.end_time > (e.start_date::timestamp AT TIME ZONE e.time_zone)
               )
             ORDER BY e.start_date, e.id`;
    values = [userId];
  } else {
    return errorResponse(res, 403, "FORBIDDEN", "You cannot view events.");
  }

  try {
    const result = await pool.query(query, values);
    return res.status(200).json({ events: result.rows.map(mapEvent) });
  } catch (error) {
    console.error("Event list error:", error.code || "database error");
    return errorResponse(
      res,
      500,
      "EVENT_QUERY_FAILED",
      "Events could not be retrieved due to a server error."
    );
  }
};

const getEventById = async (req, res) => {
  if (!isValidDatabaseId(req.params.id, 9223372036854775807n)) {
    return errorResponse(res, 400, "INVALID_EVENT_ID", "Event id must be a positive integer.");
  }

  const userId = requestUserId(req);
  if (userId === null) {
    return errorResponse(res, 401, "INVALID_TOKEN", "The authenticated user is invalid.");
  }

  let query;
  let values;
  if (req.user.role === "coordinator") {
    query = `SELECT ${EVENT_FIELDS.join(", ")}
             FROM events
             WHERE id = $1 AND coordinator_id = $2`;
    values = [req.params.id, userId];
  } else if (req.user.role === "candidate") {
    query = `SELECT ${EVENT_FIELDS.map((field) => `e.${field}`).join(", ")}
             FROM events e
             WHERE e.id = $1
               AND e.is_active = TRUE
               AND EXISTS (
                 SELECT 1 FROM event_candidates ec
                 WHERE ec.event_id = e.id AND ec.candidate_id = $2
               )`;
    values = [req.params.id, userId];
  } else if (req.user.role === "interviewer") {
    query = `SELECT ${EVENT_FIELDS.map((field) => `e.${field}`).join(", ")}
             FROM events e
             WHERE e.id = $1
               AND e.is_active = TRUE
               AND EXISTS (
                 SELECT 1
                 FROM interviewer_availability a
                 WHERE a.interviewer_id = $2
                   AND a.start_time < ((e.end_date + 1)::timestamp AT TIME ZONE e.time_zone)
                   AND a.end_time > (e.start_date::timestamp AT TIME ZONE e.time_zone)
               )`;
    values = [req.params.id, userId];
  } else {
    return errorResponse(res, 403, "FORBIDDEN", "You cannot view this event.");
  }

  try {
    const result = await pool.query(query, values);
    if (result.rows.length === 0) {
      return errorResponse(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    }
    return res.status(200).json({ event: mapEvent(result.rows[0]) });
  } catch (error) {
    console.error("Event lookup error:", error.code || "database error");
    return errorResponse(
      res,
      500,
      "EVENT_QUERY_FAILED",
      "Event could not be retrieved due to a server error."
    );
  }
};

const createEvent = async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse(res, 400, "INVALID_REQUEST", "Request body must be a JSON object.");
  }

  const unsupportedFields = Object.keys(body).filter((field) => !CREATE_FIELDS.has(field));
  if (unsupportedFields.length > 0) {
    return errorResponse(
      res,
      400,
      "INVALID_REQUEST",
      "Only event details and buffer settings may be provided; coordinatorId is assigned from your token."
    );
  }

  const values = {
    name: body.name,
    timeZone: body.timeZone,
    startDate: body.startDate,
    endDate: body.endDate,
    candidateBufferMinutes: body.candidateBufferMinutes ?? 0,
    interviewerBufferMinutes: body.interviewerBufferMinutes ?? 0,
  };
  const validationError = validateEventValues(values);
  if (validationError) {
    return errorResponse(res, 400, "INVALID_EVENT", validationError);
  }

  const coordinatorId = requestUserId(req);
  if (coordinatorId === null) {
    return errorResponse(res, 401, "INVALID_TOKEN", "The authenticated coordinator is invalid.");
  }

  try {
    const result = await pool.query(
      `INSERT INTO events
         (coordinator_id, name, time_zone, start_date, end_date,
          candidate_buffer_minutes, interviewer_buffer_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${EVENT_FIELDS.join(", ")}`,
      [
        coordinatorId,
        values.name.trim(),
        values.timeZone.trim(),
        values.startDate,
        values.endDate,
        values.candidateBufferMinutes,
        values.interviewerBufferMinutes,
      ]
    );
    return res.status(201).json({ event: mapEvent(result.rows[0]) });
  } catch (error) {
    if (error.code === "22023") {
      return errorResponse(res, 400, "INVALID_TIME_ZONE", "timeZone must be a valid IANA timezone.");
    }
    console.error("Event creation error:", error.code || "database error");
    return errorResponse(
      res,
      500,
      "EVENT_CREATE_FAILED",
      "Event could not be created due to a server error."
    );
  }
};

const updateEvent = async (req, res) => {
  if (!isValidDatabaseId(req.params.id, 9223372036854775807n)) {
    return errorResponse(res, 400, "INVALID_EVENT_ID", "Event id must be a positive integer.");
  }

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse(res, 400, "INVALID_REQUEST", "Request body must be a JSON object.");
  }

  const fields = Object.keys(body);
  if (fields.length === 0) {
    return errorResponse(res, 400, "INVALID_REQUEST", "Provide at least one event field to update.");
  }
  if (fields.some((field) => !Object.hasOwn(PATCH_COLUMNS, field))) {
    return errorResponse(
      res,
      400,
      "INVALID_REQUEST",
      "Only name, timeZone, startDate, endDate, buffer settings, and isActive may be updated."
    );
  }

  const coordinatorId = requestUserId(req);
  if (coordinatorId === null) {
    return errorResponse(res, 401, "INVALID_TOKEN", "The authenticated coordinator is invalid.");
  }

  try {
    const currentResult = await pool.query(
      `SELECT id, name, time_zone, start_date::text AS start_date,
              end_date::text AS end_date, candidate_buffer_minutes,
              interviewer_buffer_minutes, is_active
       FROM events
       WHERE id = $1 AND coordinator_id = $2`,
      [req.params.id, coordinatorId]
    );
    if (currentResult.rows.length === 0) {
      return errorResponse(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    }

    const current = currentResult.rows[0];
    const merged = {
      name: Object.hasOwn(body, "name") ? body.name : current.name,
      timeZone: Object.hasOwn(body, "timeZone") ? body.timeZone : current.time_zone,
      startDate: Object.hasOwn(body, "startDate") ? body.startDate : current.start_date,
      endDate: Object.hasOwn(body, "endDate") ? body.endDate : current.end_date,
      candidateBufferMinutes: Object.hasOwn(body, "candidateBufferMinutes")
        ? body.candidateBufferMinutes
        : current.candidate_buffer_minutes,
      interviewerBufferMinutes: Object.hasOwn(body, "interviewerBufferMinutes")
        ? body.interviewerBufferMinutes
        : current.interviewer_buffer_minutes,
    };
    const validationError = validateEventValues(merged);
    if (validationError) {
      return errorResponse(res, 400, "INVALID_EVENT", validationError);
    }
    if (Object.hasOwn(body, "isActive") && typeof body.isActive !== "boolean") {
      return errorResponse(res, 400, "INVALID_EVENT", "isActive must be a boolean.");
    }

    const assignments = [];
    const values = [];
    for (const field of fields) {
      values.push(field === "name" ? body[field].trim() :
        field === "timeZone" ? body[field].trim() : body[field]);
      assignments.push(`${PATCH_COLUMNS[field]} = $${values.length}`);
    }
    values.push(req.params.id, coordinatorId);

    const result = await pool.query(
      `UPDATE events
       SET ${assignments.join(", ")}
       WHERE id = $${values.length - 1}
         AND coordinator_id = $${values.length}
       RETURNING ${EVENT_FIELDS.join(", ")}`,
      values
    );
    if (result.rows.length === 0) {
      return errorResponse(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    }
    return res.status(200).json({ event: mapEvent(result.rows[0]) });
  } catch (error) {
    if (error.code === "22023") {
      return errorResponse(res, 400, "INVALID_TIME_ZONE", "timeZone must be a valid IANA timezone.");
    }
    if (error.code === "23514") {
      return errorResponse(res, 400, "INVALID_EVENT", "The updated event values violate a database constraint.");
    }
    console.error("Event update error:", error.code || "database error");
    return errorResponse(
      res,
      500,
      "EVENT_UPDATE_FAILED",
      "Event could not be updated due to a server error."
    );
  }
};

module.exports = { createEvent, getEvents, getEventById, updateEvent };
