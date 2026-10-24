const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, beforeEach, test } = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../src/config/db");
const eventRoutes = require("../src/routes/eventRoutes");

const previousJwtSecret = process.env.JWT_SECRET;
const originalQuery = pool.query;
const testJwtSecret = "event-enrollment-tests-only-secret";
let server;
let baseUrl;
let ownedEvent;
let candidate;
let enrollment;
let queryFailure;
let queryFailurePrefix;
let queries;

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
  return fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};

before(async () => {
  process.env.JWT_SECRET = testJwtSecret;
  const app = express();
  app.use(express.json());
  app.use("/api/events", eventRoutes);
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  ownedEvent = true;
  candidate = { id: 23, role: "candidate" };
  enrollment = {
    event_id: "12",
    candidate_id: 23,
    enrolled_at: new Date("2026-10-24T08:00:00.000Z"),
  };
  queryFailure = null;
  queryFailurePrefix = null;
  queries = [];
  pool.query = async (sql, values = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    queries.push({ sql: normalized, values });
    if (queryFailure && (!queryFailurePrefix || normalized.startsWith(queryFailurePrefix))) {
      throw queryFailure;
    }
    if (normalized.startsWith("SELECT id FROM events")) {
      return { rows: ownedEvent ? [{ id: "12" }] : [] };
    }
    if (normalized.startsWith("SELECT u.id AS candidate_id")) {
      return {
        rows: [{
          candidate_id: 23,
          name: "Test Candidate",
          email: "candidate@example.invalid",
          enrolled_at: enrollment.enrolled_at,
        }],
      };
    }
    if (normalized.startsWith("SELECT id, role FROM users")) {
      return { rows: candidate ? [candidate] : [] };
    }
    if (normalized.startsWith("INSERT INTO event_candidates")) {
      return { rows: [enrollment] };
    }
    if (normalized.startsWith("DELETE FROM event_candidates")) {
      return { rows: enrollment ? [enrollment] : [] };
    }
    throw new Error(`Unexpected enrollment query: ${normalized}`);
  };
});

after(async () => {
  pool.query = originalQuery;
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

test("enrollment routes require authentication and coordinator role", async () => {
  const routes = [
    ["GET", "/api/events/12/candidates"],
    ["POST", "/api/events/12/candidates", { candidateId: 23 }],
    ["DELETE", "/api/events/12/candidates/23"],
  ];

  for (const [method, route, body] of routes) {
    const unauthenticated = await request(method, route, { body });
    assert.equal(unauthenticated.status, 401, `${method} ${route}`);
    const candidateResponse = await request(method, route, {
      token: tokenFor(23, "candidate"),
      body,
    });
    assert.equal(candidateResponse.status, 403, `candidate ${method} ${route}`);
    const interviewerResponse = await request(method, route, {
      token: tokenFor(31, "interviewer"),
      body,
    });
    assert.equal(interviewerResponse.status, 403, `interviewer ${method} ${route}`);
  }
  assert.equal(queries.length, 0);
});

test("coordinator can list enrolled candidates without sensitive fields", async () => {
  const response = await request("GET", "/api/events/12/candidates", {
    token: tokenFor(4, "coordinator"),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(result.candidates, [{
    candidateId: 23,
    name: "Test Candidate",
    email: "candidate@example.invalid",
    enrolledAt: enrollment.enrolled_at.toISOString(),
  }]);
  assert.doesNotMatch(queries[1].sql, /password_hash|SELECT\s+\*/i);
  assert.deepEqual(queries[0].values, ["12", "4"]);
  assert.deepEqual(queries[1].values, ["12"]);
});

test("coordinator can enroll a candidate using parameterized SQL", async () => {
  const response = await request("POST", "/api/events/12/candidates", {
    token: tokenFor(4, "coordinator"),
    body: { candidateId: 23 },
  });
  const result = await response.json();

  assert.equal(response.status, 201);
  assert.deepEqual(result.enrollment, {
    eventId: "12",
    candidateId: 23,
    enrolledAt: enrollment.enrolled_at.toISOString(),
  });
  assert.deepEqual(queries[0].values, ["12", "4"]);
  assert.deepEqual(queries[1].values, ["23"]);
  assert.deepEqual(queries[2].values, ["12", "23"]);
  assert.match(queries[2].sql, /VALUES \(\$1, \$2\)/);
  assert.equal(JSON.stringify(result).includes("password_hash"), false);
});

test("enrollment rejects invalid IDs, missing fields, and unsupported body fields", async () => {
  const token = tokenFor(4, "coordinator");
  for (const route of [
    "/api/events/0/candidates",
    "/api/events/abc/candidates",
    "/api/events/9223372036854775808/candidates",
  ]) {
    const response = await request("POST", route, {
      token,
      body: { candidateId: 23 },
    });
    assert.equal(response.status, 400);
  }

  for (const body of [
    {},
    { candidateId: 0 },
    { candidateId: -1 },
    { candidateId: 1.5 },
    { candidateId: "23" },
    { candidateId: 2147483648 },
    { candidateId: 23, role: "candidate" },
    [],
  ]) {
    const response = await request("POST", "/api/events/12/candidates", {
      token,
      body,
    });
    assert.equal(response.status, 400);
  }
  assert.equal(queries.length, 0);
});

test("enrollment distinguishes missing users, invalid roles, and duplicates", async () => {
  const token = tokenFor(4, "coordinator");
  candidate = null;
  const missing = await request("POST", "/api/events/12/candidates", {
    token,
    body: { candidateId: 23 },
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "CANDIDATE_NOT_FOUND");

  for (const role of ["interviewer", "coordinator"]) {
    candidate = { id: 23, role };
    const invalidRole = await request("POST", "/api/events/12/candidates", {
      token,
      body: { candidateId: 23 },
    });
    assert.equal(invalidRole.status, 422);
    assert.equal((await invalidRole.json()).error.code, "USER_NOT_A_CANDIDATE");
  }

  candidate = { id: 23, role: "candidate" };
  queryFailure = Object.assign(new Error("private duplicate constraint"), {
    code: "23505",
  });
  queryFailurePrefix = "INSERT INTO event_candidates";
  const duplicate = await request("POST", "/api/events/12/candidates", {
    token,
    body: { candidateId: 23 },
  });
  const duplicatePayload = await duplicate.json();
  assert.equal(duplicate.status, 409);
  assert.equal(duplicatePayload.error.code, "CANDIDATE_ALREADY_ENROLLED");
  assert.equal(JSON.stringify(duplicatePayload).includes("private duplicate"), false);
});

test("another coordinator receives event not found for list, enroll, and removal", async () => {
  ownedEvent = false;
  const token = tokenFor(99, "coordinator");

  for (const [method, route, body] of [
    ["GET", "/api/events/12/candidates"],
    ["POST", "/api/events/12/candidates", { candidateId: 23 }],
    ["DELETE", "/api/events/12/candidates/23"],
  ]) {
    const response = await request(method, route, { token, body });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "EVENT_NOT_FOUND");
  }
  assert.equal(queries.length, 3);
  assert.ok(queries.every((query) => query.sql.startsWith("SELECT id FROM events")));
  assert.ok(queries.every((query) => query.values[1] === "99"));
});

test("missing event and removal of missing enrollment return 404", async () => {
  ownedEvent = false;
  const token = tokenFor(4, "coordinator");
  const missingEvent = await request("GET", "/api/events/12/candidates", { token });
  assert.equal(missingEvent.status, 404);

  ownedEvent = true;
  enrollment = null;
  const missingEnrollment = await request("DELETE", "/api/events/12/candidates/23", {
    token,
  });
  assert.equal(missingEnrollment.status, 404);
  assert.equal((await missingEnrollment.json()).error.code, "ENROLLMENT_NOT_FOUND");
  assert.match(queries[2].sql, /WHERE event_id = \$1 AND candidate_id = \$2/);
  assert.deepEqual(queries[2].values, ["12", "23"]);
});

test("coordinator can remove enrollment without touching booking or hold tables", async () => {
  const response = await request("DELETE", "/api/events/12/candidates/23", {
    token: tokenFor(4, "coordinator"),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.eventId, "12");
  assert.equal(result.candidateId, 23);
  assert.equal(result.message, "Candidate enrollment removed successfully.");
  assert.ok(queries.every((query) => !/interview_bookings|availability_holds|interviewer_availability/.test(query.sql)));
  assert.deepEqual(queries[1].values, ["12", "23"]);
});

test("database errors return safe responses without exposing internal details", async () => {
  queryFailure = Object.assign(new Error("private database connection detail"), {
    code: "08006",
  });
  const response = await request("GET", "/api/events/12/candidates", {
    token: tokenFor(4, "coordinator"),
  });
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.error.code, "ENROLLMENT_REQUEST_FAILED");
  assert.equal(JSON.stringify(payload).includes("private database connection detail"), false);
});
