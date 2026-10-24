const pool = require("../config/db");

const MAX_BIGINT = 9223372036854775807n;
const MAX_INTEGER = 2147483647n;

const errorResponse = (res, status, code, message) =>
  res.status(status).json({ error: { code, message } });

const isPositiveIntegerId = (value, maximum) => {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*$/.test(value)
  ) {
    return false;
  }
  try {
    return BigInt(value) <= maximum;
  } catch {
    return false;
  }
};

const toPathId = (value) =>
  typeof value === "string" ? value : "";

const coordinatorIdFromRequest = (req) => {
  const value = req.user && req.user.userId;
  const id = typeof value === "number" ? String(value) : value;
  return isPositiveIntegerId(id, MAX_INTEGER) ? id : null;
};

const validateRequestIds = (req, res, candidateRequired = false) => {
  const eventId = toPathId(req.params.id);
  if (!isPositiveIntegerId(eventId, MAX_BIGINT)) {
    errorResponse(res, 400, "INVALID_EVENT_ID", "Event id must be a positive integer.");
    return null;
  }

  const coordinatorId = coordinatorIdFromRequest(req);
  if (coordinatorId === null) {
    errorResponse(res, 401, "INVALID_TOKEN", "The authenticated coordinator is invalid.");
    return null;
  }

  if (candidateRequired) {
    const candidateId = toPathId(req.params.candidateId);
    if (!isPositiveIntegerId(candidateId, MAX_INTEGER)) {
      errorResponse(
        res,
        400,
        "INVALID_CANDIDATE_ID",
        "Candidate id must be a positive integer."
      );
      return null;
    }
    return { eventId, coordinatorId, candidateId };
  }

  return { eventId, coordinatorId };
};

const validateOwnedEvent = async (eventId, coordinatorId) => {
  const result = await pool.query(
    "SELECT id FROM events WHERE id = $1 AND coordinator_id = $2",
    [eventId, coordinatorId]
  );
  return result.rows.length > 0;
};

const databaseError = (res, error, operation) => {
  if (error.code === "23505") {
    return errorResponse(
      res,
      409,
      "CANDIDATE_ALREADY_ENROLLED",
      "This candidate is already enrolled in the event."
    );
  }
  if (error.code === "23503") {
    return errorResponse(
      res,
      404,
      "ENROLLMENT_REFERENCE_NOT_FOUND",
      "The event or candidate no longer exists."
    );
  }
  if (error.code === "22P02" || error.code === "22003") {
    return errorResponse(
      res,
      400,
      "INVALID_ENROLLMENT_ID",
      "Event and candidate ids must be valid positive integers."
    );
  }
  console.error(`${operation} error:`, error.code || "database error");
  return errorResponse(
    res,
    500,
    "ENROLLMENT_REQUEST_FAILED",
    "The enrollment request could not be completed due to a server error."
  );
};

const validateBody = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object.";
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "candidateId") {
    return "Provide only candidateId.";
  }
  if (
    typeof body.candidateId !== "number" ||
    !Number.isSafeInteger(body.candidateId) ||
    body.candidateId < 1 ||
    BigInt(body.candidateId) > MAX_INTEGER
  ) {
    return "candidateId must be a positive integer.";
  }
  return null;
};

const getEventCandidates = async (req, res) => {
  const ids = validateRequestIds(req, res);
  if (!ids) {
    return;
  }

  try {
    if (!(await validateOwnedEvent(ids.eventId, ids.coordinatorId))) {
      return errorResponse(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    }

    const result = await pool.query(
      `SELECT u.id AS candidate_id, u.name, u.email, ec.enrolled_at
       FROM event_candidates ec
       JOIN users u
         ON u.id = ec.candidate_id
        AND u.role = 'candidate'
       WHERE ec.event_id = $1
       ORDER BY ec.enrolled_at, u.id`,
      [ids.eventId]
    );

    return res.status(200).json({
      candidates: result.rows.map((row) => ({
        candidateId: row.candidate_id,
        name: row.name,
        email: row.email,
        enrolledAt: row.enrolled_at,
      })),
    });
  } catch (error) {
    return databaseError(res, error, "Event candidate list");
  }
};

const enrollCandidate = async (req, res) => {
  const bodyError = validateBody(req.body);
  if (bodyError) {
    return errorResponse(res, 400, "INVALID_ENROLLMENT", bodyError);
  }

  const ids = validateRequestIds(req, res);
  if (!ids) {
    return;
  }
  const candidateId = String(req.body.candidateId);

  try {
    if (!(await validateOwnedEvent(ids.eventId, ids.coordinatorId))) {
      return errorResponse(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    }

    const candidateResult = await pool.query(
      "SELECT id, role FROM users WHERE id = $1",
      [candidateId]
    );
    if (candidateResult.rows.length === 0) {
      return errorResponse(res, 404, "CANDIDATE_NOT_FOUND", "Candidate not found.");
    }
    if (candidateResult.rows[0].role !== "candidate") {
      return errorResponse(
        res,
        422,
        "USER_NOT_A_CANDIDATE",
        "Only users with the candidate role can be enrolled."
      );
    }

    const result = await pool.query(
      `INSERT INTO event_candidates (event_id, candidate_id)
       VALUES ($1, $2)
       RETURNING event_id, candidate_id, enrolled_at`,
      [ids.eventId, candidateId]
    );
    const enrollment = result.rows[0];
    return res.status(201).json({
      enrollment: {
        eventId: String(enrollment.event_id),
        candidateId: enrollment.candidate_id,
        enrolledAt: enrollment.enrolled_at,
      },
    });
  } catch (error) {
    return databaseError(res, error, "Candidate enrollment");
  }
};

const removeCandidate = async (req, res) => {
  const ids = validateRequestIds(req, res, true);
  if (!ids) {
    return;
  }

  try {
    if (!(await validateOwnedEvent(ids.eventId, ids.coordinatorId))) {
      return errorResponse(res, 404, "EVENT_NOT_FOUND", "Event not found.");
    }

    // The schema cascades this deletion to event_candidate_availability only.
    // Bookings and holds are not event-linked and are deliberately untouched.
    const result = await pool.query(
      `DELETE FROM event_candidates
       WHERE event_id = $1 AND candidate_id = $2
       RETURNING event_id, candidate_id`,
      [ids.eventId, ids.candidateId]
    );
    if (result.rows.length === 0) {
      return errorResponse(
        res,
        404,
        "ENROLLMENT_NOT_FOUND",
        "Candidate is not enrolled in this event."
      );
    }

    return res.status(200).json({
      message: "Candidate enrollment removed successfully.",
      eventId: String(result.rows[0].event_id),
      candidateId: result.rows[0].candidate_id,
    });
  } catch (error) {
    return databaseError(res, error, "Candidate enrollment removal");
  }
};

module.exports = {
  getEventCandidates,
  enrollCandidate,
  removeCandidate,
};
