const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, beforeEach, test } = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../src/config/db");
const eventRoutes = require("../src/routes/eventRoutes");

const previousJwtSecret = process.env.JWT_SECRET;
const originalQuery = pool.query;
const testJwtSecret = "event-tests-only-secret";
let server;
let baseUrl;
let fixture;
let recordedQueries;

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

const eventRow = (overrides = {}) => ({
  id: "12",
  coordinator_id: 4,
  name: "TrialKeeper Hackathon",
  time_zone: "Asia/Kolkata",
  start_date: "2027-02-01",
  end_date: "2027-02-03",
  candidate_buffer_minutes: 10,
  interviewer_buffer_minutes: 15,
  is_active: true,
  created_at: new Date("2026-10-24T06:00:00.000Z"),
  ...overrides,
});

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
  fixture = {
    currentEvent: eventRow(),
    updatedEvent: eventRow({ name: "Updated Hackathon" }),
    events: [eventRow()],
    inaccessible: false,
    databaseFailure: false,
  };
  recordedQueries = [];
  pool.query = async (sql, values = []) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    recordedQueries.push({ sql: normalized, values });
    if (fixture.databaseFailure) {
      throw Object.assign(new Error("private database detail"), { code: "08006" });
    }
    if (normalized.startsWith("INSERT INTO events")) {
      return { rows: [eventRow({ coordinator_id: values[0], name: values[1] })] };
    }
    if (normalized.startsWith("SELECT id, name, time_zone")) {
      return { rows: fixture.inaccessible ? [] : [fixture.currentEvent] };
    }
    if (normalized.startsWith("UPDATE events")) {
      return { rows: [fixture.updatedEvent] };
    }
    if (normalized.startsWith("SELECT id, coordinator_id")) {
      if (normalized.includes("WHERE id = $1 AND coordinator_id = $2")) {
        return { rows: fixture.inaccessible ? [] : [fixture.currentEvent] };
      }
      return { rows: fixture.events };
    }
    if (normalized.startsWith("SELECT e.id")) {
      return { rows: fixture.events };
    }
    throw new Error(`Unexpected event query: ${normalized}`);
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

test("all event routes require authentication and writes require coordinator role", async () => {
  const unauthenticated = await request("GET", "/api/events");
  assert.equal(unauthenticated.status, 401);

  const candidateCreate = await request("POST", "/api/events", {
    token: tokenFor(21, "candidate"),
    body: {
      name: "Event",
      timeZone: "UTC",
      startDate: "2027-02-01",
      endDate: "2027-02-02",
    },
  });
  assert.equal(candidateCreate.status, 403);

  const interviewerPatch = await request("PATCH", "/api/events/12", {
    token: tokenFor(31, "interviewer"),
    body: { name: "Not allowed" },
  });
  assert.equal(interviewerPatch.status, 403);
});

test("coordinator creates an event using their JWT identity", async () => {
  const response = await request("POST", "/api/events", {
    token: tokenFor(4, "coordinator"),
    body: {
      name: "  TrialKeeper Hackathon  ",
      timeZone: " Asia/Kolkata ",
      startDate: "2027-02-01",
      endDate: "2027-02-03",
    },
  });
  const result = await response.json();

  assert.equal(response.status, 201);
  assert.equal(result.event.coordinatorId, 4);
  assert.equal(result.event.name, "TrialKeeper Hackathon");
  assert.equal(result.event.id, "12");
  assert.equal(Object.hasOwn(result.event, "password_hash"), false);
  assert.equal(recordedQueries[0].values[0], 4);
  assert.deepEqual(recordedQueries[0].values.slice(5), [0, 0]);
  assert.match(recordedQueries[0].sql, /coordinator_id, name, time_zone/);
});

test("create rejects coordinator spoofing and invalid required values", async () => {
  const spoofed = await request("POST", "/api/events", {
    token: tokenFor(4, "coordinator"),
    body: {
      coordinatorId: 99,
      name: "Event",
      timeZone: "UTC",
      startDate: "2027-02-01",
      endDate: "2027-02-02",
    },
  });
  assert.equal(spoofed.status, 400);

  for (const body of [
    { name: "", timeZone: "UTC", startDate: "2027-02-01", endDate: "2027-02-02" },
    { name: "Event", timeZone: "Mars/Olympus", startDate: "2027-02-01", endDate: "2027-02-02" },
    { name: "Event", timeZone: "UTC", startDate: "2027-02-30", endDate: "2027-03-01" },
    { name: "Event", timeZone: "UTC", startDate: "2027-02-02", endDate: "2027-02-01" },
    { name: "Event", timeZone: "UTC", startDate: "2027-02-01", endDate: "2027-02-02", candidateBufferMinutes: -1 },
    { name: "Event", timeZone: "UTC", startDate: "2027-02-01", endDate: "2027-02-02", interviewerBufferMinutes: 1.5 },
  ]) {
    const response = await request("POST", "/api/events", {
      token: tokenFor(4, "coordinator"),
      body,
    });
    assert.equal(response.status, 400);
  }
  assert.equal(recordedQueries.length, 0);
});

test("event list visibility is scoped to each authenticated role", async () => {
  const cases = [
    {
      role: "coordinator",
      userId: 4,
      requiredSql: "WHERE coordinator_id = $1",
    },
    {
      role: "candidate",
      userId: 21,
      requiredSql: "JOIN event_candidates ec ON ec.event_id = e.id",
    },
    {
      role: "interviewer",
      userId: 31,
      requiredSql: "FROM interviewer_availability a",
    },
  ];

  for (const item of cases) {
    recordedQueries = [];
    const response = await request("GET", "/api/events", {
      token: tokenFor(item.userId, item.role),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.events.length, 1);
    assert.match(recordedQueries[0].sql, new RegExp(item.requiredSql.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(recordedQueries[0].values[0], item.userId);
    if (item.role !== "coordinator") {
      assert.match(recordedQueries[0].sql, /is_active = TRUE/);
    }
  }
});

test("event detail hides inaccessible events with 404", async () => {
  fixture.inaccessible = true;
  const response = await request("GET", "/api/events/12", {
    token: tokenFor(9, "coordinator"),
  });
  const result = await response.json();
  assert.equal(response.status, 404);
  assert.equal(result.error.code, "EVENT_NOT_FOUND");
  assert.deepEqual(recordedQueries[0].values, ["12", 9]);
});

test("coordinator can patch only their own event with validated fields", async () => {
  const response = await request("PATCH", "/api/events/12", {
    token: tokenFor(4, "coordinator"),
    body: {
      name: "Updated Hackathon",
      candidateBufferMinutes: 20,
      isActive: false,
    },
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.event.name, "Updated Hackathon");
  assert.equal(recordedQueries.length, 2);
  assert.deepEqual(recordedQueries[0].values, ["12", 4]);
  assert.deepEqual(recordedQueries[1].values, ["Updated Hackathon", 20, false, "12", 4]);
  assert.match(recordedQueries[1].sql, /WHERE id = \$4 AND coordinator_id = \$5/);
});

test("coordinator cannot patch another coordinator's event", async () => {
  fixture.inaccessible = true;
  const response = await request("PATCH", "/api/events/12", {
    token: tokenFor(9, "coordinator"),
    body: { name: "Attempt" },
  });
  assert.equal(response.status, 404);
  assert.equal(recordedQueries.length, 1);
});

test("patch rejects invalid ranges, timezone, buffers, and unsupported fields", async () => {
  for (const body of [
    { endDate: "2027-01-01" },
    { timeZone: "Mars/Olympus" },
    { candidateBufferMinutes: -2 },
    { interviewerBufferMinutes: "15" },
    { coordinatorId: 99 },
    { isActive: 1 },
  ]) {
    recordedQueries = [];
    const response = await request("PATCH", "/api/events/12", {
      token: tokenFor(4, "coordinator"),
      body,
    });
    assert.equal(response.status, 400);
    assert.equal(recordedQueries.some((query) => query.sql.startsWith("UPDATE events")), false);
  }
});

test("database errors return a safe message without database details", async () => {
  fixture.databaseFailure = true;
  const response = await request("GET", "/api/events", {
    token: tokenFor(4, "coordinator"),
  });
  const result = await response.json();
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(result).includes("private database detail"), false);
});
