from datetime import date, datetime, time, timedelta, timezone
from enum import Enum
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)


def to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


NonEmptyString = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
NonNegativeInt = Annotated[int, Field(strict=True, ge=0)]
PositiveInt = Annotated[int, Field(strict=True, gt=0)]


class SchemaModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class DayOfWeek(str, Enum):
    MONDAY = "MONDAY"
    TUESDAY = "TUESDAY"
    WEDNESDAY = "WEDNESDAY"
    THURSDAY = "THURSDAY"
    FRIDAY = "FRIDAY"
    SATURDAY = "SATURDAY"
    SUNDAY = "SUNDAY"


class EventDateRange(SchemaModel):
    start_date: date
    end_date: date

    @model_validator(mode="after")
    def validate_date_order(self) -> "EventDateRange":
        if self.end_date < self.start_date:
            raise ValueError("endDate must be on or after startDate.")
        return self


class LocalTimeInterval(SchemaModel):
    day_of_week: DayOfWeek
    start_time: time
    end_time: time

    @field_validator("start_time", "end_time")
    @classmethod
    def require_local_time(cls, value: time) -> time:
        if value.tzinfo is not None:
            raise ValueError("Working hours must use local times without a timezone.")
        return value

    @model_validator(mode="after")
    def validate_time_order(self) -> "LocalTimeInterval":
        if self.end_time <= self.start_time:
            raise ValueError("endTime must be later than startTime.")
        return self


class TimestampInterval(SchemaModel):
    start_time: datetime
    end_time: datetime

    @field_validator("start_time", "end_time")
    @classmethod
    def require_timezone_offset(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Timestamp must include a timezone offset.")
        return value

    @model_validator(mode="after")
    def validate_interval_order(self) -> "TimestampInterval":
        if self.end_time.astimezone(timezone.utc) <= self.start_time.astimezone(
            timezone.utc
        ):
            raise ValueError("endTime must be later than startTime.")
        return self


class InterviewRound(SchemaModel):
    round_id: NonEmptyString
    order: PositiveInt
    duration_minutes: PositiveInt
    required_skills: list[NonEmptyString] = Field(default_factory=list)

    @field_validator("required_skills")
    @classmethod
    def normalize_required_skills(cls, skills: list[str]) -> list[str]:
        return list(dict.fromkeys(skill.strip().casefold() for skill in skills))


class CandidateInput(SchemaModel):
    candidate_id: NonEmptyString
    availability_intervals: list[TimestampInterval] = Field(min_length=1)
    breaks: list[TimestampInterval] = Field(default_factory=list)


class InterviewerInput(SchemaModel):
    interviewer_id: NonEmptyString
    skills: list[NonEmptyString] = Field(default_factory=list)
    availability_intervals: list[TimestampInterval] = Field(min_length=1)
    breaks: list[TimestampInterval] = Field(default_factory=list)

    @field_validator("skills")
    @classmethod
    def normalize_skills(cls, skills: list[str]) -> list[str]:
        return list(dict.fromkeys(skill.strip().casefold() for skill in skills))


class BufferSettings(SchemaModel):
    candidate: NonNegativeInt
    interviewer: NonNegativeInt


class SchedulingRequest(SchemaModel):
    event_id: NonEmptyString
    time_zone: NonEmptyString
    date_range: EventDateRange
    working_hours: list[LocalTimeInterval] = Field(min_length=1)
    buffer_minutes: BufferSettings
    rounds: list[InterviewRound] = Field(min_length=1)
    candidates: list[CandidateInput] = Field(min_length=1)
    interviewers: list[InterviewerInput] = Field(min_length=1)

    @field_validator("time_zone")
    @classmethod
    def validate_time_zone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise ValueError("timeZone must be a valid IANA timezone name.") from error
        return value

    @model_validator(mode="after")
    def validate_unique_ids_and_round_orders(self) -> "SchedulingRequest":
        round_ids = [round_item.round_id for round_item in self.rounds]
        if len(round_ids) != len(set(round_ids)):
            raise ValueError("roundId values must be unique.")

        round_orders = [round_item.order for round_item in self.rounds]
        if len(round_orders) != len(set(round_orders)):
            raise ValueError("Round order values must be unique.")

        candidate_ids = [candidate.candidate_id for candidate in self.candidates]
        if len(candidate_ids) != len(set(candidate_ids)):
            raise ValueError("candidateId values must be unique.")

        interviewer_ids = [
            interviewer.interviewer_id for interviewer in self.interviewers
        ]
        if len(interviewer_ids) != len(set(interviewer_ids)):
            raise ValueError("interviewerId values must be unique.")

        event_zone = ZoneInfo(self.time_zone)
        range_start = datetime.combine(
            self.date_range.start_date,
            time.min,
            tzinfo=event_zone,
        ).astimezone(timezone.utc)
        range_end = datetime.combine(
            self.date_range.end_date + timedelta(days=1),
            time.min,
            tzinfo=event_zone,
        ).astimezone(timezone.utc)

        for person in [*self.candidates, *self.interviewers]:
            for interval in [*person.availability_intervals, *person.breaks]:
                interval_start = interval.start_time.astimezone(timezone.utc)
                interval_end = interval.end_time.astimezone(timezone.utc)
                if interval_start < range_start or interval_end > range_end:
                    raise ValueError(
                        "Availability intervals and breaks must fit within "
                        "the inclusive event date range."
                    )

        return self


class ScheduledInterview(SchemaModel):
    candidate_id: NonEmptyString
    round_id: NonEmptyString
    interviewer_id: NonEmptyString
    start_time: datetime
    end_time: datetime

    @field_validator("start_time", "end_time")
    @classmethod
    def require_timezone_offset(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Timestamp must include a timezone offset.")
        return value

    @model_validator(mode="after")
    def validate_interval_order(self) -> "ScheduledInterview":
        if self.end_time.astimezone(timezone.utc) <= self.start_time.astimezone(
            timezone.utc
        ):
            raise ValueError("endTime must be later than startTime.")
        return self


class UnscheduledInterview(SchemaModel):
    candidate_id: NonEmptyString
    round_id: NonEmptyString
    reason_code: NonEmptyString
    message: NonEmptyString


class SchedulingError(SchemaModel):
    code: NonEmptyString
    message: NonEmptyString
    path: str | None = None


class ScheduleStatus(str, Enum):
    SUCCESS = "success"
    PARTIAL = "partial"
    UNSCHEDULABLE = "unschedulable"
    ERROR = "error"


class SchedulingResponse(SchemaModel):
    status: ScheduleStatus
    message: NonEmptyString
    schedule: list[ScheduledInterview]
    unscheduled: list[UnscheduledInterview]
    errors: list[SchedulingError]
