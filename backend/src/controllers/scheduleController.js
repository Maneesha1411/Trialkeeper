const pool = require("../config/db");
const { loadSchedulingRequest } = require("../services/schedulingDataService");
const { requestSchedule } = require("../services/schedulingSolverClient");
const { validateSolverResponse } = require("../services/schedulingValidation");

const errorResponse = (code, message, path) => ({
  status: "error",
  message,
  schedule: [],
  unscheduled: [],
  errors: [{ code, message, ...(path ? { path } : {}) }],
});

const isValidEventId = (value) => {
  if (
    typeof value !== "string" &&
    !(typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return false;
  }
  const stringValue = String(value);
  return (
    /^[1-9]\d{0,18}$/.test(stringValue) &&
    BigInt(stringValue) <= 9223372036854775807n
  );
};

const generateSchedule = async (req, res) => {
  if (
    !req.body ||
    typeof req.body !== "object" ||
    Array.isArray(req.body) ||
    Object.keys(req.body).length !== 1 ||
    !Object.hasOwn(req.body, "eventId") ||
    !isValidEventId(req.body.eventId)
  ) {
    return res.status(400).json(
      errorResponse(
        "INVALID_REQUEST",
        "Request body must contain only a valid eventId.",
        "eventId"
      )
    );
  }

  try {
    const schedulingRequest = await loadSchedulingRequest(
      pool,
      String(req.body.eventId),
      req.user.userId
    );
    const solverResult = await requestSchedule(schedulingRequest);

    try {
      validateSolverResponse(solverResult.body, schedulingRequest);
    } catch (error) {
      console.error("Scheduling solver response validation failed:", error.code);
      return res.status(502).json(
        errorResponse(
          error.code || "INVALID_SOLVER_RESPONSE",
          "The scheduling solver returned an invalid schedule.",
          error.path
        )
      );
    }

    return res.status(solverResult.httpStatus).json(solverResult.body);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json(
        errorResponse(error.code, error.message, error.path)
      );
    }

    console.error("Schedule generation database error:", error.code || "database error");
    return res.status(500).json(
      errorResponse(
        "DATABASE_ERROR",
        "Scheduling data could not be loaded due to a server error."
      )
    );
  }
};

module.exports = { generateSchedule };
