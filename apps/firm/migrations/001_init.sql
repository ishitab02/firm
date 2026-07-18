CREATE TABLE IF NOT EXISTS firm_jobs (
  task_id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  state TEXT NOT NULL,
  goal TEXT NOT NULL,
  quote JSONB NOT NULL,
  progress JSONB NOT NULL DEFAULT '[]'::jsonb,
  deliverable JSONB,
  provenance JSONB,
  refund JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS firm_job_checkpoints (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES firm_jobs(task_id),
  state TEXT NOT NULL,
  subtask_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vendor_performance (
  agent_id TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  validation_failures INTEGER NOT NULL DEFAULT 0,
  timeouts INTEGER NOT NULL DEFAULT 0,
  last_failure_at TIMESTAMPTZ,
  adjustment INTEGER NOT NULL DEFAULT 0 CHECK (adjustment >= -30 AND adjustment <= 10)
);

CREATE INDEX IF NOT EXISTS firm_job_checkpoints_task_id_idx
  ON firm_job_checkpoints(task_id);
