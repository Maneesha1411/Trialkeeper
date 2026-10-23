from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.schemas.scheduling import (
    ScheduleStatus,
    SchedulingError,
    SchedulingRequest,
    SchedulingResponse,
)
from app.services.scheduling_solver import generate_schedule


app = FastAPI(title="TrialKeeper Scheduling Solver")


@app.exception_handler(RequestValidationError)
async def handle_request_validation_error(
    request: Request,
    exception: RequestValidationError,
) -> JSONResponse:
    errors = [
        SchedulingError(
            code="INVALID_REQUEST",
            path=".".join(str(part) for part in error["loc"] if part != "body"),
            message=error["msg"],
        )
        for error in exception.errors()
    ]
    response = SchedulingResponse(
        status=ScheduleStatus.ERROR,
        message="Request validation failed.",
        schedule=[],
        unscheduled=[],
        errors=errors,
    )
    return JSONResponse(
        status_code=422,
        content=response.model_dump(by_alias=True, mode="json"),
    )


@app.post(
    "/api/schedules/generate",
    response_model=SchedulingResponse,
)
def generate_schedule_endpoint(
    request: SchedulingRequest,
) -> SchedulingResponse | JSONResponse:
    try:
        response = generate_schedule(request)
    except Exception:
        error_response = SchedulingResponse(
            status=ScheduleStatus.ERROR,
            message="The scheduling service could not generate a schedule.",
            schedule=[],
            unscheduled=[],
            errors=[
                SchedulingError(
                    code="SOLVER_FAILURE",
                    message="The scheduling solver failed unexpectedly.",
                )
            ],
        )
        return JSONResponse(
            status_code=500,
            content=error_response.model_dump(by_alias=True, mode="json"),
        )

    if response.status == ScheduleStatus.ERROR:
        return JSONResponse(
            status_code=500,
            content=response.model_dump(by_alias=True, mode="json"),
        )

    return response
