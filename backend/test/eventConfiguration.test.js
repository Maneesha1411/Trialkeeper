const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, beforeEach, test } = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../src/config/db");
const eventRoutes = require("../src/routes/eventRoutes");

const previousJwtSecret = process.env.JWT_SECRET;
const originalQuery = pool.query;
const testJwtSecret = "event-configuration-tests-only-secret";
let server;
let baseUrl;
let eventIsOwned;
let queries;
let databaseError;

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

const workingHourRow = {
  id: "7",
  day_of_week: "MONDAY",
  start_time: "09:00:00",
  end_time: "17:00:00",
};

const roundRow = {
  round_id: "technical",
  round_order: 1,
  duration_minutes: 45,
  required_skills: ["javascript", "testing"],
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
  eventIsOwned = true;
  queries = [];
  databaseError = null;
  pool.query = async (sql, values = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    queries.push({ sql: normalized, values });
    if (databaseError) {
      throw databaseError;
    }
    if (normalized.startsWith("SELECT id FROM events")) {
      return { rows: eventIsOwned ? [{ id: "12" }] : [] };
    }
    if (normalized.startsWith("SELECT id, day_of_week")) {
      return { rows: [workingHourRow] };
    }
    if (normalized.startsWith("INSERT INTO event_working_hours")) {
      return { rows: [workingHourRow] };
    }
    if (normalized.startsWith("DELETE FROM event_working_hours")) {
      return { rows: [{ id: values[0] }] };
    }
    if (normalized.startsWith("SELECT round_id")) {
      return { rows: [roundRow] };
    }
    if (normalized.startsWith("INSERT INTO event_rounds")) {
      return { rows: [roundRow] };
    }
    if (normalized.startsWith("UPDATE event_rounds")) {
      return { rows: [roundRow] };
    }
    if (normalized.startsWith("DELETE FROM event_rounds")) {
      return { rows: [{ round_id: values[1] }] };
    }
    throw new Error(`Unexpected configuration query: ${normalized}`);
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

test("configuration routes require authentication and coordinator role", async () => {
  const operations = [
    ["GET", "/api/events/12/working-hours"],
    ["POST", "/api/events/12/working-hours", { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "10:00" }],
    ["DELETE", "/api/events/12/working-hours/7"],
    ["GET", "/api/events/12/rounds"],
    ["POST", "/api/events/12/rounds", { roundId: "tech", order: 1, durationMinutes: 30 }],
    ["PATCH", "/api/events/12/rounds/tech", { order: 2 }],
    ["DELETE", "/api/events/12/rounds/tech"],
  ];

  for (const [method, route, body] of operations) {
    const unauthenticated = await request(method, route, { body });
    assert.equal(unauthenticated.status, 401, `${method} ${route}`);
    const candidate = await request(method, route, {
      token: tokenFor(21, "candidate"),
      body,
    });
    assert.equal(candidate.status, 403, `candidate ${method} ${route}`);
    const interviewer = await request(method, route, {
      token: tokenFor(31, "interviewer"),
      body,
    });
    assert.equal(interviewer.status, 403, `interviewer ${method} ${route}`);
  }
  assert.equal(queries.length, 0);
});

test("working hours can be listed, created, and deleted with solver-compatible fields", async () => {
  const token = tokenFor(4, "coordinator");
  const listResponse = await request("GET", "/api/events/12/working-hours", { token });
  const listed = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.deepEqual(listed.workingHours[0], {
    id: "7",
    dayOfWeek: "MONDAY",
    startTime: "09:00:00",
    endTime: "17:00:00",
  });

  const createResponse = await request("POST", "/api/events/12/working-hours", {
    token,
    body: { dayOfWeek: "monday", startTime: "09:00", endTime: "17:00" },
  });
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201);
  assert.equal(created.workingHour.dayOfWeek, "MONDAY");
  assert.deepEqual(queries[3].values, ["12", "MONDAY", "09:00", "17:00"]);
  assert.match(queries[3].sql, /VALUES \(\$1, \$2, \$3, \$4\)/);

  const deleteResponse = await request("DELETE", "/api/events/12/working-hours/7", { token });
  const deleted = await deleteResponse.json();
  assert.equal(deleteResponse.status, 200);
  assert.equal(deleted.workingHourId, "7");
  assert.deepEqual(queries[5].values, ["7", "12"]);
});

test("working-hour validation rejects invalid weekdays, times, and unsupported fields", async () => {
  const invalidBodies = [
    { dayOfWeek: "FUNDAY", startTime: "09:00", endTime: "10:00" },
    { dayOfWeek: "MONDAY", startTime: "25:00", endTime: "26:00" },
    { dayOfWeek: "MONDAY", startTime: "10:00", endTime: "09:00" },
    { dayOfWeek: "MONDAY", startTime: "09:00Z", endTime: "10:00Z" },
    { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "10:00", eventId: 99 },
  ];
  for (const body of invalidBodies) {
    const response = await request("POST", "/api/events/12/working-hours", {
      token: tokenFor(4, "coordinator"),
      body,
    });
    assert.equal(response.status, 400);
  }
  assert.equal(queries.length, 0);
});

test("rounds can be listed, created, updated, and deleted with solver-compatible fields", async () => {
  const token = tokenFor(4, "coordinator");
  const listResponse = await request("GET", "/api/events/12/rounds", { token });
  const listed = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.deepEqual(listed.rounds[0], {
    roundId: "technical",
    order: 1,
    durationMinutes: 45,
    requiredSkills: ["javascript", "testing"],
  });

  const createResponse = await request("POST", "/api/events/12/rounds", {
    token,
    body: {
      roundId: "technical",
      order: 1,
      durationMinutes: 45,
      requiredSkills: [" JavaScript ", "testing", "testing"],
    },
  });
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201);
  assert.equal(created.round.roundId, "technical");
  assert.deepEqual(queries[3].values, [
    "12",
    "technical",
    1,
    45,
    ["JavaScript", "testing"],
  ]);

  const patchResponse = await request("PATCH", "/api/events/12/rounds/technical", {
    token,
    body: { order: 2, requiredSkills: ["algorithms"] },
  });
  const updated = await patchResponse.json();
  assert.equal(patchResponse.status, 200);
  assert.equal(updated.round.durationMinutes, 45);
  assert.match(queries[5].sql, /UPDATE event_rounds SET round_order = \$1, required_skills = \$2/);
  assert.deepEqual(queries[5].values, [2, ["algorithms"], "12", "technical"]);

  const deleteResponse = await request("DELETE", "/api/events/12/rounds/technical", { token });
  const deleted = await deleteResponse.json();
  assert.equal(deleteResponse.status, 200);
  assert.equal(deleted.roundId, "technical");
  assert.deepEqual(queries[7].values, ["12", "technical"]);
});

test("round validation rejects invalid IDs, ordering, duration, and skills", async () => {
  const invalidBodies = [
    { roundId: " ", order: 1, durationMinutes: 30 },
    { roundId: "tech", order: 0, durationMinutes: 30 },
    { roundId: "tech", order: 1.5, durationMinutes: 30 },
    { roundId: "tech", order: 1, durationMinutes: 0 },
    { roundId: "tech", order: 1, durationMinutes: 30, requiredSkills: [" "] },
    { roundId: "tech", order: 1, durationMinutes: 30, requiredSkills: "javascript" },
  ];
  for (const body of invalidBodies) {
    const response = await request("POST", "/api/events/12/rounds", {
      token: tokenFor(4, "coordinator"),
      body,
    });
    assert.equal(response.status, 400);
  }

  for (const body of [{ order: 0 }, { durationMinutes: -1 }, { roundId: "changed" }, {}]) {
    const response = await request("PATCH", "/api/events/12/rounds/technical", {
      token: tokenFor(4, "coordinator"),
      body,
    });
    assert.equal(response.status, 400);
  }
  assert.equal(queries.length, 0);
});

test("another coordinator and nonexistent events cannot read or change configuration", async () => {
  eventIsOwned = false;
  const token = tokenFor(99, "coordinator");
  for (const [method, route, body] of [
    ["GET", "/api/events/12/working-hours"],
    ["POST", "/api/events/12/working-hours", { dayOfWeek: "MONDAY", startTime: "09:00", endTime: "10:00" }],
    ["GET", "/api/events/12/rounds"],
    ["POST", "/api/events/12/rounds", { roundId: "tech", order: 1, durationMinutes: 30 }],
    ["PATCH", "/api/events/12/rounds/tech", { order: 2 }],
    ["DELETE", "/api/events/12/rounds/tech"],
  ]) {
    const response = await request(method, route, { token, body });
    const result = await response.json();
    assert.equal(response.status, 404);
    assert.equal(result.error.code, "EVENT_NOT_FOUND");
  }
  assert.equal(queries.length, 6);
});

test("database uniqueness violations return conflict and internal details stay private", async () => {
  databaseError = Object.assign(new Error("private constraint detail"), {
    code: "23505",
  });
  const duplicate = await request("POST", "/api/events/12/rounds", {
    token: tokenFor(4, "coordinator"),
    body: { roundId: "other", order: 1, durationMinutes: 30 },
  });
  const conflict = await duplicate.json();
  assert.equal(duplicate.status, 409);
  assert.equal(conflict.error.code, "CONFIGURATION_CONFLICT");
  assert.equal(JSON.stringify(conflict).includes("private constraint detail"), false);

  databaseError = Object.assign(new Error("private database detail"), {
    code: "08006",
  });
  const failedRead = await request("GET", "/api/events/12/rounds", {
    token: tokenFor(4, "coordinator"),
  });
  const failure = await failedRead.json();
  assert.equal(failedRead.status, 500);
  assert.equal(JSON.stringify(failure).includes("private database detail"), false);
});
