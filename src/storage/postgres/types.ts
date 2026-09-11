/**
 * Authoritative PostgreSQL Database Entities for WattWise.
 * Milestone 0.5.1: PostgreSQL Foundation.
 */

export interface PostgresAccount {
  id: string;
  auth_user_id: string;
  email: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface PostgresHousehold {
  id: string;
  name: string;
  timezone: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export type HouseholdRole = 'owner' | 'member' | 'viewer';

export interface PostgresHouseholdMembership {
  id: string;
  household_id: string;
  account_id: string;
  role: HouseholdRole;
  created_at: string;
  revoked_at: string | null;
}

export type UtilityProvider = 'LESCO' | 'GEPCO' | 'FESCO' | 'IESCO' | 'MEPCO' | 'K-Electric';
export type TariffCategory = 'domestic_protected' | 'domestic_unprotected' | 'commercial';

export interface PostgresConnection {
  id: string;
  household_id: string;
  provider: UtilityProvider;
  reference_number: string;
  tariff_category: TariffCategory;
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export type MeterType = 'outdoor_lesco_digital' | 'indoor_cumulative_protector' | 'manual_counter';

export interface PostgresMeter {
  id: string;
  household_id: string;
  connection_id: string;
  name: string;
  type: MeterType;
  unit: string;
  serial_number: string | null;
  is_indoor_reset_supported: boolean;
  is_active: boolean;
  installed_at: string | null;
  retired_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export type BillingCycleStatus = 'draft' | 'active' | 'closed' | 'locked';

/**
 * Authoritative BillingCycle:
 * Scoped strictly to Connection, NOT Meter.
 * Uses DATE boundaries. Does NOT duplicate official bill facts.
 */
export interface PostgresBillingCycle {
  id: string;
  household_id: string;
  connection_id: string;
  billing_period_start: string; // ISO Date YYYY-MM-DD
  billing_period_end: string | null;   // ISO Date YYYY-MM-DD (nullable for open cycle)
  status: BillingCycleStatus;
  sync_outdoor_reading: number | null;
  sync_reading_timestamp: string | null;
  gap_units: number | null;
  notes: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export type BillSource = 'user_entered' | 'provider_import' | 'ocr_proposed';
export type ExtractionState = 'not_applicable' | 'proposed' | 'verified' | 'rejected';
export type BillRevisionStatus = 'active' | 'finalized' | 'superseded';

/**
 * Authoritative OfficialBill:
 * One-way reference to BillingCycle.
 * Exact numeric amounts and charges breakdown.
 */
export interface PostgresOfficialBill {
  id: string;
  household_id: string;
  connection_id: string;
  billing_cycle_id: string;
  bill_reference: string;
  billing_period_start: string;
  billing_period_end: string;
  issued_on: string;
  due_on: string | null;
  previous_reading: number;
  current_reading: number;
  billed_units: number;
  billed_amount: number;
  tariff_rate_per_unit: number;
  electricity_duty: number;
  tv_fee: number;
  fca: number;
  gst: number;
  fpa: number;
  other_charges: number;
  source: BillSource;
  extraction_state: ExtractionState;
  confirmed_by_account_id: string | null;
  confirmed_at: string | null;
  finalized_at: string | null;
  revision_status: BillRevisionStatus;
  revision_number: number;
  superseded_by_bill_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export type LifecycleEventType = 'installed' | 'replaced' | 'reset' | 'rollover';

export interface PostgresLifecycleEvent {
  id: string;
  household_id: string;
  connection_id: string;
  meter_id: string;
  type: LifecycleEventType;
  occurred_at: string;
  previous_meter_id: string | null;
  baseline_reading: number | null;
  reason: string | null;
  version: number;
  created_at: string;
}

export type ReadingSource = 'indoor_meter' | 'outdoor_meter' | 'manual';
export type ValidationStatus = 'valid' | 'warning' | 'error';

/**
 * Authoritative MeterReading:
 * Tied to Household, Connection, Meter, and BillingCycle.
 * Reading timestamp is validated user physical timestamp.
 * Server timestamp is authoritative entry time.
 */
export interface PostgresMeterReading {
  id: string;
  household_id: string;
  connection_id: string;
  meter_id: string;
  cycle_id: string;
  cumulative_kwh: number;
  reading_timestamp: string; // ISO TIMESTAMPTZ
  server_timestamp: string;  // ISO TIMESTAMPTZ (authoritative server default)
  source: ReadingSource;
  is_baseline: boolean;
  lifecycle_event_id: string | null;
  notes: string | null;
  validation_status: ValidationStatus;
  version: number;
  created_at: string;
}

export type IdempotencyStatus = 'in_progress' | 'completed' | 'failed';

export interface PostgresIdempotencyKey {
  account_id: string;
  key: string;
  request_path: string;
  request_hash: string;
  status: IdempotencyStatus;
  response_code: number | null;
  response_body: Record<string, unknown> | null;
  created_at: string;
  expires_at: string;
}

export type AuditAction = 'create' | 'edit' | 'correction' | 'lock' | 'finalize' | 'delete';

export interface PostgresAuditLog {
  id: string;
  household_id: string;
  actor_account_id: string;
  action: AuditAction;
  entity_type: string;
  entity_id: string;
  entity_version: number | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  reason: string | null;
  correlation_id: string | null;
  idempotency_key: string | null;
  created_at: string;
}
