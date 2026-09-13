-- WattWise Milestone 0.5.1: PostgreSQL Foundation Schema
-- Authoritative relational schema, constraints, indexes, triggers, and Row Level Security.

-- Required Extensions
CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- 1. Accounts (Global Identity)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- 2. Households (Tenant / Security Boundary)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS households (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Karachi',
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- 3. Household Memberships (Associative RBAC)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS household_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT uniq_household_account UNIQUE (household_id, account_id)
);

-- -----------------------------------------------------------------------------
-- 4. Connections (Utility Service / Reference Numbers)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('LESCO', 'GEPCO', 'FESCO', 'IESCO', 'MEPCO', 'K-Electric')),
  reference_number VARCHAR(32) NOT NULL,
  tariff_category TEXT NOT NULL CHECK (tariff_category IN ('domestic_protected', 'domestic_unprotected', 'commercial')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Composite unique key for composite foreign keys from children
  CONSTRAINT uniq_connection_tenant UNIQUE (id, household_id),
  CONSTRAINT uniq_household_provider_reference UNIQUE (household_id, provider, reference_number)
);

-- -----------------------------------------------------------------------------
-- 5. Meters (Physical Measurement Devices)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('outdoor_lesco_digital', 'indoor_cumulative_protector', 'manual_counter')),
  unit TEXT NOT NULL DEFAULT 'kWh' CHECK (unit = 'kWh'),
  serial_number TEXT,
  is_indoor_reset_supported BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  installed_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Tenant-aware composite foreign key to connection
  CONSTRAINT fk_meter_connection_tenant FOREIGN KEY (connection_id, household_id)
    REFERENCES connections(id, household_id) ON DELETE RESTRICT,
  -- Composite unique keys for child references
  CONSTRAINT uniq_meter_tenant UNIQUE (id, household_id),
  CONSTRAINT uniq_meter_connection_tenant UNIQUE (id, connection_id, household_id)
);

-- -----------------------------------------------------------------------------
-- 6. Billing Cycles (Accounting Period of a Connection, NOT a Meter)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  billing_period_start DATE NOT NULL,
  billing_period_end DATE, -- Nullable for an open cycle
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'closed', 'locked')),
  sync_outdoor_reading NUMERIC(10,2),
  sync_reading_timestamp TIMESTAMPTZ,
  gap_units NUMERIC(10,2),
  notes TEXT,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Tenant-aware composite foreign key to connection
  CONSTRAINT fk_cycle_connection_tenant FOREIGN KEY (connection_id, household_id)
    REFERENCES connections(id, household_id) ON DELETE RESTRICT,
  -- Composite unique keys
  CONSTRAINT uniq_cycle_tenant UNIQUE (id, household_id),
  CONSTRAINT uniq_cycle_connection_tenant UNIQUE (id, connection_id, household_id),
  -- Period constraint: end_date may be NULL or start_date <= end_date
  CONSTRAINT chk_cycle_period_dates CHECK (billing_period_end IS NULL OR billing_period_start <= billing_period_end),
  -- Finalized cycle must have an end date
  CONSTRAINT chk_closed_cycle_has_end_date CHECK (status NOT IN ('closed', 'locked') OR billing_period_end IS NOT NULL),
  -- Non-overlapping billing periods per Connection for cycles with defined end dates
  CONSTRAINT no_overlapping_cycles_per_connection EXCLUDE USING gist (
    connection_id WITH =,
    daterange(billing_period_start, billing_period_end, '[]') WITH &&
  ) WHERE (billing_period_end IS NOT NULL)
);

-- Exactly one active cycle per Connection
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_cycle_per_connection
  ON billing_cycles (connection_id)
  WHERE status = 'active';

-- -----------------------------------------------------------------------------
-- 7. Official Bills (Authoritative Utility Invoices, One-way FK to BillingCycle)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS official_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  billing_cycle_id UUID NOT NULL,
  bill_reference TEXT NOT NULL,
  billing_period_start DATE NOT NULL,
  billing_period_end DATE NOT NULL,
  issued_on DATE NOT NULL,
  due_on DATE,
  previous_reading NUMERIC(10,2) NOT NULL,
  current_reading NUMERIC(10,2) NOT NULL,
  billed_units NUMERIC(10,2) NOT NULL,
  billed_amount NUMERIC(12,2) NOT NULL,
  tariff_rate_per_unit NUMERIC(8,4) NOT NULL DEFAULT 0,
  electricity_duty NUMERIC(10,2) NOT NULL DEFAULT 0,
  tv_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  fca NUMERIC(10,2) NOT NULL DEFAULT 0,
  gst NUMERIC(10,2) NOT NULL DEFAULT 0,
  fpa NUMERIC(10,2) NOT NULL DEFAULT 0,
  other_charges NUMERIC(10,2) NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('user_entered', 'provider_import', 'ocr_proposed')),
  extraction_state TEXT NOT NULL CHECK (extraction_state IN ('not_applicable', 'proposed', 'verified', 'rejected')),
  confirmed_by_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  confirmed_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  revision_status TEXT NOT NULL DEFAULT 'active' CHECK (revision_status IN ('active', 'finalized', 'superseded')),
  revision_number INT NOT NULL DEFAULT 1,
  superseded_by_bill_id UUID REFERENCES official_bills(id) ON DELETE SET NULL,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Tenant-aware composite foreign key to cycle
  CONSTRAINT fk_bill_cycle_tenant FOREIGN KEY (billing_cycle_id, connection_id, household_id)
    REFERENCES billing_cycles(id, connection_id, household_id) ON DELETE RESTRICT,
  CONSTRAINT uniq_bill_tenant UNIQUE (id, household_id),
  CONSTRAINT chk_bill_reading_monotonicity CHECK (current_reading >= previous_reading),
  CONSTRAINT chk_bill_units_positive CHECK (billed_units >= 0),
  CONSTRAINT chk_bill_amount_positive CHECK (billed_amount >= 0)
);

-- -----------------------------------------------------------------------------
-- 8. Meter Lifecycle Events (Discontinuity Authorizations)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meter_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  meter_id UUID NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('installed', 'replaced', 'reset', 'rollover')),
  occurred_at TIMESTAMPTZ NOT NULL,
  previous_meter_id UUID REFERENCES meters(id) ON DELETE SET NULL,
  baseline_reading NUMERIC(10,2),
  reason TEXT,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Tenant-aware composite foreign key to meter
  CONSTRAINT fk_lifecycle_meter_tenant FOREIGN KEY (meter_id, connection_id, household_id)
    REFERENCES meters(id, connection_id, household_id) ON DELETE RESTRICT,
  CONSTRAINT uniq_lifecycle_tenant UNIQUE (id, household_id),
  CONSTRAINT chk_baseline_non_negative CHECK (baseline_reading IS NULL OR baseline_reading >= 0)
);

-- -----------------------------------------------------------------------------
-- 9. Meter Readings (Telemetry Stream)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meter_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  meter_id UUID NOT NULL,
  cycle_id UUID NOT NULL,
  cumulative_kwh NUMERIC(10,2) NOT NULL,
  reading_timestamp TIMESTAMPTZ NOT NULL,
  server_timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source TEXT NOT NULL CHECK (source IN ('indoor_meter', 'outdoor_meter', 'manual')),
  is_baseline BOOLEAN NOT NULL DEFAULT FALSE,
  lifecycle_event_id UUID,
  notes TEXT,
  validation_status TEXT NOT NULL DEFAULT 'valid' CHECK (validation_status IN ('valid', 'warning', 'error')),
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Composite tenant-aware foreign keys
  CONSTRAINT fk_reading_meter_tenant FOREIGN KEY (meter_id, connection_id, household_id)
    REFERENCES meters(id, connection_id, household_id) ON DELETE RESTRICT,
  CONSTRAINT fk_reading_cycle_tenant FOREIGN KEY (cycle_id, connection_id, household_id)
    REFERENCES billing_cycles(id, connection_id, household_id) ON DELETE RESTRICT,
  CONSTRAINT fk_reading_lifecycle_tenant FOREIGN KEY (lifecycle_event_id, household_id)
    REFERENCES meter_lifecycle_events(id, household_id) ON DELETE RESTRICT,
  -- Strict uniqueness: only one reading per meter at a physical instant
  CONSTRAINT uniq_meter_reading_timestamp UNIQUE (meter_id, reading_timestamp),
  -- Non-negative cumulative kWh
  CONSTRAINT chk_cumulative_kwh_positive CHECK (cumulative_kwh >= 0),
  -- Baseline readings must have matching lifecycle event
  CONSTRAINT chk_reading_baseline_lifecycle CHECK (
    (is_baseline = FALSE AND lifecycle_event_id IS NULL) OR
    (is_baseline = TRUE AND lifecycle_event_id IS NOT NULL)
  ),
  -- Static row check constraint with 5 minute skew allowance against immutable server_timestamp
  CONSTRAINT chk_reading_not_future_static CHECK (
    reading_timestamp <= server_timestamp + INTERVAL '5 minutes'
  )
);

-- -----------------------------------------------------------------------------
-- 10. Idempotency Keys (API / Command Deduplication)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  request_path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
  response_code INT,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours'),
  PRIMARY KEY (account_id, key)
);

-- -----------------------------------------------------------------------------
-- 11. Audit Logs (Server-Authoritative, Append-Only)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  actor_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('create', 'edit', 'correction', 'lock', 'finalize', 'delete')),
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  entity_version INT,
  before_state JSONB,
  after_state JSONB,
  reason TEXT,
  correlation_id TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- Database Triggers for Dynamic Invariants
-- -----------------------------------------------------------------------------

-- Trigger A: Enforce no future reading timestamp against volatile wall clock
CREATE OR REPLACE FUNCTION trg_prevent_future_reading()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.reading_timestamp > CLOCK_TIMESTAMP() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'reading_timestamp cannot be in the future (exceeds 5-minute skew window)'
      USING ERRCODE = '23514'; -- check_violation
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS check_reading_timestamp_not_future ON meter_readings;
CREATE TRIGGER check_reading_timestamp_not_future
BEFORE INSERT OR UPDATE OF reading_timestamp ON meter_readings
FOR EACH ROW EXECUTE FUNCTION trg_prevent_future_reading();

-- Trigger B: Protect closed/locked billing cycles
CREATE OR REPLACE FUNCTION trg_protect_closed_cycles()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('closed', 'locked') THEN
      RAISE EXCEPTION 'Cannot modify finalized or locked billing cycle %', OLD.id
        USING ERRCODE = '23506'; -- integrity_constraint_violation
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('closed', 'locked') THEN
      RAISE EXCEPTION 'Cannot delete finalized or locked billing cycle %', OLD.id
        USING ERRCODE = '23506';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS protect_closed_cycles_trigger ON billing_cycles;
CREATE TRIGGER protect_closed_cycles_trigger
BEFORE UPDATE OR DELETE ON billing_cycles
FOR EACH ROW EXECUTE FUNCTION trg_protect_closed_cycles();

-- Trigger B2: Protect closed/locked billing cycle readings (INSERT, UPDATE, DELETE)
CREATE OR REPLACE FUNCTION trg_protect_closed_cycle_readings()
RETURNS TRIGGER AS $$
DECLARE
  target_cycle_status TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO target_cycle_status FROM billing_cycles WHERE id = NEW.cycle_id;
    IF target_cycle_status IN ('closed', 'locked') THEN
      RAISE EXCEPTION 'Cannot insert reading into finalized or locked billing cycle %', NEW.cycle_id
        USING ERRCODE = '23506';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT status INTO target_cycle_status FROM billing_cycles WHERE id = OLD.cycle_id;
    IF target_cycle_status IN ('closed', 'locked') THEN
      RAISE EXCEPTION 'Cannot modify reading belonging to finalized cycle %', OLD.cycle_id
        USING ERRCODE = '23506';
    END IF;
    IF NEW.cycle_id <> OLD.cycle_id THEN
      SELECT status INTO target_cycle_status FROM billing_cycles WHERE id = NEW.cycle_id;
      IF target_cycle_status IN ('closed', 'locked') THEN
        RAISE EXCEPTION 'Cannot move reading to finalized cycle %', NEW.cycle_id
          USING ERRCODE = '23506';
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT status INTO target_cycle_status FROM billing_cycles WHERE id = OLD.cycle_id;
    IF target_cycle_status IN ('closed', 'locked') THEN
      RAISE EXCEPTION 'Cannot delete reading belonging to finalized cycle %', OLD.cycle_id
        USING ERRCODE = '23506';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS protect_closed_cycle_readings_trigger ON meter_readings;
CREATE TRIGGER protect_closed_cycle_readings_trigger
BEFORE INSERT OR UPDATE OR DELETE ON meter_readings
FOR EACH ROW EXECUTE FUNCTION trg_protect_closed_cycle_readings();

-- Trigger C: Protect finalized official bills
CREATE OR REPLACE FUNCTION trg_protect_finalized_bills()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.revision_status = 'finalized' THEN
      RAISE EXCEPTION 'Cannot directly modify finalized official bill %. Use revision workflow.', OLD.id
        USING ERRCODE = '23506';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.revision_status = 'finalized' THEN
      RAISE EXCEPTION 'Cannot delete finalized official bill %. Use revision workflow.', OLD.id
        USING ERRCODE = '23506';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS protect_finalized_bills_trigger ON official_bills;
CREATE TRIGGER protect_finalized_bills_trigger
BEFORE UPDATE OR DELETE ON official_bills
FOR EACH ROW EXECUTE FUNCTION trg_protect_finalized_bills();

-- Append-Only enforcement trigger for audit_logs
CREATE OR REPLACE FUNCTION trg_prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit logs are append-only. UPDATE, DELETE, and TRUNCATE are prohibited.'
    USING ERRCODE = '23506';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION trg_prevent_audit_log_mutation();

-- -----------------------------------------------------------------------------
-- Row Level Security (RLS) Policies
-- -----------------------------------------------------------------------------

-- Helper function: get caller's active role for a household
-- MUST FAIL CLOSED: if app.current_account_id is missing, empty, or invalid, returns FALSE.
CREATE OR REPLACE FUNCTION is_tenant_authorized(lookup_household_id UUID, allowed_roles TEXT[])
RETURNS BOOLEAN AS $$
DECLARE
  current_account TEXT;
  current_household TEXT;
  user_role TEXT;
  account_uuid UUID;
  household_uuid UUID;
BEGIN
  current_account := current_setting('app.current_account_id', true);
  -- Fail closed: missing or empty account context denies all tenant access
  IF current_account IS NULL OR trim(current_account) = '' THEN
    RETURN FALSE;
  END IF;

  BEGIN
    account_uuid := current_account::UUID;
  EXCEPTION WHEN others THEN
    RETURN FALSE;
  END;

  -- If transaction-local household context is set, it must match the entity household
  current_household := current_setting('app.current_household_id', true);
  IF current_household IS NOT NULL AND trim(current_household) <> '' THEN
    BEGIN
      household_uuid := current_household::UUID;
      IF household_uuid <> lookup_household_id THEN
        RETURN FALSE;
      END IF;
    EXCEPTION WHEN others THEN
      RETURN FALSE;
    END;
  END IF;

  SELECT role INTO user_role
  FROM household_memberships
  WHERE household_id = lookup_household_id
    AND account_id = account_uuid
    AND revoked_at IS NULL;

  IF user_role IS NULL THEN
    RETURN FALSE;
  END IF;

  RETURN user_role = ANY(allowed_roles);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- Atomic helper for initial household creation with initial owner
CREATE OR REPLACE FUNCTION create_household_with_initial_owner(
  p_household_id UUID,
  p_name TEXT,
  p_timezone TEXT,
  p_owner_account_id UUID
) RETURNS void AS $$
DECLARE
  caller_account TEXT;
BEGIN
  -- Strict caller validation: ensure caller is authenticated and matches the requested owner
  caller_account := current_setting('app.current_account_id', true);
  IF caller_account IS NULL OR trim(caller_account) = '' THEN
    RAISE EXCEPTION 'Unauthorized: tenant account context required to create household';
  END IF;

  IF caller_account::UUID <> p_owner_account_id THEN
    RAISE EXCEPTION 'Unauthorized: cannot create household with mismatched owner context';
  END IF;

  INSERT INTO households (id, name, timezone, version)
  VALUES (p_household_id, p_name, p_timezone, 1);

  INSERT INTO household_memberships (id, household_id, account_id, role)
  VALUES (gen_random_uuid(), p_household_id, p_owner_account_id, 'owner');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Enable and Force RLS on all tenant-scoped tables
ALTER TABLE households ENABLE ROW LEVEL SECURITY;
ALTER TABLE households FORCE ROW LEVEL SECURITY;

ALTER TABLE household_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_memberships FORCE ROW LEVEL SECURITY;

ALTER TABLE connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE connections FORCE ROW LEVEL SECURITY;

ALTER TABLE meters ENABLE ROW LEVEL SECURITY;
ALTER TABLE meters FORCE ROW LEVEL SECURITY;

ALTER TABLE billing_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_cycles FORCE ROW LEVEL SECURITY;

ALTER TABLE official_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE official_bills FORCE ROW LEVEL SECURITY;

ALTER TABLE meter_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_lifecycle_events FORCE ROW LEVEL SECURITY;

ALTER TABLE meter_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_readings FORCE ROW LEVEL SECURITY;

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

-- Households Policies
DROP POLICY IF EXISTS households_select ON households;
CREATE POLICY households_select ON households FOR SELECT
  USING (is_tenant_authorized(id, ARRAY['owner', 'member', 'viewer']));

DROP POLICY IF EXISTS households_insert ON households;
CREATE POLICY households_insert ON households FOR INSERT
  WITH CHECK (
    NULLIF(current_setting('app.current_account_id', true), '') IS NOT NULL
  );

DROP POLICY IF EXISTS households_update ON households;
CREATE POLICY households_update ON households FOR UPDATE
  USING (is_tenant_authorized(id, ARRAY['owner']))
  WITH CHECK (is_tenant_authorized(id, ARRAY['owner']));

DROP POLICY IF EXISTS households_delete ON households;
CREATE POLICY households_delete ON households FOR DELETE
  USING (is_tenant_authorized(id, ARRAY['owner']));

-- Memberships Policies
-- Prevent privilege escalation: only existing household owners can add members
DROP POLICY IF EXISTS memberships_select ON household_memberships;
CREATE POLICY memberships_select ON household_memberships FOR SELECT
  USING (
    (
      NULLIF(current_setting('app.current_account_id', true), '') IS NOT NULL
      AND account_id = (
        CASE
          WHEN current_setting('app.current_account_id', true) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN current_setting('app.current_account_id', true)::UUID
          ELSE NULL
        END
      )
    )
    OR is_tenant_authorized(household_id, ARRAY['owner', 'member', 'viewer'])
  );

DROP POLICY IF EXISTS memberships_insert ON household_memberships;
CREATE POLICY memberships_insert ON household_memberships FOR INSERT
  WITH CHECK (
    is_tenant_authorized(household_id, ARRAY['owner'])
  );

DROP POLICY IF EXISTS memberships_modify ON household_memberships;
CREATE POLICY memberships_modify ON household_memberships FOR UPDATE
  USING (is_tenant_authorized(household_id, ARRAY['owner']))
  WITH CHECK (is_tenant_authorized(household_id, ARRAY['owner']));

DROP POLICY IF EXISTS memberships_delete ON household_memberships;
CREATE POLICY memberships_delete ON household_memberships FOR DELETE
  USING (is_tenant_authorized(household_id, ARRAY['owner']));

-- Connections Policies
DROP POLICY IF EXISTS connections_select ON connections;
CREATE POLICY connections_select ON connections FOR SELECT
  USING (is_tenant_authorized(household_id, ARRAY['owner', 'member', 'viewer']));

DROP POLICY IF EXISTS connections_insert ON connections;
CREATE POLICY connections_insert ON connections FOR INSERT
  WITH CHECK (is_tenant_authorized(household_id, ARRAY['owner', 'member']));

DROP POLICY IF EXISTS connections_modify ON connections;
CREATE POLICY connections_modify ON connections FOR UPDATE
  USING (is_tenant_authorized(household_id, ARRAY['owner', 'member']))
  WITH CHECK (is_tenant_authorized(household_id, ARRAY['owner', 'member']));

DROP POLICY IF EXISTS connections_delete ON connections;
CREATE POLICY connections_delete ON connections FOR DELETE
  USING (is_tenant_authorized(household_id, ARRAY['owner']));

-- Meters Policies
DROP POLICY IF EXISTS meters_select ON meters;
CREATE POLICY meters_select ON meters FOR SELECT
  USING (is_tenant_authorized(household_id, ARRAY['owner', 'member', 'viewer']));

DROP POLICY IF EXISTS meters_insert ON meters;
CREATE POLICY meters_insert ON meters FOR INSERT
  WITH CHECK (is_tenant_authorized(household_id, ARRAY['owner', 'member']));

DROP POLICY IF EXISTS meters_modify ON meters;
CREATE POLICY meters_modify ON meters FOR UPDATE
  USING (is_tenant_authorized(household_id, ARRAY['owner', 'member']))
  WITH CHECK (is_tenant_authorized(household_id, ARRAY['owner', 'member']));

DROP POLICY IF EXISTS meters_delete ON meters;
CREATE POLICY meters_delete ON meters FOR DELETE
  USING (is_tenant_authorized(household_id, ARRAY['owner']));

-- Billing Cycles Policies
DROP POLICY IF EXISTS cycles_select ON billing_cycles;
CREATE POLICY cycles_select ON billing_cycles FOR SELECT
  USING (is_tenant_authorized(household_id, ARRAY['owner', 'member', 'viewer']));

DROP POLICY IF EXISTS cycles_insert ON billing_cycles;
CREATE POLICY cycles_insert ON billing_cycles FOR INSERT
  WITH CHECK (is_tenant_authorized(household_id, ARRAY['owner', 'member']));

DROP POLICY IF EXISTS cycles_modify ON billing_cycles;
CREATE POLICY cycles_modify ON billing_cycles FOR UPDATE
  USING (is_tenant_authorized(household_id, ARRAY['owner', 'member']))
  WITH CHECK (is_tenant_authorized(household_id, ARRAY['owner', 'member']));

DROP POLICY IF EXISTS cycles_delete ON billing_cycles;
CREATE POLICY cycles_delete ON billing_cycles FOR DELETE
  USING (is_tenant_authorized(household_id, ARRAY['owner']));

-- Official Bills Policies
DROP POLICY IF EXISTS bills_select ON official_bills;
CREATE POLICY bills_select ON official_bills FOR SELECT
  USING (is_tenant_authorized(household_id, ARRAY['owner', 'member', 'viewer']));

DROP POLICY IF EXISTS bills_insert ON official_bills;
CREATE POLICY bills_insert ON official_bills FOR INSERT
  WITH CHECK (is_tenant_authorized(household_id, ARRAY['owner', 'member']));

DROP POLICY IF EXISTS bills_modify ON official_bills;
CREATE POLICY bills_modify ON official_bills FOR UPDATE
  USING (is_tenant_authorized(household_id, ARRAY['owner', 'member']))
  WITH CHECK (is_tenant_authorized(household_id, ARRAY['owner', 'member']));

DROP POLICY IF EXISTS bills_delete ON official_bills;
CREATE POLICY bills_delete ON official_bills FOR DELETE
  USING (is_tenant_authorized(household_id, ARRAY['owner']));

-- Lifecycle Events Policies
DROP POLICY IF EXISTS lifecycle_select ON meter_lifecycle_events;
CREATE POLICY lifecycle_select ON meter_lifecycle_events FOR SELECT
  USING (is_tenant_authorized(household_id, ARRAY['owner', 'member', 'viewer']));

DROP POLICY IF EXISTS lifecycle_insert ON meter_lifecycle_events;
CREATE POLICY lifecycle_insert ON meter_lifecycle_events FOR INSERT
  WITH CHECK (is_tenant_authorized(household_id, ARRAY['owner', 'member']));

DROP POLICY IF EXISTS lifecycle_modify ON meter_lifecycle_events;
CREATE POLICY lifecycle_modify ON meter_lifecycle_events FOR UPDATE
  USING (is_tenant_authorized(household_id, ARRAY['owner', 'member']))
  WITH CHECK (is_tenant_authorized(household_id, ARRAY['owner', 'member']));

DROP POLICY IF EXISTS lifecycle_delete ON meter_lifecycle_events;
CREATE POLICY lifecycle_delete ON meter_lifecycle_events FOR DELETE
  USING (is_tenant_authorized(household_id, ARRAY['owner']));

-- Meter Readings Policies
DROP POLICY IF EXISTS readings_select ON meter_readings;
CREATE POLICY readings_select ON meter_readings FOR SELECT
  USING (is_tenant_authorized(household_id, ARRAY['owner', 'member', 'viewer']));

DROP POLICY IF EXISTS readings_insert ON meter_readings;
CREATE POLICY readings_insert ON meter_readings FOR INSERT
  WITH CHECK (is_tenant_authorized(household_id, ARRAY['owner', 'member']));

DROP POLICY IF EXISTS readings_modify ON meter_readings;
CREATE POLICY readings_modify ON meter_readings FOR UPDATE
  USING (is_tenant_authorized(household_id, ARRAY['owner', 'member']))
  WITH CHECK (is_tenant_authorized(household_id, ARRAY['owner', 'member']));

DROP POLICY IF EXISTS readings_delete ON meter_readings;
CREATE POLICY readings_delete ON meter_readings FOR DELETE
  USING (is_tenant_authorized(household_id, ARRAY['owner', 'member']));

-- Audit Logs Policies
DROP POLICY IF EXISTS audit_select ON audit_logs;
CREATE POLICY audit_select ON audit_logs FOR SELECT
  USING (is_tenant_authorized(household_id, ARRAY['owner', 'member']));

DROP POLICY IF EXISTS audit_insert ON audit_logs;
CREATE POLICY audit_insert ON audit_logs FOR INSERT
  WITH CHECK (is_tenant_authorized(household_id, ARRAY['owner', 'member']));

-- -----------------------------------------------------------------------------
-- Permission Hardening for Application Role
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'wattwise_app') THEN
    GRANT USAGE ON SCHEMA public TO wattwise_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wattwise_app;
    -- Revoke destructive and mutation access on append-only audit_logs
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM wattwise_app;
  END IF;
END $$;
