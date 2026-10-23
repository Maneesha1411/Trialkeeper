import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.schemas.scheduling import ScheduleStatus, SchedulingResponse


def valid_request() -> dict:
    return {
        "eventId": "api-test-event",
        "timeZone": "Asia/Kolkata",
        "dateRange": {
            "startDate": "2026-11-01",
            "endDate": "2026-11-01",
        },
        "workingHours": [
            {
                "dayOfWeek": "SUNDAY",
                "startTime": "09:00",
                "endTime": "10:00",
            }
        ],
        "bufferMinutes": {
            "candidate": 0,
            "interviewer": 0,
        },
        "rounds": [
            {
                "roundId": "technical",
                "order": 1,
                "durationMinutes": 30,
                "requiredSkills": ["python"],
            }
        ],
        "candidates": [
            {
                "candidateId": "candidate-1",
                "availabilityIntervals": [
                    {
                        "startTime": "2026-11-01T09:00:00+05:30",
                        "endTime": "2026-11-01T10:00:00+05:30",
                    }
                ],
                "breaks": [],
            }
        ],
        "interviewers": [
            {
                "interviewerId": "interviewer-1",
                "skills": ["python"],
                "availabilityIntervals": [
                    {
                        "startTime": "2026-11-01T09:00:00+05:30",
                        "endTime": "2026-11-01T10:00:00+05:30",
                    }
                ],
                "breaks": [],
            }
        ],
    }


class SchedulingApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_valid_request_returns_existing_response_model(self) -> None:
        response = self.client.post(
            "/api/schedules/generate",
            json=valid_request(),
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "success")
        self.assertEqual(len(payload["schedule"]), 1)
        self.assertEqual(payload["schedule"][0]["candidateId"], "candidate-1")
        self.assertEqual(payload["schedule"][0]["roundId"], "technical")
        self.assertEqual(payload["schedule"][0]["interviewerId"], "interviewer-1")
        self.assertEqual(payload["unscheduled"], [])
        self.assertEqual(payload["errors"], [])

    def test_invalid_request_returns_structured_422_without_input_echo(self) -> None:
        invalid_body = valid_request()
        del invalid_body["eventId"]

        response = self.client.post(
            "/api/schedules/generate",
            json=invalid_body,
        )

        self.assertEqual(response.status_code, 422)
        payload = response.json()
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["message"], "Request validation failed.")
        self.assertEqual(payload["schedule"], [])
        self.assertEqual(payload["unscheduled"], [])
        self.assertTrue(payload["errors"])
        self.assertEqual(payload["errors"][0]["code"], "INVALID_REQUEST")
        self.assertNotIn("input", response.text.lower())

    def test_solver_exception_returns_generic_500_without_details(self) -> None:
        with patch(
            "app.main.generate_schedule",
            side_effect=RuntimeError("private internal failure detail"),
        ):
            response = self.client.post(
                "/api/schedules/generate",
                json=valid_request(),
            )

        self.assertEqual(response.status_code, 500)
        payload = response.json()
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["errors"][0]["code"], "SOLVER_FAILURE")
        self.assertNotIn("private internal failure detail", response.text)

    def test_solver_error_response_uses_http_500(self) -> None:
        solver_error = SchedulingResponse(
            status=ScheduleStatus.ERROR,
            message="The scheduling solver did not find a usable result.",
            schedule=[],
            unscheduled=[],
            errors=[
                {
                    "code": "SOLVER_NO_SOLUTION",
                    "message": "CP-SAT did not find a usable schedule.",
                }
            ],
        )

        with patch("app.main.generate_schedule", return_value=solver_error):
            response = self.client.post(
                "/api/schedules/generate",
                json=valid_request(),
            )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["status"], "error")


if __name__ == "__main__":
    unittest.main()
