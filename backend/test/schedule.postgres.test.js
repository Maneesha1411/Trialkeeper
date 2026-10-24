const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { test } = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../src/config/db");
const scheduleRoutes = require("../src/routes/scheduleRoutes");

const enabled = process.env.TRIALKEEPER_PG_INTEGRATION === "1";
const originalFetch = global.fetch;

const tokenFor = (userId) =>
  jwt.sign({ userId, role: "coordinator" }, process.env.JWT_SECRET, {
    expiresIn: "5m",
  });

test("PostgreSQL scheduling input uses event data and excludes confirmed bookings", async (t) => {
  if (!enabled) {
    t.skip("Set TRIALKEEPER_PG_INTEGRATION=1 to run against PostgreSQL.");
    return;
  }

  const migrationCheck = await pool.query(
    `SELECT count(*)::int AS table_count
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [[
      "events",
      "event_working_hours",
      "event_rounds",
      "event_candidates",
      "event_candidate_availability",
    ]]
  );
  if (migrationCheck.rows[0].table_count !== 5) {
    t.skip("Apply 003_event_scheduling.sql before running this integration test.");
    return;
  }

  const previousSecretForTest = process.env.JWT_SECRET;
  process.env.JWT_SECRET ||= `schedule-postgres-${crypto.randomUUID()}`;
  const label = crypto.randomUUID();
  const userIds = [];
  const availabilityIds = [];
  let eventId;
  let server;
  let baseUrl;
  let capturedSolverRequest;

  t.after(async () => {
    global.fetch = originalFetch;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (availabilityIds.length > 0) {
      await pool.query(
        "DELETE FROM availability_holds WHERE availability_id = ANY($1::bigint[])",
        [availabilityIds]
      );
      await pool.query(
        "DELETE FROM interview_bookings WHERE availability_id = ANY($1::bigint[])",
        [availabilityIds]
      );
      await pool.query(
        "DELETE FROM interviewer_availability WHERE id = ANY($1::bigint[])",
        [availabilityIds]
      );
    }
    if (eventId) {
      await pool.query("DELETE FROM events WHERE id = $1", [eventId]);
    }
    if (userIds.length > 0) {
      await pool.query("DELETE FROM users WHERE id = ANY($1::integer[])", [userIds]);
    }
    if (previousSecretForTest === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousSecretForTest;
    }
  });

  const dateResult = await pool.query(
    `SELECT (CURRENT_DATE + 3)::date::text AS event_date,
            upper(to_char(CURRENT_DATE + 3, 'FMDay')) AS day_of_week`
  );
  const { event_date: eventDate, day_of_week: dayOfWeek } = dateResult.rows[0];

  const coordinator = await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ('Scheduling integration coordinator', $1, 'test-only-hash', 'coordinator')
     RETURNING id`,
    [`schedule-coordinator-${label}@example.invalid`]
  );
  userIds.push(coordinator.rows[0].id);

  const candidate = await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ('Scheduling integration candidate', $1, 'test-only-hash', 'candidate')
     RETURNING id`,
    [`schedule-candidate-${label}@example.invalid`]
  );
  userIds.push(candidate.rows[0].id);

  const interviewer = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, skill_tags)
     VALUES ('Scheduling integration interviewer', $1, 'test-only-hash',
             'interviewer', ARRAY['JavaScript'])
     RETURNING id`,
    [`schedule-interviewer-${label}@example.invalid`]
  );
  userIds.push(interviewer.rows[0].id);

  const event = await pool.query(
    `INSERT INTO events
       (coordinator_id, name, time_zone, start_date, end_date,
        candidate_buffer_minutes, interviewer_buffer_minutes)
     VALUES ($1, 'Scheduling integration event', 'UTC', $2, $2, 0, 0)
     RETURNING id`,
    [coordinator.rows[0].id, eventDate]
  );
  eventId = event.rows[0].id;

  await pool.query(
    `INSERT INTO event_working_hours (event_id, day_of_week, start_time, end_time)
     VALUES ($1, $2, '09:00', '12:00')`,
    [eventId, dayOfWeek]
  );
  await pool.query(
    `INSERT INTO event_rounds
       (event_id, round_id, round_order, duration_minutes, required_skills)
     VALUES ($1, 'screen', 1, 30, ARRAY['JavaScript'])`,
    [eventId]
  );
  await pool.query(
    "INSERT INTO event_candidates (event_id, candidate_id) VALUES ($1, $2)",
    [eventId, candidate.rows[0].id]
  );
  await pool.query(
    `INSERT INTO event_candidate_availability
       (event_id, candidate_id, start_time, end_time)
     VALUES (
       $1, $2,
       ($3::date + TIME '09:00') AT TIME ZONE 'UTC',
       ($3::date + TIME '12:00') AT TIME ZONE 'UTC'
     )`,
    [eventId, candidate.rows[0].id, eventDate]
  );

  for (const [start, end] of [
    ["09:00", "10:00"],
    ["10:00", "10:30"],
    ["10:30", "12:00"],
  ]) {
    const availability = await pool.query(
      `INSERT INTO interviewer_availability (interviewer_id, start_time, end_time)
       VALUES (
         $1,
         ($2::date + $3::time) AT TIME ZONE 'UTC',
         ($2::date + $4::time) AT TIME ZONE 'UTC'
       )
       RETURNING id`,
      [interviewer.rows[0].id, eventDate, start, end]
    );
    availabilityIds.push(availability.rows[0].id);
  }
  await pool.query(
    `INSERT INTO interview_bookings (availability_id, candidate_id)
     VALUES ($1, $2)`,
    [availabilityIds[1], candidate.rows[0].id]
  );

  const app = express();
  app.use(express.json());
  app.use("/api/schedules", scheduleRoutes);
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  global.fetch = async (_url, options) => {
    capturedSolverRequest = JSON.parse(options.body);
    const startTime = `${eventDate}T10:30:00Z`;
    const endTime = `${eventDate}T11:00:00Z`;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: "success",
        message: "All required interviews were scheduled.",
        schedule: [{
          candidateId: String(candidate.rows[0].id),
          roundId: "screen",
          interviewerId: String(interviewer.rows[0].id),
          startTime,
          endTime,
        }],
        unscheduled: [],
        errors: [],
      }),
    };
  };

  const response = await originalFetch(`${baseUrl}/api/schedules/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenFor(coordinator.rows[0].id)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ eventId: String(eventId) }),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(capturedSolverRequest.candidates[0].candidateId, String(candidate.rows[0].id));
  assert.equal(capturedSolverRequest.interviewers[0].interviewerId, String(interviewer.rows[0].id));
  assert.deepEqual(
    capturedSolverRequest.candidates[0].availabilityIntervals.map((interval) => [
      interval.startTime.slice(11, 16),
      interval.endTime.slice(11, 16),
    ]),
    [["09:00", "10:00"], ["10:30", "12:00"]]
  );
  assert.deepEqual(
    capturedSolverRequest.interviewers[0].availabilityIntervals.map((interval) => [
      interval.startTime.slice(11, 16),
      interval.endTime.slice(11, 16),
    ]),
    [["09:00", "10:00"], ["10:30", "12:00"]]
  );
  assert.equal(result.schedule[0].startTime, `${eventDate}T10:30:00Z`);
});
