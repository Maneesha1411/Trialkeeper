const STATUS_VALUES = new Set([
  "success",
  "partial",
  "unschedulable",
  "error",
]);

const normalizeSkill = (value) =>
  value.trim().toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ");

const toMillis = (value) => {
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
};

const localParts = (instant, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "long",
  }).formatToParts(new Date(instant));
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
};

const timeToSeconds = (value) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d+))?)?$/.exec(value);
  return match
    ? Number(match[1]) * 3600 +
        Number(match[2]) * 60 +
        Number(match[3] || 0) +
        (match[4] ? Number(`0.${match[4]}`) : 0)
    : null;
};

const intervalContains = (intervals, start, end) =>
  intervals.some((interval) => {
    const intervalStart = toMillis(interval.startTime);
    const intervalEnd = toMillis(interval.endTime);
    return intervalStart !== null &&
      intervalEnd !== null &&
      intervalStart <= start &&
      intervalEnd >= end;
  });

const hasExplicitOffset = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);

const isWithinWorkingHours = (item, request) => {
  const startParts = localParts(item.startTime, request.timeZone);
  const endParts = localParts(item.endTime, request.timeZone);
  const localDate = `${startParts.year}-${startParts.month}-${startParts.day}`;
  if (
    localDate < request.dateRange.startDate ||
    localDate > request.dateRange.endDate ||
    localDate !== `${endParts.year}-${endParts.month}-${endParts.day}`
  ) {
    return false;
  }

  const dayName = startParts.weekday.toUpperCase();
  const localStart =
    Number(startParts.hour) * 3600 +
    Number(startParts.minute) * 60 +
    Number(startParts.second);
  const localEnd =
    Number(endParts.hour) * 3600 +
    Number(endParts.minute) * 60 +
    Number(endParts.second);
  const matchingHours = request.workingHours.filter(
    (hours) => hours.dayOfWeek === dayName
  );

  return matchingHours.some((hours) => {
    const hoursStart = timeToSeconds(hours.startTime);
    const hoursEnd = timeToSeconds(hours.endTime);
    return hoursStart !== null &&
      hoursEnd !== null &&
      localStart >= hoursStart &&
      localEnd <= hoursEnd;
  });
};

const invalidResponse = (message) => {
  const error = new Error(message);
  error.statusCode = 502;
  error.code = "INVALID_SOLVER_ASSIGNMENT";
  error.path = "schedule";
  return error;
};

const validateSolverResponse = (response, request) => {
  if (
    !response ||
    typeof response !== "object" ||
    !STATUS_VALUES.has(response.status) ||
    typeof response.message !== "string" ||
    response.message.trim().length === 0 ||
    !Array.isArray(response.schedule) ||
    !Array.isArray(response.unscheduled) ||
    !Array.isArray(response.errors)
  ) {
    throw invalidResponse("Solver returned an invalid response.");
  }

  if (
    response.errors.some(
      (error) =>
        !error ||
        typeof error.code !== "string" ||
        error.code.trim().length === 0 ||
        typeof error.message !== "string" ||
        error.message.trim().length === 0 ||
        (error.path !== undefined && error.path !== null && typeof error.path !== "string")
    )
  ) {
    throw invalidResponse("Solver returned invalid error details.");
  }

  if (response.status === "error") {
    if (
      response.errors.length === 0 ||
      response.schedule.length > 0 ||
      response.unscheduled.length > 0
    ) {
      throw invalidResponse("Solver error response is inconsistent.");
    }
    return response;
  }

  const candidates = new Map(
    request.candidates.map((item) => [String(item.candidateId), item])
  );
  const interviewers = new Map(
    request.interviewers.map((item) => [String(item.interviewerId), item])
  );
  const rounds = new Map(
    request.rounds.map((item) => [String(item.roundId), item])
  );
  const assignments = new Map();
  const scheduledPairs = new Set();

  for (const assignment of response.schedule) {
    const candidateId = String(assignment.candidateId);
    const interviewerId = String(assignment.interviewerId);
    const roundId = String(assignment.roundId);
    const candidate = candidates.get(candidateId);
    const interviewer = interviewers.get(interviewerId);
    const round = rounds.get(roundId);
    const start = toMillis(assignment.startTime);
    const end = toMillis(assignment.endTime);
    const pairKey = `${candidateId}:${roundId}`;

    if (
      !candidate ||
      !interviewer ||
      !round ||
      !hasExplicitOffset(assignment.startTime) ||
      !hasExplicitOffset(assignment.endTime) ||
      start === null ||
      end === null ||
      end - start !== round.durationMinutes * 60 * 1000 ||
      start % (5 * 60 * 1000) !== 0 ||
      !intervalContains(candidate.availabilityIntervals, start, end) ||
      !intervalContains(interviewer.availabilityIntervals, start, end) ||
      !isWithinWorkingHours(assignment, request) ||
      round.requiredSkills.some(
        (skill) =>
          !interviewer.skills.some(
            (interviewerSkill) =>
              normalizeSkill(interviewerSkill) === normalizeSkill(skill)
          )
      ) ||
      scheduledPairs.has(pairKey)
    ) {
      throw invalidResponse("Solver returned an ineligible or invalid assignment.");
    }

    scheduledPairs.add(pairKey);
    assignments.set(pairKey, {
      ...assignment,
      candidateId,
      interviewerId,
      roundId,
      start,
      end,
      roundOrder: round.order,
    });
  }

  const unscheduledPairs = new Set();
  for (const item of response.unscheduled) {
    const candidateId = String(item.candidateId);
    const roundId = String(item.roundId);
    const pairKey = `${candidateId}:${roundId}`;
    if (
      !candidates.has(candidateId) ||
      !rounds.has(roundId) ||
      unscheduledPairs.has(pairKey) ||
      typeof item.reasonCode !== "string" ||
      item.reasonCode.trim().length === 0 ||
      typeof item.message !== "string" ||
      item.message.trim().length === 0
    ) {
      throw invalidResponse("Solver returned an invalid unscheduled interview.");
    }
    unscheduledPairs.add(pairKey);
  }

  const requiredPairs = new Set();
  for (const candidateId of candidates.keys()) {
    for (const roundId of rounds.keys()) {
      requiredPairs.add(`${candidateId}:${roundId}`);
    }
  }
  if (
    scheduledPairs.size + unscheduledPairs.size !== requiredPairs.size ||
    [...requiredPairs].some(
      (pairKey) =>
        scheduledPairs.has(pairKey) === unscheduledPairs.has(pairKey)
    )
  ) {
    throw invalidResponse("Solver response does not account for every required interview.");
  }

  const byCandidate = new Map();
  const byInterviewer = new Map();
  for (const assignment of assignments.values()) {
    byCandidate.set(assignment.candidateId, [
      ...(byCandidate.get(assignment.candidateId) || []),
      assignment,
    ]);
    byInterviewer.set(assignment.interviewerId, [
      ...(byInterviewer.get(assignment.interviewerId) || []),
      assignment,
    ]);
  }

  for (const [candidateId, candidateAssignments] of byCandidate) {
    candidateAssignments.sort((a, b) => a.roundOrder - b.roundOrder);
    for (let index = 1; index < candidateAssignments.length; index += 1) {
      const previous = candidateAssignments[index - 1];
      const current = candidateAssignments[index];
      if (
        current.roundOrder <= previous.roundOrder ||
        current.start < previous.end + request.bufferMinutes.candidate * 60000
      ) {
        throw invalidResponse(`Solver returned conflicting rounds for candidate ${candidateId}.`);
      }
    }
  }

  for (const [interviewerId, interviewerAssignments] of byInterviewer) {
    interviewerAssignments.sort((a, b) => a.start - b.start);
    for (let index = 1; index < interviewerAssignments.length; index += 1) {
      if (
        interviewerAssignments[index].start <
        interviewerAssignments[index - 1].end +
          request.bufferMinutes.interviewer * 60000
      ) {
        throw invalidResponse(`Solver returned conflicting interviews for interviewer ${interviewerId}.`);
      }
    }
  }

  if (
    (response.status === "success" &&
      (response.unscheduled.length > 0 || response.errors.length > 0)) ||
    (response.status === "partial" &&
      (response.schedule.length === 0 ||
        response.unscheduled.length === 0 ||
        response.errors.length > 0)) ||
    (response.status === "unschedulable" &&
      (response.schedule.length > 0 || response.errors.length > 0)) ||
    (response.status === "error" && response.errors.length === 0)
  ) {
    throw invalidResponse("Solver status does not match its result.");
  }

  return response;
};

module.exports = { validateSolverResponse };
