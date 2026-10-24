const DEFAULT_SOLVER_SERVICE_URL = "http://127.0.0.1:8001";
const SOLVER_TIMEOUT_MS = 30000;

const createSolverErrorResponse = (code, message) => ({
  status: "error",
  message,
  schedule: [],
  unscheduled: [],
  errors: [{ code, message }],
});

const requestSchedule = async (request, fetchImpl = fetch) => {
  const baseUrl = (
    process.env.SOLVER_SERVICE_URL || DEFAULT_SOLVER_SERVICE_URL
  ).replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOLVER_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${baseUrl}/api/schedules/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    let result;
    try {
      result = await response.json();
    } catch {
      return {
        httpStatus: 502,
        body: createSolverErrorResponse(
          "INVALID_SOLVER_RESPONSE",
          "The scheduling solver returned an invalid response."
        ),
      };
    }

    if (!response.ok && result?.status === "error") {
      return {
        httpStatus: 502,
        body: createSolverErrorResponse(
          "SOLVER_REJECTED_REQUEST",
          "The scheduling solver rejected the generated request."
        ),
      };
    }

    if (!response.ok) {
      return {
        httpStatus: 502,
        body: createSolverErrorResponse(
          "SOLVER_FAILURE",
          "The scheduling solver could not generate a schedule."
        ),
      };
    }

    return { httpStatus: response.ok ? 200 : 502, body: result };
  } catch (error) {
    if (error.name === "AbortError") {
      return {
        httpStatus: 504,
        body: createSolverErrorResponse(
          "SOLVER_TIMEOUT",
          "The scheduling solver timed out."
        ),
      };
    }
    return {
      httpStatus: 502,
      body: createSolverErrorResponse(
        "SOLVER_UNAVAILABLE",
        "The scheduling solver is currently unavailable."
      ),
    };
  } finally {
    clearTimeout(timeout);
  }
};

module.exports = { requestSchedule };
