BEGIN;

DO $rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM event_candidate_availability)
     OR EXISTS (SELECT 1 FROM event_candidates)
     OR EXISTS (SELECT 1 FROM event_rounds)
     OR EXISTS (SELECT 1 FROM event_working_hours)
     OR EXISTS (SELECT 1 FROM events) THEN
    RAISE EXCEPTION
      'Event scheduling tables contain data. Export or intentionally remove that data before rollback.';
  END IF;
END
$rollback$;

DROP TABLE event_candidate_availability;
DROP TABLE event_candidates;
DROP TABLE event_rounds;
DROP TABLE event_working_hours;
DROP TABLE events;
DROP FUNCTION validate_event_time_zone();

COMMIT;
