const assert = require("node:assert/strict");
const http = require("node:http");
const { after, before, beforeEach, test } = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../src/config/db");
const availabilityRoutes = require("../src/routes/availabilityRoutes");
const bookingRoutes = require("../src/routes/bookingRoutes");

const previousJwtSecret = process.env.JWT_SECRET;
const originalConnect = pool.connect;
const testJwtSecret = "booking-tests-only-secret";
let server;
let baseUrl;
let state;
let lockTail;
let expireHoldOnBookingInsert;
let failHoldDelete;

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

const slotBody = (availabilityId) => ({ availabilityId });

const createFakeClient = () => {
  let releaseSlotLock;
  let released = false;
  let undoActions = [];

  return {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, " ").trim();

      if (normalized === "BEGIN") {
        undoActions = [];
        return { rows: [], rowCount: 0 };
      }

      if (normalized === "COMMIT") {
        undoActions = [];
        if (releaseSlotLock) {
          releaseSlotLock();
          releaseSlotLock = undefined;
        }
        return { rows: [], rowCount: 0 };
      }

      if (normalized === "ROLLBACK") {
        for (const undo of undoActions.reverse()) {
          undo();
        }
        undoActions = [];
        if (releaseSlotLock) {
          releaseSlotLock();
          releaseSlotLock = undefined;
        }
        return { rows: [], rowCount: 0 };
      }

      if (normalized.includes("FROM interviewer_availability") && normalized.includes("FOR UPDATE")) {
        const previousLock = lockTail;
        let releaseLock;
        lockTail = new Promise((resolve) => {
          releaseLock = resolve;
        });
        await previousLock;
        releaseSlotLock = releaseLock;

        const [id, userId] = params;
        const slot = state.slots.get(String(id));
        if (!slot || (normalized.includes("interviewer_id = $2") && String(slot.interviewerId) !== String(userId))) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{
            id: String(id),
            is_future: Date.parse(slot.startTime) > Date.now(),
          }],
          rowCount: 1,
        };
      }

      if (normalized.includes("FROM interview_bookings")) {
        const booking = state.bookings.get(String(params[0]));
        return {
          rows: booking ? [{ id: booking.id, availability_id: String(params[0]) }] : [],
          rowCount: booking ? 1 : 0,
        };
      }

      if (normalized.startsWith("DELETE FROM availability_holds") && normalized.includes("expires_at <= clock_timestamp()")) {
        const hold = state.holds.get(String(params[0]));
        if (hold && Date.parse(hold.expiresAt) <= Date.now()) {
          state.holds.delete(String(params[0]));
          undoActions.push(() => state.holds.set(String(params[0]), hold));
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (normalized.includes("FROM availability_holds") && normalized.includes("FOR UPDATE")) {
        const hold = state.holds.get(String(params[0]));
        return {
          rows: hold
            ? [{
                candidate_id: hold.candidateId,
                expires_at: hold.expiresAt,
                is_active: Date.parse(hold.expiresAt) > Date.now(),
              }]
            : [],
          rowCount: hold ? 1 : 0,
        };
      }

      if (normalized.startsWith("SELECT") && normalized.includes("FROM availability_holds") && normalized.includes("expires_at > clock_timestamp()")) {
        const hold = state.holds.get(String(params[0]));
        return {
          rows: hold && Date.parse(hold.expiresAt) > Date.now()
            ? [{ availability_id: String(params[0]) }]
            : [],
          rowCount: hold && Date.parse(hold.expiresAt) > Date.now() ? 1 : 0,
        };
      }

      if (normalized.includes("INSERT INTO availability_holds")) {
        const [availabilityId, candidateId] = params;
        if (state.holds.has(String(availabilityId))) {
          const error = new Error("duplicate hold");
          error.code = "23505";
          throw error;
        }
        const createdAt = new Date();
        const hold = {
          availability_id: String(availabilityId),
          candidate_id: String(candidateId),
          created_at: createdAt,
          expires_at: new Date(createdAt.getTime() + 5 * 60 * 1000),
        };
        state.holds.set(String(availabilityId), {
          candidateId: String(candidateId),
          createdAt: hold.created_at.toISOString(),
          expiresAt: hold.expires_at.toISOString(),
        });
        undoActions.push(() => state.holds.delete(String(availabilityId)));
        return { rows: [hold], rowCount: 1 };
      }

      if (normalized.startsWith("INSERT INTO interview_bookings")) {
        if (expireHoldOnBookingInsert) {
          expireHoldOnBookingInsert = false;
          const hold = state.holds.get(String(params[0]));
          if (hold) {
            hold.expiresAt = new Date(Date.now()).toISOString();
          }
          return { rows: [], rowCount: 0 };
        }

        const [availabilityId, candidateId] = params;
        if (
          normalized.includes("expires_at > clock_timestamp()") &&
          (!state.holds.has(String(availabilityId)) ||
            state.holds.get(String(availabilityId)).candidateId !== String(candidateId) ||
            Date.parse(state.holds.get(String(availabilityId)).expiresAt) <= Date.now())
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (state.bookings.has(String(availabilityId))) {
          const error = new Error("duplicate booking");
          error.code = "23505";
          throw error;
        }
        const booking = {
          id: String(state.nextBookingId++),
          availability_id: String(availabilityId),
          candidate_id: String(candidateId),
          created_at: new Date(),
        };
        state.bookings.set(String(availabilityId), booking);
        undoActions.push(() => state.bookings.delete(String(availabilityId)));
        return { rows: [booking], rowCount: 1 };
      }

      if (normalized.startsWith("DELETE FROM availability_holds") && normalized.includes("candidate_id = $2")) {
        if (failHoldDelete) {
          failHoldDelete = false;
          const error = new Error("injected hold delete failure");
          error.code = "XX000";
          throw error;
        }
        const hold = state.holds.get(String(params[0]));
        if (hold && hold.candidateId === String(params[1])) {
          state.holds.delete(String(params[0]));
          undoActions.push(() => state.holds.set(String(params[0]), hold));
          return { rows: [{ availability_id: String(params[0]) }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (normalized.startsWith("DELETE FROM interviewer_availability")) {
        const [id] = params;
        const slot = state.slots.get(String(id));
        const hold = state.holds.get(String(id));
        state.slots.delete(String(id));
        state.holds.delete(String(id));
        undoActions.push(() => {
          if (slot) state.slots.set(String(id), slot);
          if (hold) state.holds.set(String(id), hold);
        });
        return { rows: [{ id: String(id) }], rowCount: 1 };
      }

      if (normalized === "SELECT id FROM interviewer_availability") {
        return { rows: [], rowCount: 0 };
      }

      throw new Error(`Unexpected SQL in test: ${normalized}`);
    },
    release() {
      if (!released && releaseSlotLock) {
        releaseSlotLock();
        releaseSlotLock = undefined;
      }
      released = true;
    },
  };
};

const resetState = () => {
  const start = new Date(Date.now() + 48 * 60 * 60 * 1000);
  state = {
    slots: new Map([
      ["1", { interviewerId: "interviewer-1", startTime: start.toISOString() }],
      ["2", { interviewerId: "interviewer-1", startTime: "2020-01-01T00:00:00.000Z" }],
      ["3", { interviewerId: "interviewer-2", startTime: start.toISOString() }],
      ["4", { interviewerId: "interviewer-1", startTime: start.toISOString() }],
    ]),
    holds: new Map(),
    bookings: new Map(),
    nextBookingId: 1,
  };
  lockTail = Promise.resolve();
  expireHoldOnBookingInsert = false;
  failHoldDelete = false;
};

before(async () => {
  process.env.JWT_SECRET = testJwtSecret;
  pool.connect = async () => createFakeClient();

  const app = express();
  app.use(express.json());
  app.use("/api/availability", availabilityRoutes);
  app.use("/api/bookings", bookingRoutes);

  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(resetState);

after(async () => {
  pool.connect = originalConnect;
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

test("booking endpoints require authentication and candidate role", async () => {
  const noToken = await request("POST", "/api/bookings/holds", {
    body: slotBody("1"),
  });
  assert.equal(noToken.status, 401);

  const interviewer = await request("POST", "/api/bookings/holds", {
    token: tokenFor("interviewer-1", "interviewer"),
    body: slotBody("1"),
  });
  assert.equal(interviewer.status, 403);
});

test("hold creation uses the JWT candidate ID and expires in five minutes", async () => {
  const response = await request("POST", "/api/bookings/holds", {
    token: tokenFor("candidate-1", "candidate"),
    body: slotBody("1"),
  });
  const payload = await response.json();
  const hold = state.holds.get("1");

  assert.equal(response.status, 201);
  assert.equal(hold.candidateId, "candidate-1");
  assert.equal(Date.parse(hold.expiresAt) - Date.parse(hold.createdAt), 5 * 60 * 1000);
  assert.equal(payload.hold.availability_id, "1");
});

test("invalid, missing, and past availability requests are rejected", async () => {
  const token = tokenFor("candidate-1", "candidate");

  for (const body of [{}, { availabilityId: "0" }, { availabilityId: "1", candidateId: "other" }]) {
    const response = await request("POST", "/api/bookings/holds", { token, body });
    assert.equal(response.status, 400);
  }

  const missing = await request("POST", "/api/bookings/holds", {
    token,
    body: slotBody("999"),
  });
  assert.equal(missing.status, 404);

  const past = await request("POST", "/api/bookings/holds", {
    token,
    body: slotBody("2"),
  });
  assert.equal(past.status, 409);
});

test("other candidates cannot take an active hold; owner can reuse it", async () => {
  const firstToken = tokenFor("candidate-1", "candidate");
  const secondToken = tokenFor("candidate-2", "candidate");
  const first = await request("POST", "/api/bookings/holds", {
    token: firstToken,
    body: slotBody("1"),
  });
  assert.equal(first.status, 201);

  const other = await request("POST", "/api/bookings/holds", {
    token: secondToken,
    body: slotBody("1"),
  });
  assert.equal(other.status, 409);

  const sameOwner = await request("POST", "/api/bookings/holds", {
    token: firstToken,
    body: slotBody("1"),
  });
  assert.equal(sameOwner.status, 200);
});

test("expired holds are reclaimed by another candidate using database time semantics", async () => {
  state.holds.set("1", {
    candidateId: "candidate-old",
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });

  const response = await request("POST", "/api/bookings/holds", {
    token: tokenFor("candidate-new", "candidate"),
    body: slotBody("1"),
  });

  assert.equal(response.status, 201);
  assert.equal(state.holds.get("1").candidateId, "candidate-new");
});

test("confirmation requires an active hold owned by the authenticated candidate", async () => {
  const token = tokenFor("candidate-1", "candidate");

  const noHold = await request("POST", "/api/bookings/confirm", {
    token,
    body: slotBody("1"),
  });
  assert.equal(noHold.status, 409);

  state.holds.set("1", {
    candidateId: "candidate-2",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });

  const otherOwner = await request("POST", "/api/bookings/confirm", {
    token,
    body: slotBody("1"),
  });
  assert.equal(otherOwner.status, 409);

  state.holds.set("1", {
    candidateId: "candidate-1",
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });

  const expired = await request("POST", "/api/bookings/confirm", {
    token,
    body: slotBody("1"),
  });
  assert.equal(expired.status, 410);
  assert.equal(state.holds.has("1"), false);
});

test("confirmation creates one booking atomically and prevents double booking", async () => {
  const token = tokenFor("candidate-1", "candidate");
  state.holds.set("1", {
    candidateId: "candidate-1",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });

  const confirmed = await request("POST", "/api/bookings/confirm", {
    token,
    body: slotBody("1"),
  });

  assert.equal(confirmed.status, 201);
  assert.equal(state.bookings.get("1").candidate_id, "candidate-1");
  assert.equal(state.holds.has("1"), false);

  const anotherHold = await request("POST", "/api/bookings/holds", {
    token: tokenFor("candidate-2", "candidate"),
    body: slotBody("1"),
  });
  assert.equal(anotherHold.status, 409);

  const secondConfirmation = await request("POST", "/api/bookings/confirm", {
    token: tokenFor("candidate-2", "candidate"),
    body: slotBody("1"),
  });
  assert.equal(secondConfirmation.status, 409);
});

test("hold expiring at the confirmation boundary cannot be confirmed", async () => {
  state.holds.set("1", {
    candidateId: "candidate-1",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
  expireHoldOnBookingInsert = true;

  const response = await request("POST", "/api/bookings/confirm", {
    token: tokenFor("candidate-1", "candidate"),
    body: slotBody("1"),
  });

  assert.equal(response.status, 410);
  assert.equal(state.bookings.has("1"), false);
  assert.equal(state.holds.has("1"), false);
});

test("concurrent confirmation requests create at most one booking", async () => {
  state.holds.set("1", {
    candidateId: "candidate-1",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });

  const token = tokenFor("candidate-1", "candidate");
  const [first, second] = await Promise.all([
    request("POST", "/api/bookings/confirm", {
      token,
      body: slotBody("1"),
    }),
    request("POST", "/api/bookings/confirm", {
      token,
      body: slotBody("1"),
    }),
  ]);

  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  assert.equal(state.bookings.size, 1);
  assert.equal(state.holds.has("1"), false);
});

test("confirmation rolls back booking insertion if hold deletion fails", async () => {
  state.holds.set("1", {
    candidateId: "candidate-1",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
  failHoldDelete = true;

  const response = await request("POST", "/api/bookings/confirm", {
    token: tokenFor("candidate-1", "candidate"),
    body: slotBody("1"),
  });

  assert.equal(response.status, 500);
  assert.equal(state.bookings.has("1"), false);
  assert.equal(state.holds.get("1").candidateId, "candidate-1");
});

test("concurrent hold attempts for one slot allow only one candidate", async () => {
  const [first, second] = await Promise.all([
    request("POST", "/api/bookings/holds", {
      token: tokenFor("candidate-1", "candidate"),
      body: slotBody("4"),
    }),
    request("POST", "/api/bookings/holds", {
      token: tokenFor("candidate-2", "candidate"),
      body: slotBody("4"),
    }),
  ]);
  const statuses = [first.status, second.status].sort();

  assert.deepEqual(statuses, [201, 409]);
  assert.equal(state.holds.size, 1);
});

test("availability cannot be deleted while actively held or booked", async () => {
  const interviewerToken = tokenFor("interviewer-1", "interviewer");

  state.holds.set("1", {
    candidateId: "candidate-1",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
  const activeHoldResponse = await request("DELETE", "/api/availability/1", {
    token: interviewerToken,
  });
  assert.equal(activeHoldResponse.status, 409);

  state.holds.delete("1");
  state.bookings.set("1", { id: "1", candidate_id: "candidate-1" });
  const bookedResponse = await request("DELETE", "/api/availability/1", {
    token: interviewerToken,
  });
  assert.equal(bookedResponse.status, 409);

  const freeResponse = await request("DELETE", "/api/availability/4", {
    token: interviewerToken,
  });
  assert.equal(freeResponse.status, 200);
  assert.equal(state.slots.has("4"), false);
});

test("expired holds do not block deletion; another interviewer cannot delete the slot", async () => {
  const interviewerToken = tokenFor("interviewer-1", "interviewer");
  state.holds.set("1", {
    candidateId: "candidate-1",
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });

  const expiredHoldDelete = await request("DELETE", "/api/availability/1", {
    token: interviewerToken,
  });
  assert.equal(expiredHoldDelete.status, 200);
  assert.equal(state.slots.has("1"), false);
  assert.equal(state.holds.has("1"), false);

  const otherOwner = await request(
    "DELETE",
    "/api/availability/3",
    { token: interviewerToken }
  );
  assert.equal(otherOwner.status, 404);
  assert.equal(state.slots.has("3"), true);
});
