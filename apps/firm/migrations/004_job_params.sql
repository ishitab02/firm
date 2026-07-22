-- params: the vendor-specific request body for this job.
--
-- Real marketplace vendors have real schemas - OKLink #2023 requires
-- chainIndex/address/height - and the payment is made BEFORE the vendor ever
-- validates the body. A worker that sends only {goal, subtask} therefore pays
-- for a 400. This is a money bug, not a correctness nit.
--
-- INTERFACES 1A already defines express_run as taking {job_type, params}, so
-- carrying them is within the frozen contract. The gateway parsed params and
-- then discarded them; this column is where they now land.
--
-- Buyer constraints are NOT here: they ride on the job's quote blob, which is
-- where the worker already reads them from. One source of truth.
--
-- Defaults to '{}', which reproduces the previous behaviour exactly for every
-- existing row.

ALTER TABLE firm_jobs
  ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}'::jsonb;
