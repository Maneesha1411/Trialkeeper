import unittest
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from app.schemas.scheduling import SchedulingRequest, ScheduleStatus
from app.services.scheduling_solver import generate_schedule


EVENT_DATE = "2026-11-01"
OFFSET = "+05:30"


def timestamp(hour: int, minute: int = 0) -> str:
    return f"{EVENT_DATE}T{hour:02d}:{minute:02d}:00{OFFSET}"


def interval(start_hour: int, start_minute: int, end_hour: int, end_minute: int) -> dict:
    return {
        "startTime": timestamp(start_hour, start_minute),
        "endTime": timestamp(end_hour, end_minute),
    }


def round_input(round_id: str, order: int, skills: list[str] | None = None) -> dict:
    return {
        "roundId": round_id,
        "order": order,
        "durationMinutes": 30,
        "requiredSkills": skills or ["node.js"],
    }


def candidate_input(
    candidate_id: str,
    availability: list[dict] | None = None,
    breaks: list[dict] | None = None,
) -> dict:
    return {
        "candidateId": candidate_id,
        "availabilityIntervals": availability or [interval(9, 0, 12, 0)],
        "breaks": breaks or [],
    }


def interviewer_input(
    interviewer_id: str,
    skills: list[str] | None = None,
    availability: list[dict] | None = None,
    breaks: list[dict] | None = None,
) -> dict:
    return {
        "interviewerId": interviewer_id,
        "skills": skills or ["Node.js"],
        "availabilityIntervals": availability or [interval(9, 0, 12, 0)],
        "breaks": breaks or [],
    }


def scheduling_request(
    *,
    rounds: list[dict],
    candidates: list[dict],
    interviewers: list[dict],
    working_start: str = "09:00",
    working_end: str = "12:00",
    candidate_buffer: int = 0,
    interviewer_buffer: int = 0,
) -> SchedulingRequest:
    return SchedulingRequest.model_validate(
        {
            "eventId": "event-one",
            "timeZone": "Asia/Kolkata",
            "dateRange": {
                "startDate": EVENT_DATE,
                "endDate": EVENT_DATE,
            },
            "workingHours": [
                {
                    "dayOfWeek": "SUNDAY",
                    "startTime": working_start,
                    "endTime": working_end,
                }
            ],
            "bufferMinutes": {
                "candidate": candidate_buffer,
                "interviewer": interviewer_buffer,
            },
            "rounds": rounds,
            "candidates": candidates,
            "interviewers": interviewers,
        }
    )


def assert_no_overlap(test_case: unittest.TestCase, first, second) -> None:
    first_start = first.start_time.astimezone(timezone.utc)
    first_end = first.end_time.astimezone(timezone.utc)
    second_start = second.start_time.astimezone(timezone.utc)
    second_end = second.end_time.astimezone(timezone.utc)
    test_case.assertTrue(first_end <= second_start or second_end <= first_start)


class SchedulingSolverTests(unittest.TestCase):
    def test_schedules_one_candidate_round_with_exact_duration(self) -> None:
        request = SchedulingRequest.model_validate(
            {
                "eventId": "event-one",
                "timeZone": "Asia/Kolkata",
                "dateRange": {
                    "startDate": "2026-11-01",
                    "endDate": "2026-11-01",
                },
                "workingHours": [
                    {
                        "dayOfWeek": "SUNDAY",
                        "startTime": "09:00",
                        "endTime": "12:00",
                    }
                ],
                "bufferMinutes": {
                    "candidate": 10,
                    "interviewer": 10,
                },
                "rounds": [
                    {
                        "roundId": "technical",
                        "order": 1,
                        "durationMinutes": 30,
                        "requiredSkills": [" Node.js "],
                    }
                ],
                "candidates": [
                    {
                        "candidateId": "candidate-1",
                        "availabilityIntervals": [
                            {
                                "startTime": "2026-11-01T09:00:00+05:30",
                                "endTime": "2026-11-01T12:00:00+05:30",
                            }
                        ],
                        "breaks": [],
                    }
                ],
                "interviewers": [
                    {
                        "interviewerId": "interviewer-1",
                        "skills": ["node.js"],
                        "availabilityIntervals": [
                            {
                                "startTime": "2026-11-01T09:00:00+05:30",
                                "endTime": "2026-11-01T12:00:00+05:30",
                            }
                        ],
                        "breaks": [],
                    }
                ],
            }
        )

        response = generate_schedule(request)

        self.assertEqual(response.status, ScheduleStatus.SUCCESS)
        self.assertEqual(len(response.schedule), 1)
        self.assertEqual(response.unscheduled, [])

        interview = response.schedule[0]
        self.assertEqual(interview.candidate_id, "candidate-1")
        self.assertEqual(interview.round_id, "technical")
        self.assertEqual(interview.interviewer_id, "interviewer-1")
        self.assertEqual(interview.end_time - interview.start_time, timedelta(minutes=30))
        self.assertIsNotNone(interview.start_time.tzinfo)
        self.assertIsNotNone(interview.end_time.tzinfo)
        self.assertEqual(interview.start_time.utcoffset(), timezone.utc.utcoffset(None))

    def test_interviewer_without_required_skill_is_not_assigned(self) -> None:
        request = scheduling_request(
            rounds=[round_input("technical", 1, ["python"])],
            candidates=[candidate_input("candidate-1")],
            interviewers=[
                interviewer_input("interviewer-1", ["node.js"]),
            ],
        )

        response = generate_schedule(request)

        self.assertEqual(response.status, ScheduleStatus.UNSCHEDULABLE)
        self.assertEqual(response.schedule, [])
        self.assertEqual(len(response.unscheduled), 1)
        self.assertEqual(response.unscheduled[0].candidate_id, "candidate-1")
        self.assertEqual(response.unscheduled[0].round_id, "technical")
        self.assertNotIn(
            "interviewer-1",
            [interview.interviewer_id for interview in response.schedule],
        )

    def test_candidate_rounds_do_not_overlap(self) -> None:
        request = scheduling_request(
            rounds=[
                round_input("technical", 1),
                round_input("behavioral", 2),
            ],
            candidates=[candidate_input("candidate-1")],
            interviewers=[
                interviewer_input("interviewer-1"),
                interviewer_input("interviewer-2"),
            ],
            working_end="10:00",
        )

        response = generate_schedule(request)

        self.assertEqual(response.status, ScheduleStatus.SUCCESS)
        self.assertEqual(len(response.schedule), 2)
        assert_no_overlap(self, response.schedule[0], response.schedule[1])

    def test_interviewer_is_not_assigned_overlapping_interviews(self) -> None:
        request = scheduling_request(
            rounds=[round_input("technical", 1)],
            candidates=[
                candidate_input("candidate-1"),
                candidate_input("candidate-2"),
            ],
            interviewers=[interviewer_input("interviewer-1")],
            working_end="10:00",
        )

        response = generate_schedule(request)

        self.assertEqual(response.status, ScheduleStatus.SUCCESS)
        self.assertEqual(len(response.schedule), 2)
        self.assertTrue(
            all(item.interviewer_id == "interviewer-1" for item in response.schedule)
        )
        assert_no_overlap(self, response.schedule[0], response.schedule[1])

    def test_candidate_buffer_is_respected_between_rounds(self) -> None:
        request = scheduling_request(
            rounds=[
                round_input("technical", 1),
                round_input("behavioral", 2),
            ],
            candidates=[candidate_input("candidate-1")],
            interviewers=[
                interviewer_input("interviewer-1"),
                interviewer_input("interviewer-2"),
            ],
            working_end="10:10",
            candidate_buffer=10,
        )

        response = generate_schedule(request)

        self.assertEqual(response.status, ScheduleStatus.SUCCESS)
        by_round = {item.round_id: item for item in response.schedule}
        gap = by_round["behavioral"].start_time - by_round["technical"].end_time
        self.assertGreaterEqual(gap, timedelta(minutes=10))

    def test_interviewer_buffer_is_respected_between_interviews(self) -> None:
        request = scheduling_request(
            rounds=[round_input("technical", 1)],
            candidates=[
                candidate_input("candidate-1"),
                candidate_input("candidate-2"),
            ],
            interviewers=[interviewer_input("interviewer-1")],
            working_end="10:10",
            interviewer_buffer=10,
        )

        response = generate_schedule(request)

        self.assertEqual(response.status, ScheduleStatus.SUCCESS)
        self.assertEqual(len(response.schedule), 2)
        first, second = sorted(response.schedule, key=lambda item: item.start_time)
        self.assertEqual(first.interviewer_id, second.interviewer_id)
        self.assertGreaterEqual(
            second.start_time - first.end_time,
            timedelta(minutes=10),
        )

    def test_round_order_is_respected(self) -> None:
        request = scheduling_request(
            rounds=[
                round_input("first", 1),
                round_input("second", 2),
            ],
            candidates=[candidate_input("candidate-1")],
            interviewers=[
                interviewer_input("interviewer-1"),
                interviewer_input("interviewer-2"),
            ],
            working_end="10:00",
        )

        response = generate_schedule(request)

        self.assertEqual(response.status, ScheduleStatus.SUCCESS)
        by_round = {item.round_id: item for item in response.schedule}
        self.assertLessEqual(
            by_round["first"].end_time,
            by_round["second"].start_time,
        )

    def test_schedule_respects_breaks_and_working_hours(self) -> None:
        request = scheduling_request(
            rounds=[round_input("technical", 1)],
            candidates=[
                candidate_input(
                    "candidate-1",
                    breaks=[interval(10, 0, 10, 30)],
                )
            ],
            interviewers=[interviewer_input("interviewer-1")],
            working_start="10:00",
            working_end="11:00",
        )

        response = generate_schedule(request)

        self.assertEqual(response.status, ScheduleStatus.SUCCESS)
        self.assertEqual(len(response.schedule), 1)
        interview = response.schedule[0]
        event_zone = ZoneInfo("Asia/Kolkata")
        start_local = interview.start_time.astimezone(event_zone)
        end_local = interview.end_time.astimezone(event_zone)
        self.assertGreaterEqual(start_local.time().isoformat(), "10:00:00")
        self.assertLessEqual(end_local.time().isoformat(), "11:00:00")
        self.assertFalse(
            interview.start_time < datetime.fromisoformat(timestamp(10, 30))
            and interview.end_time > datetime.fromisoformat(timestamp(10, 0))
        )

    def test_partial_and_unschedulable_results_include_unscheduled_interviews(self) -> None:
        partial_request = scheduling_request(
            rounds=[round_input("technical", 1)],
            candidates=[
                candidate_input("candidate-1", [interval(9, 0, 9, 30)]),
                candidate_input("candidate-2", [interval(9, 0, 9, 30)]),
            ],
            interviewers=[
                interviewer_input("interviewer-1", availability=[interval(9, 0, 9, 30)])
            ],
            working_end="10:00",
        )
        partial_response = generate_schedule(partial_request)

        self.assertEqual(partial_response.status, ScheduleStatus.PARTIAL)
        self.assertEqual(len(partial_response.schedule), 1)
        self.assertEqual(len(partial_response.unscheduled), 1)
        self.assertEqual(
            partial_response.unscheduled[0].round_id,
            "technical",
        )
        self.assertIn(
            partial_response.unscheduled[0].candidate_id,
            {"candidate-1", "candidate-2"},
        )

        unschedulable_request = scheduling_request(
            rounds=[round_input("technical", 1)],
            candidates=[
                candidate_input("candidate-3", [interval(9, 0, 9, 20)]),
            ],
            interviewers=[
                interviewer_input("interviewer-2", availability=[interval(9, 0, 9, 20)])
            ],
            working_end="10:00",
        )
        unschedulable_response = generate_schedule(unschedulable_request)

        self.assertEqual(unschedulable_response.status, ScheduleStatus.UNSCHEDULABLE)
        self.assertEqual(unschedulable_response.schedule, [])
        self.assertEqual(len(unschedulable_response.unscheduled), 1)
        self.assertEqual(
            unschedulable_response.unscheduled[0].candidate_id,
            "candidate-3",
        )
        self.assertEqual(
            unschedulable_response.unscheduled[0].round_id,
            "technical",
        )


if __name__ == "__main__":
    unittest.main()
