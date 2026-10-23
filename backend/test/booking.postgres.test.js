const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { after, before, test } = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../src/config/db");
const availabilityRoutes = require("../src/routes/availabilityRoutes");
const bookingRoutes = require("../src/routes/bookingRoutes");

const enabled =
  process.env.TRIALKEEPER_PG_INTEGRATION === "1" &&
  typeof process.env.JWT_SECRET === "string" &&
  process.env.JWT_SECRET.length > 0;
let server;
let baseUrl;
const userIds = [];
const availabilityIds = [];

const tokenFor = (userId, role) =>
  jwt.sign({ userId, role }, process.env.JWT_SECRET, { expiresIn: "5m" });

const request = (method, route, { token, body } = {}) => {
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

const createTestUser = async (role, label) => {
  const email = `trialkeeper-${label}-${crypto.randomUUID()}@example.invalid`;
  const result = await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [`Booking integration ${label}`, email, "test-only-unusable-password-hash", role]
  );
  const id = result.rows[0].id;
  userIds.push(id);
  return id;
};

const createAvailability = async (interviewerId, slotNumber) => {
  const result = await pool.query(
    `WITH slot_start AS (
       SELECT clock_timestamp()
         + INTERVAL '2 days'
         + ($2 * INTERVAL '2 hours') AS start_time
     )
     INSERT INTO interviewer_availability
       (interviewer_id, start_time, end_time)
     SELECT $1, slot_start.start_time,
            slot_start.start_time + INTERVAL '1 hour'
     FROM slot_start
     RETURNING id`,
    [interviewerId, slotNumber]
  );
  const id = result.rows[0].id;
  availabilityIds.push(id);
  return String(id);
};

const cleanup = async () => {
  for (const availabilityId of availabilityIds) {
    await pool.query(
      "DELETE FROM availability_holds WHERE availability_id = $1",
      [availabilityId]
    );
    await pool.query(
      "DELETE FROM interview_bookings WHERE availability_id = $1",
      [availabilityId]
    );
    await pool.query(
      "DELETE FROM interviewer_availability WHERE id = $1",
      [availabilityId]
    );
  }

  for (const userId of userIds) {
    await pool.query(
      "DELETE FROM availability_holds WHERE candidate_id = $1",
      [userId]
    );
    await pool.query(
      "DELETE FROM interview_bookings WHERE candidate_id = $1",
      [userId]
    );
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  }
};

before(async () => {
  if (!enabled) {
    return;
  }

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

after(async () => {
  if (enabled) {
    try {
      await cleanup();
    } finally {
      if (server) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  }
});

test("PostgreSQL booking hold expiry, locking, uniqueness, and deletion integration", {
  skip: !enabled
    ? "Set TRIALKEEPER_PG_INTEGRATION=1 and configure JWT_SECRET to run against PostgreSQL."
    : false,
}, async () => {
  const interviewerId = await createTestUser("interviewer", "interviewer");
  const otherInterviewerId = await createTestUser("interviewer", "other-interviewer");
  const candidateOneId = await createTestUser("candidate", "candidate-one");
  const candidateTwoId = await createTestUser("candidate", "candidate-two");
  const interviewerHeaders = {
    Authorization: `Bearer ${tokenFor(interviewerId, "interviewer")}`,
  };
  const otherInterviewerHeaders = {
    Authorization: `Bearer ${tokenFor(otherInterviewerId, "interviewer")}`,
  };
  const candidateOneHeaders = {
    Authorization: `Bearer ${tokenFor(candidateOneId, "candidate")}`,
  };
  const candidateTwoHeaders = {
    Authorization: `Bearer ${tokenFor(candidateTwoId, "candidate")}`,
  };

  const reclaimSlotId = await createAvailability(interviewerId, 0);
  const expiredConfirmSlotId = await createAvailability(interviewerId, 1);
  const concurrentSlotId = await createAvailability(interviewerId, 2);
  const ownershipSlotId = await createAvailability(interviewerId, 3);

  const firstHold = await request("POST", "/api/bookings/holds", {
    token: tokenFor(candidateOneId, "candidate"),
    body: { availabilityId: reclaimSlotId },
  });
  assert.equal(firstHold.status, 201);

  await pool.query(
    `UPDATE availability_holds
     SET created_at = clock_timestamp() - INTERVAL '10 minutes',
         expires_at = clock_timestamp() - INTERVAL '9 minutes'
     WHERE availability_id = $1`,
    [reclaimSlotId]
  );

  const reclaimedHold = await request("POST", "/api/bookings/holds", {
    token: tokenFor(candidateTwoId, "candidate"),
    body: { availabilityId: reclaimSlotId },
  });
  assert.equal(reclaimedHold.status, 201);

  const reclaimedOwner = await pool.query(
    "SELECT candidate_id FROM availability_holds WHERE availability_id = $1",
    [reclaimSlotId]
  );
  assert.equal(String(reclaimedOwner.rows[0].candidate_id), String(candidateTwoId));

  await pool.query(
    `UPDATE availability_holds
     SET created_at = clock_timestamp() - INTERVAL '2 minutes',
         expires_at = clock_timestamp() - INTERVAL '1 minute'
     WHERE availability_id = $1`,
    [reclaimSlotId]
  );
  const expiredHoldDeletion = await request(
    "DELETE",
    `/api/availability/${reclaimSlotId}`,
    { token: interviewerHeaders.Authorization.slice(7) }
  );
  assert.equal(expiredHoldDeletion.status, 200);

  const expiringHold = await request("POST", "/api/bookings/holds", {
    token: tokenFor(candidateOneId, "candidate"),
    body: { availabilityId: expiredConfirmSlotId },
  });
  assert.equal(expiringHold.status, 201);
  await pool.query(
    `UPDATE availability_holds
     SET created_at = clock_timestamp() - INTERVAL '2 minutes',
         expires_at = clock_timestamp() - INTERVAL '1 minute'
     WHERE availability_id = $1`,
    [expiredConfirmSlotId]
  );
  const expiredConfirmation = await request("POST", "/api/bookings/confirm", {
    token: tokenFor(candidateOneId, "candidate"),
    body: { availabilityId: expiredConfirmSlotId },
  });
  assert.equal(expiredConfirmation.status, 410);
  assert.equal(
    (await pool.query(
      "SELECT 1 FROM availability_holds WHERE availability_id = $1",
      [expiredConfirmSlotId]
    )).rowCount,
    0
  );

  const boundaryHold = await request("POST", "/api/bookings/holds", {
    token: tokenFor(candidateOneId, "candidate"),
    body: { availabilityId: expiredConfirmSlotId },
  });
  assert.equal(boundaryHold.status, 201);
  await pool.query(
    `UPDATE availability_holds
     SET created_at = clock_timestamp() - INTERVAL '1 minute',
         expires_at = clock_timestamp()
     WHERE availability_id = $1`,
    [expiredConfirmSlotId]
  );
  const boundaryConfirmation = await request("POST", "/api/bookings/confirm", {
    token: tokenFor(candidateOneId, "candidate"),
    body: { availabilityId: expiredConfirmSlotId },
  });
  assert.equal(boundaryConfirmation.status, 410);

  const concurrentHolds = await Promise.all([
    request("POST", "/api/bookings/holds", {
      token: tokenFor(candidateOneId, "candidate"),
      body: { availabilityId: concurrentSlotId },
    }),
    request("POST", "/api/bookings/holds", {
      token: tokenFor(candidateTwoId, "candidate"),
      body: { availabilityId: concurrentSlotId },
    }),
  ]);
  assert.deepEqual(
    concurrentHolds.map((response) => response.status).sort(),
    [201, 409]
  );

  const activeHoldDelete = await request(
    "DELETE",
    `/api/availability/${concurrentSlotId}`,
    { token: interviewerHeaders.Authorization.slice(7) }
  );
  assert.equal(activeHoldDelete.status, 409);

  const winningHold = await pool.query(
    `SELECT candidate_id
     FROM availability_holds
     WHERE availability_id = $1`,
    [concurrentSlotId]
  );
  const winningCandidateId = winningHold.rows[0].candidate_id;
  const winningToken = tokenFor(winningCandidateId, "candidate");
  const concurrentConfirmations = await Promise.all([
    request("POST", "/api/bookings/confirm", {
      token: winningToken,
      body: { availabilityId: concurrentSlotId },
    }),
    request("POST", "/api/bookings/confirm", {
      token: winningToken,
      body: { availabilityId: concurrentSlotId },
    }),
  ]);
  assert.deepEqual(
    concurrentConfirmations.map((response) => response.status).sort(),
    [201, 409]
  );

  const bookingCount = await pool.query(
    "SELECT count(*)::int AS count FROM interview_bookings WHERE availability_id = $1",
    [concurrentSlotId]
  );
  assert.equal(bookingCount.rows[0].count, 1);
  assert.equal(
    (await pool.query(
      "SELECT 1 FROM availability_holds WHERE availability_id = $1",
      [concurrentSlotId]
    )).rowCount,
    0
  );

  const bookedSlotDelete = await request(
    "DELETE",
    `/api/availability/${concurrentSlotId}`,
    { token: interviewerHeaders.Authorization.slice(7) }
  );
  assert.equal(bookedSlotDelete.status, 409);

  const otherInterviewerDelete = await request(
    "DELETE",
    `/api/availability/${ownershipSlotId}`,
    { token: otherInterviewerHeaders.Authorization.slice(7) }
  );
  assert.equal(otherInterviewerDelete.status, 404);

  const ownerStillHasSlot = await pool.query(
    "SELECT 1 FROM interviewer_availability WHERE id = $1 AND interviewer_id = $2",
    [ownershipSlotId, interviewerId]
  );
  assert.equal(ownerStillHasSlot.rowCount, 1);
});
