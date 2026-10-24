const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, beforeEach, test } = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../src/config/db");
const scheduleRoutes = require("../src/routes/scheduleRoutes");

const previousJwtSecret = process.env.JWT_SECRET;
const originalQuery = pool.query;
const originalFetch = global.fetch;
const testJwtSecret = "schedule-tests-only-secret";
let server;
let baseUrl;
let fixture;
let capturedSolverRequest;

const tokenFor = (userId, role) =>
  jwt.sign({ userId, role }, testJwtSecret, { expiresIn: "5m" });

const request = async (method, route, { token, body } = {}) => {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return originalFetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};

const validSolverResponse = ({
  candidateId = "21",
  interviewerId = "31",
  roundId = "screen",
  startTime = "2027-01-04T09:00:00Z",
  endTime = "2027-01-04T09:30:00Z",
} = {}) => ({
  status: "success",
  message: "All required interviews were scheduled.",
  schedule: [{ candidateId, interviewerId, roundId, startTime, endTime }],
  unscheduled: [],
  errors: [],
});

const mockSolver = (result, { ok = true, status = 200 } = {}) => {
  global.fetch = async (_url, options) => {
    capturedSolverRequest = JSON.parse(options.body);
    return {
      ok,
      status,
      json: async () => result,
    };
  };
};

before(async () => {
  process.env.JWT_SECRET = testJwtSecret;
  const app = express();
  app.use(express.json());
  app.use("/api/schedules", scheduleRoutes);
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  capturedSolverRequest = undefined;
  fixture = {
    event: {
      id: "5",
      time_zone: "UTC",
      start_date: "2027-01-04",
      end_date: "2027-01-04",
      candidate_buffer_minutes: 0,
      interviewer_buffer_minutes: 0,
      range_start: new Date("2027-01-04T00:00:00Z"),
      range_end: new Date("2027-01-05T00:00:00Z"),
    },
    hours: [{
      day_of_week: "MONDAY",
      start_time: "09:00:00",
      end_time: "12:00:00",
    }],
    rounds: [{
      round_id: "screen",
      round_order: 1,
      duration_minutes: 30,
      required_skills: [" JavaScript "],
    }],
    candidates: [
      { candidate_id: 21, start_time: new Date("2027-01-04T09:00:00Z"), end_time: new Date("2027-01-04T12:00:00Z") },
    ],
    interviewers: [{ interviewer_id: 31, skill_tags: [" JavaScript "] }],
    interviewerAvailability: [
      { interviewer_id: 31, start_time: new Date("2027-01-04T09:00:00Z"), end_time: new Date("2027-01-04T12:00:00Z") },
    ],
    conflicts: [],
    noEvent: false,
    databaseFailure: false,
  };

  pool.query = async (sql) => {
    if (fixture.databaseFailure) {
      throw Object.assign(new Error("private database detail"), { code: "08006" });
    }
    if (sql.includes("FROM events")) {
      return { rows: fixture.noEvent ? [] : [fixture.event] };
    }
    if (sql.includes("FROM event_working_hours")) {
      return { rows: fixture.hours };
    }
    if (sql.includes("FROM event_rounds")) {
      return { rows: fixture.rounds };
    }
    if (sql.includes("FROM event_candidates")) {
      return { rows: fixture.candidates };
    }
    if (sql.includes("SELECT DISTINCT u.id AS interviewer_id")) {
      return { rows: fixture.interviewers };
    }
    if (sql.includes("FROM interview_bookings")) {
      return { rows: fixture.conflicts };
    }
    if (sql.includes("SELECT u.id AS interviewer_id")) {
      return { rows: fixture.interviewerAvailability };
    }
    throw new Error(`Unexpected schedule query: ${sql}`);
  };
  global.fetch = async () => {
    throw new Error("Unexpected solver call.");
  };
});

after(async () => {
  pool.query = originalQuery;
  global.fetch = originalFetch;
  if (previousJwtSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = previousJwtSecret;
  }
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("authentication and coordinator authorization are enforced", async () => {
  const unauthenticated = await request("POST", "/api/schedules/generate", {
    body: { eventId: "5" },
  });
  assert.equal(unauthenticated.status, 401);

  const forbidden = await request("POST", "/api/schedules/generate", {
    token: tokenFor(21, "candidate"),
    body: { eventId: "5" },
  });
  assert.equal(forbidden.status, 403);

  const interviewerForbidden = await request("POST", "/api/schedules/generate", {
    token: tokenFor(31, "interviewer"),
    body: { eventId: "5" },
  });
  assert.equal(interviewerForbidden.status, 403);
});

test("coordinator receives 404 for missing or inaccessible events", async () => {
  fixture.noEvent = true;
  const response = await request("POST", "/api/schedules/generate", {
    token: tokenFor(1, "coordinator"),
    body: { eventId: "5" },
  });
  const result = await response.json();
  assert.equal(response.status, 404);
  assert.equal(result.errors[0].code, "EVENT_NOT_FOUND");
});

test("solver input is assembled from database data, not request-supplied scheduling fields", async () => {
  mockSolver(validSolverResponse());
  const response = await request("POST", "/api/schedules/generate", {
    token: tokenFor(1, "coordinator"),
    body: {
      eventId: "5",
      candidates: [{ candidateId: "attacker-controlled" }],
      rounds: [],
    },
  });
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.equal(result.errors[0].code, "INVALID_REQUEST");

  const validRequest = await request("POST", "/api/schedules/generate", {
    token: tokenFor(1, "coordinator"),
    body: { eventId: "5" },
  });
  assert.equal(validRequest.status, 200);
  assert.equal(capturedSolverRequest.eventId, "5");
  assert.equal(capturedSolverRequest.timeZone, "UTC");
  assert.equal(capturedSolverRequest.candidates[0].candidateId, "21");
  assert.deepEqual(capturedSolverRequest.candidates[0].breaks, []);
  assert.deepEqual(capturedSolverRequest.interviewers[0].skills, ["javascript"]);
  assert.deepEqual(capturedSolverRequest.rounds[0].requiredSkills, ["javascript"]);
});

test("database failures return a safe error", async () => {
  fixture.databaseFailure = true;
  const response = await request("POST", "/api/schedules/generate", {
    token: tokenFor(1, "coordinator"),
    body: { eventId: "5" },
  });
  const result = await response.json();
  assert.equal(response.status, 500);
  assert.equal(result.errors[0].code, "DATABASE_ERROR");
  assert.equal(JSON.stringify(result).includes("private database detail"), false);
});

test("missing required event scheduling data is reported explicitly", async () => {
  fixture.rounds = [];
  const response = await request("POST", "/api/schedules/generate", {
    token: tokenFor(1, "coordinator"),
    body: { eventId: "5" },
  });
  const result = await response.json();
  assert.equal(response.status, 409);
  assert.equal(result.errors[0].code, "MISSING_SCHEDULING_DATA");
});

test("solver timeouts return a gateway timeout", async () => {
  global.fetch = async () => {
    const error = new Error("timeout");
    error.name = "AbortError";
    throw error;
  };
  const response = await request("POST", "/api/schedules/generate", {
    token: tokenFor(1, "coordinator"),
    body: { eventId: "5" },
  });
  const result = await response.json();
  assert.equal(response.status, 504);
  assert.equal(result.errors[0].code, "SOLVER_TIMEOUT");
});

test("solver validation errors become safe gateway responses", async () => {
  mockSolver(
    {
      status: "error",
      message: "Request validation failed.",
      schedule: [],
      unscheduled: [],
      errors: [{
        code: "INVALID_REQUEST",
        message: "private solver detail",
        path: "candidates",
      }],
    },
    { ok: false, status: 422 }
  );
  const response = await request("POST", "/api/schedules/generate", {
    token: tokenFor(1, "coordinator"),
    body: { eventId: "5" },
  });
  const result = await response.json();

  assert.equal(response.status, 502);
  assert.equal(result.status, "error");
  assert.equal(JSON.stringify(result).includes("private solver detail"), false);
  assert.equal(result.errors[0].code, "SOLVER_REJECTED_REQUEST");
});

test("invalid solver assignments are rejected and never persisted", async () => {
  mockSolver(validSolverResponse({ candidateId: "999" }));
  const response = await request("POST", "/api/schedules/generate", {
    token: tokenFor(1, "coordinator"),
    body: { eventId: "5" },
  });
  const result = await response.json();
  assert.equal(response.status, 502);
  assert.equal(result.errors[0].code, "INVALID_SOLVER_ASSIGNMENT");
  assert.equal(Object.keys(capturedSolverRequest).includes("passwordHash"), false);
});

test("confirmed bookings are removed from candidate and interviewer availability", async () => {
  fixture.conflicts = [{
    candidate_id: 21,
    interviewer_id: 31,
    start_time: new Date("2027-01-04T10:00:00Z"),
    end_time: new Date("2027-01-04T10:30:00Z"),
  }];
  mockSolver(validSolverResponse({
    startTime: "2027-01-04T11:00:00Z",
    endTime: "2027-01-04T11:30:00Z",
  }));

  const response = await request("POST", "/api/schedules/generate", {
    token: tokenFor(1, "coordinator"),
    body: { eventId: "5" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    capturedSolverRequest.candidates[0].availabilityIntervals,
    [
      { startTime: "2027-01-04T09:00:00.000Z", endTime: "2027-01-04T10:00:00.000Z" },
      { startTime: "2027-01-04T10:30:00.000Z", endTime: "2027-01-04T12:00:00.000Z" },
    ]
  );
  assert.deepEqual(
    capturedSolverRequest.interviewers[0].availabilityIntervals,
    capturedSolverRequest.candidates[0].availabilityIntervals
  );
});
