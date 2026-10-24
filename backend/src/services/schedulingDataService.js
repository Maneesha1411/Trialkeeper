const asIsoString = (value) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const normalizeSkill = (value) =>
  value.trim().toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ");

const subtractIntervals = (intervals, blockedIntervals, bufferMinutes) => {
  const bufferMs = bufferMinutes * 60 * 1000;
  let available = intervals.map((interval) => ({
    start: Date.parse(interval.startTime),
    end: Date.parse(interval.endTime),
  }));

  for (const blocked of blockedIntervals) {
    const blockedStart = Date.parse(blocked.startTime) - bufferMs;
    const blockedEnd = Date.parse(blocked.endTime) + bufferMs;
    available = available.flatMap((interval) => {
      if (blockedEnd <= interval.start || blockedStart >= interval.end) {
        return [interval];
      }

      const remaining = [];
      if (blockedStart > interval.start) {
        remaining.push({ start: interval.start, end: blockedStart });
      }
      if (blockedEnd < interval.end) {
        remaining.push({ start: blockedEnd, end: interval.end });
      }
      return remaining;
    });
  }

  return available
    .filter((interval) => interval.end > interval.start)
    .map((interval) => ({
      startTime: new Date(interval.start).toISOString(),
      endTime: new Date(interval.end).toISOString(),
    }));
};

const missingDataError = (message, path) => {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = "MISSING_SCHEDULING_DATA";
  error.path = path;
  return error;
};

const normalizedSkills = (skills, path) => {
  if (
    !Array.isArray(skills) ||
    skills.some((skill) => typeof skill !== "string" || !skill.trim())
  ) {
    throw missingDataError("Scheduling skills contain invalid values.", path);
  }
  return [...new Set(skills.map(normalizeSkill))];
};

const loadSchedulingRequest = async (pool, eventId, coordinatorId) => {
  const eventResult = await pool.query(
    `SELECT id, time_zone, start_date::text AS start_date,
            end_date::text AS end_date,
            candidate_buffer_minutes, interviewer_buffer_minutes,
            (start_date::timestamp AT TIME ZONE time_zone) AS range_start,
            ((end_date + 1)::timestamp AT TIME ZONE time_zone) AS range_end
     FROM events
     WHERE id = $1
       AND coordinator_id = $2
       AND is_active = TRUE`,
    [eventId, coordinatorId]
  );

  if (eventResult.rows.length === 0) {
    const error = new Error("Event not found.");
    error.statusCode = 404;
    error.code = "EVENT_NOT_FOUND";
    error.path = "eventId";
    throw error;
  }

  const event = eventResult.rows[0];
  const [hoursResult, roundsResult, candidatesResult, interviewersResult, conflictsResult] =
    await Promise.all([
      pool.query(
        `SELECT day_of_week, start_time::text AS start_time,
                end_time::text AS end_time
         FROM event_working_hours
         WHERE event_id = $1
         ORDER BY CASE day_of_week
           WHEN 'MONDAY' THEN 1 WHEN 'TUESDAY' THEN 2
           WHEN 'WEDNESDAY' THEN 3 WHEN 'THURSDAY' THEN 4
           WHEN 'FRIDAY' THEN 5 WHEN 'SATURDAY' THEN 6 ELSE 7 END,
           start_time`,
        [eventId]
      ),
      pool.query(
        `SELECT round_id, round_order, duration_minutes, required_skills
         FROM event_rounds
         WHERE event_id = $1
         ORDER BY round_order`,
        [eventId]
      ),
      pool.query(
        `SELECT u.id AS candidate_id,
                CASE WHEN a.id IS NULL THEN NULL
                     ELSE GREATEST(a.start_time, $2::timestamptz) END AS start_time,
                CASE WHEN a.id IS NULL THEN NULL
                     ELSE LEAST(a.end_time, $3::timestamptz) END AS end_time
         FROM event_candidates ec
         JOIN users u ON u.id = ec.candidate_id AND u.role = 'candidate'
         LEFT JOIN event_candidate_availability a
           ON a.event_id = ec.event_id AND a.candidate_id = ec.candidate_id
          AND a.start_time < $3 AND a.end_time > $2
         WHERE ec.event_id = $1
         ORDER BY u.id, a.start_time`,
        [eventId, event.range_start, event.range_end]
      ),
      pool.query(
        `SELECT DISTINCT u.id AS interviewer_id, u.skill_tags
         FROM users u
         JOIN interviewer_availability a ON a.interviewer_id = u.id
         WHERE u.role = 'interviewer'
           AND a.start_time < $2
           AND a.end_time > $1
         ORDER BY u.id`,
        [event.range_start, event.range_end]
      ),
      pool.query(
        `SELECT b.candidate_id, a.interviewer_id, a.start_time, a.end_time
         FROM interview_bookings b
         JOIN interviewer_availability a ON a.id = b.availability_id
         WHERE a.start_time < $1 AND a.end_time > $2
         UNION ALL
         SELECT h.candidate_id, a.interviewer_id, a.start_time, a.end_time
         FROM availability_holds h
         JOIN interviewer_availability a ON a.id = h.availability_id
         WHERE h.expires_at > clock_timestamp()
           AND a.start_time < $1 AND a.end_time > $2`,
        [event.range_end, event.range_start]
      ),
    ]);

  const requiredData = [
    [hoursResult.rows.length > 0, "Event working hours are not configured.", "workingHours"],
    [roundsResult.rows.length > 0, "Event interview rounds are not configured.", "rounds"],
    [candidatesResult.rows.length > 0, "No candidates are enrolled in this event.", "candidates"],
    [interviewersResult.rows.length > 0, "No interviewers have availability during this event.", "interviewers"],
  ];
  for (const [available, message, path] of requiredData) {
    if (!available) {
      throw missingDataError(message, path);
    }
  }

  const conflictsByCandidate = new Map();
  const conflictsByInterviewer = new Map();
  for (const conflict of conflictsResult.rows) {
    const interval = {
      startTime: asIsoString(conflict.start_time),
      endTime: asIsoString(conflict.end_time),
    };
    const candidateKey = String(conflict.candidate_id);
    const interviewerKey = String(conflict.interviewer_id);
    conflictsByCandidate.set(candidateKey, [
      ...(conflictsByCandidate.get(candidateKey) || []),
      interval,
    ]);
    conflictsByInterviewer.set(interviewerKey, [
      ...(conflictsByInterviewer.get(interviewerKey) || []),
      interval,
    ]);
  }

  const candidatesById = new Map();
  for (const row of candidatesResult.rows) {
    const id = String(row.candidate_id);
    if (!candidatesById.has(id)) {
      candidatesById.set(id, { candidateId: id, availabilityIntervals: [] });
    }
    if (row.start_time && row.end_time) {
      candidatesById.get(id).availabilityIntervals.push({
        startTime: asIsoString(row.start_time),
        endTime: asIsoString(row.end_time),
      });
    }
  }

  const candidates = [...candidatesById.values()];
  for (const candidate of candidates) {
    candidate.availabilityIntervals = subtractIntervals(
      candidate.availabilityIntervals,
      conflictsByCandidate.get(candidate.candidateId) || [],
      Number(event.candidate_buffer_minutes)
    );
    candidate.breaks = [];
  }

  const candidateWithoutAvailability = candidates.find(
    (candidate) => candidate.availabilityIntervals.length === 0
  );
  if (candidateWithoutAvailability) {
    throw missingDataError(
      `Enrolled candidate ${candidateWithoutAvailability.candidateId} has no available time after existing bookings.`,
      `candidates.${candidateWithoutAvailability.candidateId}.availabilityIntervals`
    );
  }

  const interviewerIds = interviewersResult.rows.map((row) => String(row.interviewer_id));
  const interviewerAvailabilityResult = await pool.query(
    `SELECT u.id AS interviewer_id,
            GREATEST(a.start_time, $2::timestamptz) AS start_time,
            LEAST(a.end_time, $3::timestamptz) AS end_time
     FROM users u
     JOIN interviewer_availability a ON a.interviewer_id = u.id
     WHERE u.role = 'interviewer'
       AND u.id = ANY($1::integer[])
       AND a.start_time < $3
       AND a.end_time > $2
     ORDER BY u.id, a.start_time`,
    [interviewerIds, event.range_start, event.range_end]
  );

  const availabilityByInterviewer = new Map();
  for (const row of interviewerAvailabilityResult.rows) {
    const id = String(row.interviewer_id);
    availabilityByInterviewer.set(id, [
      ...(availabilityByInterviewer.get(id) || []),
      {
        startTime: asIsoString(row.start_time),
        endTime: asIsoString(row.end_time),
      },
    ]);
  }

  const interviewers = interviewersResult.rows
    .map((row) => {
      const id = String(row.interviewer_id);
      return {
        interviewerId: id,
        skills: normalizedSkills(row.skill_tags || [], "interviewers.skills"),
        availabilityIntervals: subtractIntervals(
          availabilityByInterviewer.get(id) || [],
          conflictsByInterviewer.get(id) || [],
          Number(event.interviewer_buffer_minutes)
        ),
        breaks: [],
      };
    })
    .filter((interviewer) => interviewer.availabilityIntervals.length > 0);

  if (interviewers.length === 0) {
    throw missingDataError(
      "No interviewer availability remains after existing bookings.",
      "interviewers"
    );
  }

  return {
    eventId: String(event.id),
    timeZone: event.time_zone,
    dateRange: {
      startDate: event.start_date,
      endDate: event.end_date,
    },
    workingHours: hoursResult.rows.map((row) => ({
      dayOfWeek: row.day_of_week,
      startTime: row.start_time,
      endTime: row.end_time,
    })),
    bufferMinutes: {
      candidate: Number(event.candidate_buffer_minutes),
      interviewer: Number(event.interviewer_buffer_minutes),
    },
    rounds: roundsResult.rows.map((row) => ({
      roundId: row.round_id,
      order: Number(row.round_order),
      durationMinutes: Number(row.duration_minutes),
      requiredSkills: normalizedSkills(
        row.required_skills || [],
        `rounds.${row.round_id}.requiredSkills`
      ),
    })),
    candidates,
    interviewers,
  };
};

module.exports = { loadSchedulingRequest };
