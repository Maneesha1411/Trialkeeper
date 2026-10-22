const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { after, before, beforeEach, test } = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../src/config/db");
const availabilityRoutes = require("../src/routes/availabilityRoutes");

const previousJwtSecret = process.env.JWT_SECRET;
const originalQuery = pool.query;
const testJwtSecret = "availability-tests-only-secret";
let server;
let baseUrl;

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

const futureSlot = () => {
  const start = new Date(Date.now() + 48 * 60 * 60 * 1000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 60 * 60 * 1000);

  return {
    startTime: start.toISOString(),
    endTime: end.toISOString(),
  };
};

before(async () => {
  process.env.JWT_SECRET = testJwtSecret;

  const app = express();
  app.use(express.json());
  app.use("/api/availability", availabilityRoutes);

  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  pool.query = async () => {
    throw new Error("Unexpected database query in test.");
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

test("routes are mounted and the router requires a valid JWT", async () => {
  const response = await request("GET", "/api/availability");
  assert.equal(response.status, 401);

  const invalidTokenResponse = await request("GET", "/api/availability", {
    token: "not-a-valid-token",
  });
  assert.equal(invalidTokenResponse.status, 401);
});

test("candidates are forbidden from every availability operation", async () => {
  const token = tokenFor("candidate-1", "candidate");
  const slot = futureSlot();

  for (const [method, route, body] of [
    ["GET", "/api/availability"],
    ["POST", "/api/availability", slot],
    ["DELETE", "/api/availability/1"],
  ]) {
    const response = await request(method, route, { token, body });
    assert.equal(response.status, 403, `${method} ${route}`);
  }
});

test("interviewers can create non-overlapping slots using parameterized SQL", async () => {
  const slot = futureSlot();
  const token = tokenFor("interviewer-1", "interviewer");
  let queryArgs;

  pool.query = async (...args) => {
    queryArgs = args;
    return {
      rows: [{
        id: "41",
        start_time: slot.startTime,
        end_time: slot.endTime,
        created_at: slot.startTime,
      }],
    };
  };

  const response = await request("POST", "/api/availability", {
    token,
    body: slot,
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.availability.id, "41");
  assert.match(queryArgs[0], /VALUES \(\$1, \$2, \$3\)/);
  assert.deepEqual(queryArgs[1], [
    "interviewer-1",
    slot.startTime,
    slot.endTime,
  ]);
});

test("invalid timestamps and end times not later than start are rejected", async () => {
  const token = tokenFor("interviewer-1", "interviewer");
  const slot = futureSlot();
  const invalidCases = [
    { startTime: "not-a-timestamp", endTime: slot.endTime },
    { startTime: "2026-02-30T10:00:00Z", endTime: slot.endTime },
    {
      startTime: "2027-01-01T10:00:00",
      endTime: "2027-01-01T11:00:00Z",
    },
    { startTime: slot.startTime, endTime: slot.startTime },
    { startTime: slot.endTime, endTime: slot.startTime },
  ];

  for (const body of invalidCases) {
    const response = await request("POST", "/api/availability", {
      token,
      body,
    });
    assert.equal(response.status, 400);
  }
});

test("overlap constraint violations become HTTP 409", async () => {
  const token = tokenFor("interviewer-1", "interviewer");
  const slot = futureSlot();

  pool.query = async () => {
    const error = new Error("exclusion constraint violation");
    error.code = "23P01";
    throw error;
  };

  const response = await request("POST", "/api/availability", {
    token,
    body: slot,
  });

  assert.equal(response.status, 409);
});

test("interviewers can list only their own availability", async () => {
  const token = tokenFor("interviewer-1", "interviewer");
  let queryArgs;

  pool.query = async (...args) => {
    queryArgs = args;
    return { rows: [] };
  };

  const response = await request("GET", "/api/availability", { token });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { availability: [] });
  assert.match(queryArgs[0], /WHERE interviewer_id = \$1/);
  assert.deepEqual(queryArgs[1], ["interviewer-1"]);
});

test("interviewers can delete their own future slot, not another user's slot", async () => {
  const token = tokenFor("interviewer-1", "interviewer");
  let queryArgs;
  let returnDeletedRow = true;

  pool.query = async (...args) => {
    queryArgs = args;
    return {
      rows: returnDeletedRow ? [{ id: args[1][0] }] : [],
    };
  };

  const ownResponse = await request("DELETE", "/api/availability/41", {
    token,
  });
  assert.equal(ownResponse.status, 200);

  returnDeletedRow = false;
  const otherUserSlotResponse = await request(
    "DELETE",
    "/api/availability/42",
    { token }
  );
  assert.equal(otherUserSlotResponse.status, 404);
  assert.match(queryArgs[0], /interviewer_id = \$2/);
  assert.match(queryArgs[0], /start_time > CURRENT_TIMESTAMP/);
  assert.deepEqual(queryArgs[1], ["42", "interviewer-1"]);
});

test("migration uses a half-open exclusion range for per-interviewer overlaps", () => {
  const migrationPath = path.join(
    __dirname,
    "..",
    "001_user_profiles_and_interviewer_availability.sql"
  );
  const migration = fs.readFileSync(migrationPath, "utf8");

  assert.match(migration, /EXCLUDE USING gist/);
  assert.match(migration, /interviewer_id WITH =/);
  assert.match(migration, /tstzrange\(start_time, end_time, ''\[\)''\) WITH &&/);
  assert.match(migration, /CHECK \(end_time > start_time\)/);
});
