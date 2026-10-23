import unittest

from pydantic import ValidationError

from app.schemas.scheduling import SchedulingRequest, SchedulingResponse


def valid_request() -> dict:
    return {
        "eventId": "event-2026-01",
        "timeZone": "Asia/Kolkata",
        "dateRange": {
            "startDate": "2026-11-01",
            "endDate": "2026-11-02",
        },
        "workingHours": [
            {
                "dayOfWeek": "SUNDAY",
                "startTime": "09:00",
                "endTime": "17:00",
            }
        ],
        "bufferMinutes": {
            "candidate": 10,
            "interviewer": 15,
        },
        "rounds": [
            {
                "roundId": "technical",
                "order": 1,
                "durationMinutes": 30,
                "requiredSkills": [" Node.js ", "NODE.JS"],
            },
            {
                "roundId": "managerial",
                "order": 2,
                "durationMinutes": 45,
                "requiredSkills": ["communication"],
            },
        ],
        "candidates": [
            {
                "candidateId": "candidate-42",
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
                "interviewerId": "interviewer-7",
                "skills": [" Node.js ", "POSTGRESQL"],
                "availabilityIntervals": [
                    {
                        "startTime": "2026-11-01T09:00:00+05:30",
                        "endTime": "2026-11-01T17:00:00+05:30",
                    }
                ],
                "breaks": [],
            }
        ],
    }


def valid_response() -> dict:
    return {
        "status": "partial",
        "message": "Some interviews could not be scheduled.",
        "schedule": [
            {
                "candidateId": "candidate-42",
                "roundId": "technical",
                "interviewerId": "interviewer-7",
                "startTime": "2026-11-01T09:00:00+05:30",
                "endTime": "2026-11-01T09:30:00+05:30",
            }
        ],
        "unscheduled": [
            {
                "candidateId": "candidate-42",
                "roundId": "managerial",
                "reasonCode": "NO_AVAILABLE_INTERVIEWER",
                "message": "No suitable interviewer is available.",
            }
        ],
        "errors": [],
    }


class SchedulingRequestTests(unittest.TestCase):
    def test_valid_request_accepts_camel_case_and_normalizes_skills(self) -> None:
        request = SchedulingRequest.model_validate(valid_request())

        self.assertEqual(request.event_id, "event-2026-01")
        self.assertEqual(request.rounds[0].required_skills, ["node.js"])
        self.assertEqual(request.interviewers[0].skills, ["node.js", "postgresql"])

        serialized = request.model_dump(by_alias=True)
        self.assertIn("timeZone", serialized)
        self.assertIn("availabilityIntervals", serialized["candidates"][0])

    def test_event_id_must_not_be_empty(self) -> None:
        data = valid_request()
        data["eventId"] = "  "
        self.assert_invalid(data, "eventId")

    def test_timezone_must_be_a_valid_iana_name(self) -> None:
        data = valid_request()
        data["timeZone"] = "Not/A_Zone"
        self.assert_invalid(data, "timeZone")

    def test_date_range_is_inclusive_and_end_cannot_precede_start(self) -> None:
        data = valid_request()
        data["dateRange"] = {
            "startDate": "2026-11-02",
            "endDate": "2026-11-01",
        }
        self.assert_invalid(data, "endDate")

    def test_single_day_inclusive_date_range_is_valid(self) -> None:
        data = valid_request()
        data["dateRange"] = {
            "startDate": "2026-11-01",
            "endDate": "2026-11-01",
        }
        request = SchedulingRequest.model_validate(data)
        self.assertEqual(request.date_range.start_date, request.date_range.end_date)

    def test_availability_must_fit_within_inclusive_event_date_range(self) -> None:
        data = valid_request()
        data["candidates"][0]["availabilityIntervals"][0]["endTime"] = (
            "2026-11-03T00:00:01+05:30"
        )
        self.assert_invalid(data, "inclusive event date range")

    def test_round_duration_must_be_positive(self) -> None:
        data = valid_request()
        data["rounds"][0]["durationMinutes"] = 0
        self.assert_invalid(data, "durationMinutes")

    def test_round_ids_must_be_unique(self) -> None:
        data = valid_request()
        data["rounds"][1]["roundId"] = data["rounds"][0]["roundId"]
        self.assert_invalid(data, "roundId values must be unique")

    def test_round_orders_must_be_unique(self) -> None:
        data = valid_request()
        data["rounds"][1]["order"] = data["rounds"][0]["order"]
        self.assert_invalid(data, "Round order values must be unique")

    def test_buffer_settings_must_be_nonnegative_integers(self) -> None:
        for value in (-1, 1.5, True):
            with self.subTest(value=value):
                data = valid_request()
                data["bufferMinutes"]["candidate"] = value
                self.assert_invalid(data, "candidate")

    def test_timestamps_require_explicit_timezone_offsets(self) -> None:
        data = valid_request()
        data["candidates"][0]["availabilityIntervals"][0][
            "startTime"
        ] = "2026-11-01T09:00:00"
        self.assert_invalid(data, "timezone offset")

    def test_interval_end_must_be_later_than_start_as_an_instant(self) -> None:
        data = valid_request()
        interval = data["candidates"][0]["availabilityIntervals"][0]
        interval["startTime"] = "2026-11-01T09:00:00+05:30"
        interval["endTime"] = "2026-11-01T03:30:00Z"
        self.assert_invalid(data, "endTime must be later")

    def test_availability_interval_list_must_not_be_empty(self) -> None:
        data = valid_request()
        data["candidates"][0]["availabilityIntervals"] = []
        self.assert_invalid(data, "availabilityIntervals")

    def test_working_hours_end_must_be_later(self) -> None:
        data = valid_request()
        data["workingHours"][0]["endTime"] = "09:00"
        self.assert_invalid(data, "endTime must be later")

    def test_unknown_fields_are_rejected(self) -> None:
        data = valid_request()
        data["candidateId"] = "untrusted"
        self.assert_invalid(data, "candidateId")

    def assert_invalid(self, data: dict, message_fragment: str) -> None:
        with self.assertRaises(ValidationError) as context:
            SchedulingRequest.model_validate(data)
        self.assertIn(message_fragment.lower(), str(context.exception).lower())


class SchedulingResponseTests(unittest.TestCase):
    def test_valid_partial_response(self) -> None:
        response = SchedulingResponse.model_validate(valid_response())

        self.assertEqual(response.status.value, "partial")
        self.assertEqual(len(response.schedule), 1)
        self.assertEqual(len(response.unscheduled), 1)

    def test_invalid_response_status_is_rejected(self) -> None:
        data = valid_response()
        data["status"] = "almost-success"
        with self.assertRaises(ValidationError):
            SchedulingResponse.model_validate(data)

    def test_response_timestamps_require_offsets_and_valid_interval(self) -> None:
        data = valid_response()
        data["schedule"][0]["startTime"] = "2026-11-01T09:00:00"
        with self.assertRaises(ValidationError):
            SchedulingResponse.model_validate(data)

    def test_errors_have_structured_fields(self) -> None:
        data = valid_response()
        data["errors"] = [
            {
                "code": "INVALID_INTERVAL",
                "path": "candidates[0].availabilityIntervals[0]",
                "message": "The interval end must be later than its start.",
            }
        ]

        response = SchedulingResponse.model_validate(data)
        dumped = response.model_dump(by_alias=True)
        self.assertEqual(dumped["errors"][0]["code"], "INVALID_INTERVAL")
        self.assertEqual(
            dumped["errors"][0]["path"],
            "candidates[0].availabilityIntervals[0]",
        )


if __name__ == "__main__":
    unittest.main()
