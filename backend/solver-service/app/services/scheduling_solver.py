from datetime import datetime, time, timedelta, timezone
from itertools import combinations
import math
from zoneinfo import ZoneInfo

from ortools.sat.python import cp_model

from app.schemas.scheduling import (
    ScheduleStatus,
    ScheduledInterview,
    SchedulingError,
    SchedulingRequest,
    SchedulingResponse,
    UnscheduledInterview,
)


UTC = timezone.utc
START_INCREMENT_MINUTES = 5


class InvalidLocalTimeError(ValueError):
    """Raised when an event-local time is ambiguous or does not exist."""


def _resolve_local_time(value: datetime, zone: ZoneInfo) -> datetime:
    possible_instants: dict[datetime, datetime] = {}

    for fold in (0, 1):
        zoned_value = value.replace(tzinfo=zone, fold=fold)
        utc_value = zoned_value.astimezone(UTC)
        if utc_value.astimezone(zone).replace(tzinfo=None) == value:
            possible_instants[utc_value] = zoned_value

    if not possible_instants:
        raise InvalidLocalTimeError(
            f"Local time {value.isoformat()} does not exist in {zone.key}."
        )

    if len(possible_instants) > 1:
        raise InvalidLocalTimeError(
            f"Local time {value.isoformat()} is ambiguous in {zone.key}."
        )

    return next(iter(possible_instants.values()))


def _local_windows(
    request: SchedulingRequest,
) -> list[tuple[datetime, datetime]]:
    zone = ZoneInfo(request.time_zone)
    windows: list[tuple[datetime, datetime]] = []
    day_count = (request.date_range.end_date - request.date_range.start_date).days

    for day_offset in range(day_count + 1):
        current_date = request.date_range.start_date + timedelta(days=day_offset)
        day_name = current_date.strftime("%A").upper()

        for working_hours in request.working_hours:
            if working_hours.day_of_week.value != day_name:
                continue

            local_start = datetime.combine(current_date, working_hours.start_time)
            local_end = datetime.combine(current_date, working_hours.end_time)
            start = _resolve_local_time(local_start, zone).astimezone(UTC)
            end = _resolve_local_time(local_end, zone).astimezone(UTC)

            if end <= start:
                raise InvalidLocalTimeError(
                    f"Working hours on {current_date.isoformat()} do not form "
                    "a positive UTC interval in the event timezone."
                )

            windows.append((start, end))

    return windows


def _intervals_overlap(
    start: datetime,
    end: datetime,
    intervals: list[tuple[datetime, datetime]],
) -> bool:
    return any(start < interval_end and end > interval_start for interval_start, interval_end in intervals)


def _utc_intervals(intervals) -> list[tuple[datetime, datetime]]:
    return [
        (
            interval.start_time.astimezone(UTC),
            interval.end_time.astimezone(UTC),
        )
        for interval in intervals
    ]


def _local_start_candidates(
    window_start: datetime,
    window_end: datetime,
    duration: timedelta,
    zone: ZoneInfo,
):
    first_local = window_start.astimezone(zone).replace(tzinfo=None)
    last_local = window_end.astimezone(zone).replace(tzinfo=None)

    local_increment = timedelta(minutes=START_INCREMENT_MINUTES)
    elapsed = first_local.hour * 60 + first_local.minute
    rounded_minutes = (
        (elapsed + START_INCREMENT_MINUTES - 1)
        // START_INCREMENT_MINUTES
        * START_INCREMENT_MINUTES
    )
    candidate_local = datetime.combine(first_local.date(), time.min) + timedelta(
        minutes=rounded_minutes
    )

    while candidate_local < last_local:
        resolved_local = _resolve_local_time(candidate_local, zone)
        start = resolved_local.astimezone(UTC)
        if start >= window_start and start + duration <= window_end:
            yield start
        candidate_local += local_increment


def _assignment_candidates(request: SchedulingRequest):
    zone = ZoneInfo(request.time_zone)
    windows = _local_windows(request)
    rounds = sorted(request.rounds, key=lambda round_item: round_item.order)
    assignments = []

    for candidate in request.candidates:
        candidate_availability = _utc_intervals(candidate.availability_intervals)
        candidate_breaks = _utc_intervals(candidate.breaks)

        for round_item in rounds:
            required_skills = {
                skill.strip().casefold() for skill in round_item.required_skills
            }
            duration = timedelta(minutes=round_item.duration_minutes)
            choices = []

            for interviewer in request.interviewers:
                interviewer_skills = {
                    skill.strip().casefold() for skill in interviewer.skills
                }
                if not required_skills.issubset(interviewer_skills):
                    continue

                interviewer_availability = _utc_intervals(
                    interviewer.availability_intervals
                )
                interviewer_breaks = _utc_intervals(interviewer.breaks)

                for window_start, window_end in windows:
                    for start in _local_start_candidates(
                        window_start,
                        window_end,
                        duration,
                        zone,
                    ):
                        end = start + duration

                        if not any(
                            start >= available_start and end <= available_end
                            for available_start, available_end in candidate_availability
                        ):
                            continue

                        if not any(
                            start >= available_start and end <= available_end
                            for available_start, available_end in interviewer_availability
                        ):
                            continue

                        if _intervals_overlap(start, end, candidate_breaks):
                            continue

                        if _intervals_overlap(start, end, interviewer_breaks):
                            continue

                        local_start = start.astimezone(zone).replace(tzinfo=None)
                        if local_start.minute % START_INCREMENT_MINUTES != 0:
                            continue

                        choices.append(
                            {
                                "candidate_id": candidate.candidate_id,
                                "round_id": round_item.round_id,
                                "round_order": round_item.order,
                                "interviewer_id": interviewer.interviewer_id,
                                "start": start,
                                "end": end,
                            }
                        )

            unique_choices = {
                (
                    choice["interviewer_id"],
                    choice["start"],
                ): choice
                for choice in choices
            }
            assignments.append((candidate.candidate_id, round_item, list(unique_choices.values())))

    return assignments


def _has_conflict(
    left: dict,
    right: dict,
    request: SchedulingRequest,
) -> bool:
    if left["candidate_id"] == right["candidate_id"]:
        if left["round_order"] < right["round_order"]:
            if left["end"] + timedelta(minutes=request.buffer_minutes.candidate) > right["start"]:
                return True
        elif right["round_order"] < left["round_order"]:
            if right["end"] + timedelta(minutes=request.buffer_minutes.candidate) > left["start"]:
                return True
        else:
            return True

    if left["interviewer_id"] == right["interviewer_id"]:
        interviewer_buffer = timedelta(minutes=request.buffer_minutes.interviewer)
        if not (
            left["end"] + interviewer_buffer <= right["start"]
            or right["end"] + interviewer_buffer <= left["start"]
        ):
            return True

    return False


def _build_response(
    assignments,
    selected_choices: list[dict],
) -> SchedulingResponse:
    selected_keys = {
        (choice["candidate_id"], choice["round_id"])
        for choice in selected_choices
    }
    schedule = [
        ScheduledInterview(
            candidate_id=choice["candidate_id"],
            round_id=choice["round_id"],
            interviewer_id=choice["interviewer_id"],
            start_time=choice["start"],
            end_time=choice["end"],
        )
        for choice in sorted(
            selected_choices,
            key=lambda item: (item["start"], item["candidate_id"], item["round_order"]),
        )
    ]

    unscheduled = []
    for candidate_id, round_item, choices in assignments:
        if (candidate_id, round_item.round_id) in selected_keys:
            continue

        if choices:
            reason_code = "RESOURCE_CONFLICT"
            message = "No conflict-free assignment was selected for this interview."
        else:
            reason_code = "NO_COMPATIBLE_ASSIGNMENT"
            message = (
                "No qualified interviewer and valid time satisfy availability, "
                "working hours, and breaks."
            )

        unscheduled.append(
            UnscheduledInterview(
                candidate_id=candidate_id,
                round_id=round_item.round_id,
                reason_code=reason_code,
                message=message,
            )
        )

    if not schedule:
        status = ScheduleStatus.UNSCHEDULABLE
        message = "No required interviews could be scheduled."
    elif unscheduled:
        status = ScheduleStatus.PARTIAL
        message = "A partial schedule was generated."
    else:
        status = ScheduleStatus.SUCCESS
        message = "All required interviews were scheduled."

    return SchedulingResponse(
        status=status,
        message=message,
        schedule=schedule,
        unscheduled=unscheduled,
        errors=[],
    )


def generate_schedule(
    request: SchedulingRequest,
    *,
    time_limit_seconds: float | None = None,
) -> SchedulingResponse:
    """Generate a schedule maximizing the number of assigned candidate-round pairs."""
    if time_limit_seconds is not None and (
        isinstance(time_limit_seconds, bool)
        or not isinstance(time_limit_seconds, (int, float))
        or not math.isfinite(time_limit_seconds)
        or time_limit_seconds <= 0
    ):
        return SchedulingResponse(
            status=ScheduleStatus.ERROR,
            message="The solver time limit must be a positive finite number.",
            schedule=[],
            unscheduled=[],
            errors=[
                SchedulingError(
                    code="INVALID_TIME_LIMIT",
                    message="time_limit_seconds must be a positive finite number.",
                    path="time_limit_seconds",
                )
            ],
        )

    if not isinstance(request, SchedulingRequest):
        return SchedulingResponse(
            status=ScheduleStatus.ERROR,
            message="A validated scheduling request is required.",
            schedule=[],
            unscheduled=[],
            errors=[
                SchedulingError(
                    code="INVALID_REQUEST",
                    message="request must be a validated SchedulingRequest instance.",
                    path="request",
                )
            ],
        )

    try:
        assignments = _assignment_candidates(request)
    except InvalidLocalTimeError as error:
        return SchedulingResponse(
            status=ScheduleStatus.ERROR,
            message="A working-hour local time is ambiguous or nonexistent.",
            schedule=[],
            unscheduled=[],
            errors=[
                SchedulingError(
                    code="INVALID_LOCAL_TIME",
                    message=str(error),
                    path="workingHours",
                )
            ],
        )

    model = cp_model.CpModel()
    choice_records: list[tuple[cp_model.IntVar, dict]] = []

    for assignment_index, (candidate_id, round_item, choices) in enumerate(assignments):
        variables = []
        for choice_index, choice in enumerate(choices):
            variable = model.NewBoolVar(
                f"assign_{assignment_index}_{choice_index}"
            )
            variables.append(variable)
            choice_records.append((variable, choice))

        if variables:
            model.AddAtMostOne(variables)

    for (left_variable, left_choice), (right_variable, right_choice) in combinations(
        choice_records,
        2,
    ):
        if _has_conflict(left_choice, right_choice, request):
            model.Add(left_variable + right_variable <= 1)

    model.Maximize(sum(variable for variable, _ in choice_records))

    solver = cp_model.CpSolver()
    solver.parameters.num_search_workers = 1
    solver.parameters.random_seed = 0
    if time_limit_seconds is not None:
        solver.parameters.max_time_in_seconds = float(time_limit_seconds)

    try:
        status = solver.Solve(model)
    except Exception:
        return SchedulingResponse(
            status=ScheduleStatus.ERROR,
            message="The scheduling solver failed before producing a result.",
            schedule=[],
            unscheduled=[],
            errors=[
                SchedulingError(
                    code="SOLVER_FAILURE",
                    message="CP-SAT failed while solving the scheduling model.",
                )
            ],
        )

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return SchedulingResponse(
            status=ScheduleStatus.ERROR,
            message="The scheduling solver did not find a usable result.",
            schedule=[],
            unscheduled=[],
            errors=[
                SchedulingError(
                    code="SOLVER_NO_SOLUTION",
                    message="CP-SAT did not find a usable schedule.",
                )
            ],
        )

    selected = [
        choice
        for variable, choice in choice_records
        if solver.BooleanValue(variable)
    ]
    return _build_response(assignments, selected)
