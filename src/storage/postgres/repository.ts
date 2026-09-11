import { randomUUID, createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { getDbPool, withClient, withTransaction, withTenantContext } from './db';
import {
  PostgresAccount,
  PostgresHousehold,
  PostgresHouseholdMembership,
  PostgresConnection,
  PostgresMeter,
  PostgresBillingCycle,
  PostgresOfficialBill,
  PostgresMeterReading,
  PostgresLifecycleEvent,
  PostgresAuditLog,
  PostgresIdempotencyKey,
  HouseholdRole,
} from './types';

export class ConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyError';
  }
}

export class IntegrityViolationError extends Error {
  constructor(public code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'IntegrityViolationError';
  }
}

export function parseDateBoundary(val: string | Date, endOfDay = false): number {
  if (val instanceof Date) {
    const d = new Date(val.getTime());
    if (endOfDay) {
      d.setUTCHours(23, 59, 59, 999);
    } else {
      d.setUTCHours(0, 0, 0, 0);
    }
    return d.getTime();
  }
  const dateStr = typeof val === 'string' && val.includes('T') ? val.split('T')[0] : String(val);
  const iso = endOfDay ? `${dateStr}T23:59:59.999Z` : `${dateStr}T00:00:00.000Z`;
  return new Date(iso).getTime();
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export interface MutationContext {
  accountId: string;
  reason?: string;
  correlationId?: string;
  idempotencyKey?: string;
}

export class PostgresEnergyRepository {
  constructor(private pool: Pool = getDbPool()) {}

  // ---------------------------------------------------------------------------
  // Account & Household Operations
  // ---------------------------------------------------------------------------

  async createAccount(account: {
    authUserId: string;
    email?: string;
    displayName?: string;
  }): Promise<PostgresAccount> {
    return withClient(async (client) => {
      const res = await client.query<PostgresAccount>(
        `INSERT INTO accounts (auth_user_id, email, display_name)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [account.authUserId, account.email ?? null, account.displayName ?? null]
      );
      return res.rows[0];
    }, this.pool);
  }

  async getAccount(id: string): Promise<PostgresAccount | null> {
    return withClient(async (client) => {
      const res = await client.query<PostgresAccount>(
        'SELECT * FROM accounts WHERE id = $1',
        [id]
      );
      return res.rows[0] ?? null;
    }, this.pool);
  }

  async createHousehold(
    household: { name: string; timezone?: string },
    ownerAccountId: string
  ): Promise<{ household: PostgresHousehold; membership: PostgresHouseholdMembership }> {
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withTenantContext(client, ownerAccountId, async () => {
          const householdId = randomUUID();

          // Atomically create household and initial owner membership via secure function
          await client.query(
            'SELECT create_household_with_initial_owner($1, $2, $3, $4)',
            [householdId, household.name, household.timezone ?? 'Asia/Karachi', ownerAccountId]
          );

          const hhRes = await client.query<PostgresHousehold>(
            'SELECT * FROM households WHERE id = $1',
            [householdId]
          );
          const memRes = await client.query<PostgresHouseholdMembership>(
            'SELECT * FROM household_memberships WHERE household_id = $1 AND account_id = $2',
            [householdId, ownerAccountId]
          );

          const createdHousehold = hhRes.rows[0];

          await client.query(
            `INSERT INTO audit_logs (household_id, actor_account_id, action, entity_type, entity_id, entity_version, after_state)
             VALUES ($1, $2, 'create', 'household', $3, 1, $4)`,
            [
              createdHousehold.id,
              ownerAccountId,
              createdHousehold.id,
              JSON.stringify(createdHousehold),
            ]
          );

          return { household: createdHousehold, membership: memRes.rows[0] };
        });
      });
    }, this.pool);
  }

  async addMembership(
    householdId: string,
    targetAccountId: string,
    role: HouseholdRole,
    context: MutationContext
  ): Promise<PostgresHouseholdMembership> {
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withTenantContext(client, context.accountId, async () => {
          const membershipId = randomUUID();
          const res = await client.query<PostgresHouseholdMembership>(
            `INSERT INTO household_memberships (id, household_id, account_id, role)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [membershipId, householdId, targetAccountId, role]
          );
          const created = res.rows[0];
          await this.logAudit(client, {
            householdId,
            actorAccountId: context.accountId,
            action: 'create',
            entityType: 'household_membership',
            entityId: created.id,
            entityVersion: 1,
            afterState: created as unknown as Record<string, unknown>,
            reason: context.reason,
            correlationId: context.correlationId,
          });
          return created;
        }, householdId);
      });
    }, this.pool);
  }

  async updateHousehold(
    id: string,
    expectedVersion: number,
    updates: { name?: string; timezone?: string },
    context: MutationContext
  ): Promise<PostgresHousehold> {
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withTenantContext(client, context.accountId, async () => {
          const currentRes = await client.query<PostgresHousehold>(
            'SELECT * FROM households WHERE id = $1 FOR UPDATE',
            [id]
          );
          if (currentRes.rows.length === 0) {
            throw new IntegrityViolationError('not_found', `Household ${id} not found.`);
          }
          const before = currentRes.rows[0];

          const res = await client.query<PostgresHousehold>(
            `UPDATE households
             SET name = COALESCE($1, name),
                 timezone = COALESCE($2, timezone),
                 version = version + 1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $3 AND version = $4
             RETURNING *`,
            [updates.name ?? null, updates.timezone ?? null, id, expectedVersion]
          );

          if (res.rows.length === 0) {
            throw new ConcurrencyError(`Stale write: Household ${id} version mismatch.`);
          }

          const updated = res.rows[0];
          await this.logAudit(client, {
            householdId: id,
            actorAccountId: context.accountId,
            action: 'edit',
            entityType: 'household',
            entityId: id,
            entityVersion: updated.version,
            beforeState: before as unknown as Record<string, unknown>,
            afterState: updated as unknown as Record<string, unknown>,
            reason: context.reason,
            correlationId: context.correlationId,
            idempotencyKey: context.idempotencyKey,
          });

          return updated;
        }, id);
      });
    }, this.pool);
  }

  // ---------------------------------------------------------------------------
  // Connection Operations
  // ---------------------------------------------------------------------------

  async createConnection(
    connection: {
      householdId: string;
      provider: string;
      referenceNumber: string;
      tariffCategory?: string;
      tariffCode?: string;
    },
    context: MutationContext
  ): Promise<PostgresConnection> {
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withTenantContext(client, context.accountId, async () => {
          const allowedCategories = ['domestic_protected', 'domestic_unprotected', 'commercial'];
          const candidateCat = connection.tariffCategory || connection.tariffCode;
          const cat = candidateCat && allowedCategories.includes(candidateCat)
            ? candidateCat
            : 'domestic_protected';

          const res = await client.query<PostgresConnection>(
            `INSERT INTO connections (household_id, provider, reference_number, tariff_category, version)
             VALUES ($1, $2, $3, $4, 1)
             RETURNING *`,
            [
              connection.householdId,
              connection.provider,
              connection.referenceNumber,
              cat,
            ]
          );
          const created = res.rows[0];
          await this.logAudit(client, {
            householdId: connection.householdId,
            actorAccountId: context.accountId,
            action: 'create',
            entityType: 'connection',
            entityId: created.id,
            entityVersion: 1,
            afterState: created as unknown as Record<string, unknown>,
            reason: context.reason,
            correlationId: context.correlationId,
          });
          return created;
        }, connection.householdId);
      });
    }, this.pool);
  }

  // ---------------------------------------------------------------------------
  // Meter Operations
  // ---------------------------------------------------------------------------

  async createMeter(
    meter: {
      householdId: string;
      connectionId: string;
      name?: string;
      type?: string;
      serialNumber?: string;
      isIndoorResetSupported?: boolean;
    },
    context: MutationContext
  ): Promise<PostgresMeter> {
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withTenantContext(client, context.accountId, async () => {
          const res = await client.query<PostgresMeter>(
            `INSERT INTO meters (household_id, connection_id, name, type, serial_number, is_indoor_reset_supported, version)
             VALUES ($1, $2, $3, $4, $5, $6, 1)
             RETURNING *`,
            [
              meter.householdId,
              meter.connectionId,
              meter.name || 'Main Meter',
              meter.type || 'outdoor_lesco_digital',
              meter.serialNumber ?? null,
              meter.isIndoorResetSupported ?? false,
            ]
          );
          const created = res.rows[0];
          await this.logAudit(client, {
            householdId: meter.householdId,
            actorAccountId: context.accountId,
            action: 'create',
            entityType: 'meter',
            entityId: created.id,
            entityVersion: 1,
            afterState: created as unknown as Record<string, unknown>,
            reason: context.reason,
            correlationId: context.correlationId,
          });
          return created;
        }, meter.householdId);
      });
    }, this.pool);
  }

  // ---------------------------------------------------------------------------
  // Billing Cycle Operations (Connection-Scoped, NO meter_id)
  // ---------------------------------------------------------------------------

  async createBillingCycle(
    cycle: {
      householdId: string;
      connectionId: string;
      billingPeriodStart: string;
      billingPeriodEnd?: string | null;
      status?: string;
      notes?: string;
      meterId?: string;
      officialReadingDate?: string;
      previousOfficialReading?: number;
      currentOfficialReading?: number;
      billedUnits?: number;
    },
    context: MutationContext
  ): Promise<PostgresBillingCycle> {
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withTenantContext(client, context.accountId, async () => {
          const res = await client.query<PostgresBillingCycle>(
            `INSERT INTO billing_cycles (household_id, connection_id, billing_period_start, billing_period_end, status, notes, version)
             VALUES ($1, $2, $3, $4, $5, $6, 1)
             RETURNING *`,
            [
              cycle.householdId,
              cycle.connectionId,
              cycle.billingPeriodStart,
              cycle.billingPeriodEnd ?? null,
              cycle.status ?? 'active',
              cycle.notes ?? null,
            ]
          );
          const created = res.rows[0];
          await this.logAudit(client, {
            householdId: cycle.householdId,
            actorAccountId: context.accountId,
            action: 'create',
            entityType: 'billing_cycle',
            entityId: created.id,
            entityVersion: 1,
            afterState: created as unknown as Record<string, unknown>,
            reason: context.reason,
            correlationId: context.correlationId,
          });
          return created;
        }, cycle.householdId);
      });
    }, this.pool);
  }

  async closeBillingCycle(
    id: string,
    householdId: string,
    expectedVersion: number,
    updatesOrContext: {
      billingPeriodEnd?: string;
      syncOutdoorReading?: number;
      syncReadingTimestamp?: string;
      gapUnits?: number;
      notes?: string;
    } | MutationContext,
    optionalContext?: MutationContext
  ): Promise<PostgresBillingCycle> {
    const isUpdates = optionalContext !== undefined || (!('accountId' in updatesOrContext) && ('billingPeriodEnd' in updatesOrContext || 'syncOutdoorReading' in updatesOrContext));
    const updates = isUpdates ? (updatesOrContext as {
      billingPeriodEnd?: string;
      syncOutdoorReading?: number;
      syncReadingTimestamp?: string;
      gapUnits?: number;
      notes?: string;
    }) : undefined;
    const context = (isUpdates ? optionalContext : (updatesOrContext as MutationContext)) || { accountId: '' };

    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withTenantContext(client, context.accountId, async () => {
          const currentRes = await client.query<PostgresBillingCycle>(
            'SELECT * FROM billing_cycles WHERE id = $1 AND household_id = $2 FOR UPDATE',
            [id, householdId]
          );
          if (currentRes.rows.length === 0) {
            throw new IntegrityViolationError('not_found', `Billing cycle ${id} not found.`);
          }
          const before = currentRes.rows[0];

          if (before.status === 'closed' || before.status === 'locked') {
            throw new IntegrityViolationError('already_closed', `Billing cycle ${id} is already ${before.status}.`);
          }

          const periodEnd = updates?.billingPeriodEnd ?? before.billing_period_end;
          if (!periodEnd) {
            throw new IntegrityViolationError('missing_end_date', `Finalized billing cycle requires a billing period end date.`);
          }

          const res = await client.query<PostgresBillingCycle>(
            `UPDATE billing_cycles
             SET status = 'closed',
                 billing_period_end = $1,
                 sync_outdoor_reading = COALESCE($2, sync_outdoor_reading),
                 sync_reading_timestamp = COALESCE($3, sync_reading_timestamp),
                 gap_units = COALESCE($4, gap_units),
                 notes = COALESCE($5, notes),
                 version = version + 1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $6 AND household_id = $7 AND version = $8
             RETURNING *`,
            [
              periodEnd,
              updates?.syncOutdoorReading ?? null,
              updates?.syncReadingTimestamp ?? null,
              updates?.gapUnits ?? null,
              updates?.notes ?? null,
              id,
              householdId,
              expectedVersion,
            ]
          );

          if (res.rows.length === 0) {
            throw new ConcurrencyError(`Stale write: Billing cycle ${id} version mismatch.`);
          }

          const updated = res.rows[0];
          await this.logAudit(client, {
            householdId,
            actorAccountId: context.accountId,
            action: 'lock',
            entityType: 'billing_cycle',
            entityId: id,
            entityVersion: updated.version,
            beforeState: before as unknown as Record<string, unknown>,
            afterState: updated as unknown as Record<string, unknown>,
            reason: context.reason,
            correlationId: context.correlationId,
          });
          return updated;
        }, householdId);
      });
    }, this.pool);
  }

  // ---------------------------------------------------------------------------
  // Meter Reading Operations (with Row-Level Meter Locking and Monotonicity)
  // ---------------------------------------------------------------------------

  async addMeterReading(
    reading: {
      householdId: string;
      connectionId: string;
      meterId: string;
      cycleId: string;
      cumulativeKWh: number;
      readingTimestamp: string;
      source: string;
      isBaseline?: boolean;
      lifecycleEventId?: string;
      notes?: string;
    },
    context: MutationContext
  ): Promise<PostgresMeterReading> {
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withTenantContext(client, context.accountId, async () => {
          // 0. Idempotency Check if key provided
          let payloadHash = '';
          if (context.idempotencyKey) {
            payloadHash = createHash('sha256')
              .update(JSON.stringify({
                householdId: reading.householdId,
                connectionId: reading.connectionId,
                meterId: reading.meterId,
                cycleId: reading.cycleId,
                cumulativeKWh: reading.cumulativeKWh,
                readingTimestamp: reading.readingTimestamp,
                source: reading.source,
              }))
              .digest('hex');

            const existingRes = await client.query<PostgresIdempotencyKey>(
              `SELECT * FROM idempotency_keys
               WHERE account_id = $1 AND key = $2
               FOR UPDATE`,
              [context.accountId, context.idempotencyKey]
            );

            if (existingRes.rows.length > 0) {
              const existing = existingRes.rows[0];
              if (existing.request_hash !== payloadHash) {
                throw new IntegrityViolationError(
                  'idempotency_payload_mismatch',
                  'Idempotency key reused with different payload.'
                );
              }
              if (existing.response_body) {
                return existing.response_body as unknown as PostgresMeterReading;
              }
            } else {
              await client.query(
                `INSERT INTO idempotency_keys (account_id, key, request_path, request_hash, status)
                 VALUES ($1, $2, $3, $4, 'in_progress')`,
                [context.accountId, context.idempotencyKey, '/readings', payloadHash]
              );
            }
          }

          // 1. Check Cycle Status with Shared Lock
          const cycleRes = await client.query<PostgresBillingCycle>(
            'SELECT * FROM billing_cycles WHERE id = $1 AND household_id = $2 FOR SHARE',
            [reading.cycleId, reading.householdId]
          );
          if (cycleRes.rows.length === 0) {
            throw new IntegrityViolationError('invalid_cycle', 'Billing cycle not found in household.');
          }
          const cycle = cycleRes.rows[0];
          if (cycle.status === 'closed' || cycle.status === 'locked') {
            throw new IntegrityViolationError(
              'READING_FINALIZED',
              `Cannot add readings to a ${cycle.status} billing cycle.`
            );
          }

          // 2. Validate reading timestamp: first reject future timestamps (skew limit 5 minutes)
          const readingTime = new Date(reading.readingTimestamp).getTime();
          const now = Date.now();
          if (readingTime > now + 5 * 60 * 1000) {
            throw new IntegrityViolationError(
              'future_timestamp',
              'Physical reading timestamp cannot be in the future (skew limit 5 minutes).'
            );
          }

          // Then validate reading timestamp falls within current billing cycle
          const cycleStart = parseDateBoundary(cycle.billing_period_start, false);
          const cycleEnd = cycle.billing_period_end ? parseDateBoundary(cycle.billing_period_end, true) : null;
          if (readingTime < cycleStart || (cycleEnd !== null && readingTime > cycleEnd)) {
            throw new IntegrityViolationError(
              'READING_OUTSIDE_CURRENT_CYCLE',
              `Physical reading timestamp (${reading.readingTimestamp}) falls outside active billing cycle period (${cycle.billing_period_start} to ${cycle.billing_period_end}).`
            );
          }

          // 3. Pessimistic Row Lock on Meter to safely serialize sequence operations
          const meterRes = await client.query<PostgresMeter>(
            'SELECT * FROM meters WHERE id = $1 AND household_id = $2 FOR UPDATE',
            [reading.meterId, reading.householdId]
          );
          if (meterRes.rows.length === 0) {
            throw new IntegrityViolationError('invalid_meter', 'Meter not found in household.');
          }

          // 5. Inspect Neighbors in Sequence for Monotonicity
          const prevRes = await client.query<PostgresMeterReading>(
            `SELECT * FROM meter_readings
             WHERE meter_id = $1 AND reading_timestamp < $2
             ORDER BY reading_timestamp DESC
             LIMIT 1`,
            [reading.meterId, reading.readingTimestamp]
          );

          const nextRes = await client.query<PostgresMeterReading>(
            `SELECT * FROM meter_readings
             WHERE meter_id = $1 AND reading_timestamp > $2
             ORDER BY reading_timestamp ASC
             LIMIT 1`,
            [reading.meterId, reading.readingTimestamp]
          );

          const previous = prevRes.rows[0];
          const next = nextRes.rows[0];

          // Check if baseline reading has authorized lifecycle event
          let isAuthorizedBaseline = false;
          if (reading.isBaseline && reading.lifecycleEventId) {
            const lcRes = await client.query<PostgresLifecycleEvent>(
              `SELECT * FROM meter_lifecycle_events
               WHERE id = $1 AND meter_id = $2 AND household_id = $3`,
              [reading.lifecycleEventId, reading.meterId, reading.householdId]
            );
            if (lcRes.rows.length > 0) {
              const lc = lcRes.rows[0];
              if (
                (lc.type === 'reset' || lc.type === 'replaced') &&
                Date.parse(lc.occurred_at) <= readingTime &&
                Number(lc.baseline_reading) === reading.cumulativeKWh
              ) {
                isAuthorizedBaseline = true;
              }
            }
          }

          if (reading.isBaseline && !isAuthorizedBaseline) {
            throw new IntegrityViolationError(
              'unauthorized_baseline',
              'Baseline reading requires a matching reset or replacement lifecycle event.'
            );
          }

          if (previous && reading.cumulativeKWh < Number(previous.cumulative_kwh) && !isAuthorizedBaseline) {
            throw new IntegrityViolationError(
              'decreasing_reading',
              `Reading ${reading.cumulativeKWh} decreased from predecessor ${previous.cumulative_kwh} without an authorized lifecycle event.`
            );
          }

          if (next && reading.cumulativeKWh > Number(next.cumulative_kwh) && !next.is_baseline) {
            throw new IntegrityViolationError(
              'decreasing_reading',
              `Reading ${reading.cumulativeKWh} is greater than successor ${next.cumulative_kwh}.`
            );
          }

          // 6. Insert Reading with Server Timestamp Authority
          const insertRes = await client.query<PostgresMeterReading>(
            `INSERT INTO meter_readings (
              household_id, connection_id, meter_id, cycle_id,
              cumulative_kwh, reading_timestamp, source,
              is_baseline, lifecycle_event_id, notes, version
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)
            RETURNING *`,
            [
              reading.householdId,
              reading.connectionId,
              reading.meterId,
              reading.cycleId,
              reading.cumulativeKWh,
              reading.readingTimestamp,
              reading.source,
              reading.isBaseline ?? false,
              reading.lifecycleEventId ?? null,
              reading.notes ?? null,
            ]
          );

          const created = insertRes.rows[0];

          if (context.idempotencyKey) {
            await client.query(
              `UPDATE idempotency_keys
               SET status = 'completed',
                   response_code = 201,
                   response_body = $1
               WHERE account_id = $2 AND key = $3`,
              [JSON.stringify(created), context.accountId, context.idempotencyKey]
            );
          }

          // 7. Log Audit Record
          await this.logAudit(client, {
            householdId: reading.householdId,
            actorAccountId: context.accountId,
            action: 'create',
            entityType: 'meter_reading',
            entityId: created.id,
            entityVersion: 1,
            afterState: created as unknown as Record<string, unknown>,
            reason: context.reason,
            correlationId: context.correlationId,
            idempotencyKey: context.idempotencyKey,
          });

          return created;
        });
      });
    }, this.pool);
  }

  async updateMeterReading(
    id: string,
    householdId: string,
    expectedVersion: number,
    updates: {
      cumulativeKWh?: number;
      readingTimestamp?: string;
      notes?: string;
    },
    context: MutationContext
  ): Promise<PostgresMeterReading> {
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withTenantContext(client, context.accountId, async () => {
          // 1. Fetch reading with lock
          const currentRes = await client.query<PostgresMeterReading>(
            'SELECT * FROM meter_readings WHERE id = $1 AND household_id = $2 FOR UPDATE',
            [id, householdId]
          );
          if (currentRes.rows.length === 0) {
            throw new IntegrityViolationError('not_found', `Meter reading ${id} not found.`);
          }
          const current = currentRes.rows[0];

          // 2. Optimistic Concurrency check
          if (current.version !== expectedVersion) {
            throw new ConcurrencyError(
              `READING_CONCURRENCY_CONFLICT: Expected version ${expectedVersion}, but found ${current.version}.`
            );
          }

          // 3. Billing cycle status check
          const cycleRes = await client.query<PostgresBillingCycle>(
            'SELECT * FROM billing_cycles WHERE id = $1 AND household_id = $2 FOR SHARE',
            [current.cycle_id, householdId]
          );
          if (cycleRes.rows.length === 0) {
            throw new IntegrityViolationError('invalid_cycle', 'Associated billing cycle not found.');
          }
          const cycle = cycleRes.rows[0];
          if (cycle.status === 'closed' || cycle.status === 'locked') {
            throw new IntegrityViolationError(
              'READING_FINALIZED',
              `Cannot modify reading belonging to a ${cycle.status} billing cycle.`
            );
          }

          const newTimestamp = updates.readingTimestamp ?? current.reading_timestamp;
          const newCumulative = updates.cumulativeKWh !== undefined ? updates.cumulativeKWh : Number(current.cumulative_kwh);

          // 4. Timestamp within cycle check
          const readingTime = new Date(newTimestamp).getTime();
          const cycleStart = parseDateBoundary(cycle.billing_period_start, false);
          const cycleEnd = cycle.billing_period_end ? parseDateBoundary(cycle.billing_period_end, true) : null;
          if (readingTime < cycleStart || (cycleEnd !== null && readingTime > cycleEnd)) {
            throw new IntegrityViolationError(
              'READING_OUTSIDE_CURRENT_CYCLE',
              `Physical reading timestamp (${newTimestamp}) falls outside active billing cycle period (${cycle.billing_period_start} to ${cycle.billing_period_end}).`
            );
          }

          // 5. Skew limit check against future
          const now = Date.now();
          if (readingTime > now + 5 * 60 * 1000) {
            throw new IntegrityViolationError(
              'future_timestamp',
              'Physical reading timestamp cannot be in the future (skew limit 5 minutes).'
            );
          }

          // 6. Monotonicity checks
          await client.query(
            'SELECT * FROM meters WHERE id = $1 AND household_id = $2 FOR UPDATE',
            [current.meter_id, householdId]
          );

          const prevRes = await client.query<PostgresMeterReading>(
            `SELECT * FROM meter_readings
             WHERE meter_id = $1 AND reading_timestamp < $2 AND id != $3
             ORDER BY reading_timestamp DESC
             LIMIT 1`,
            [current.meter_id, newTimestamp, id]
          );

          const nextRes = await client.query<PostgresMeterReading>(
            `SELECT * FROM meter_readings
             WHERE meter_id = $1 AND reading_timestamp > $2 AND id != $3
             ORDER BY reading_timestamp ASC
             LIMIT 1`,
            [current.meter_id, newTimestamp, id]
          );

          const previous = prevRes.rows[0];
          const next = nextRes.rows[0];

          if (previous && newCumulative < Number(previous.cumulative_kwh) && !current.is_baseline) {
            throw new IntegrityViolationError(
              'decreasing_reading',
              `Reading ${newCumulative} decreased from predecessor ${previous.cumulative_kwh}.`
            );
          }

          if (next && newCumulative > Number(next.cumulative_kwh) && !next.is_baseline) {
            throw new IntegrityViolationError(
              'decreasing_reading',
              `Reading ${newCumulative} is greater than successor ${next.cumulative_kwh}.`
            );
          }

          // 7. Update row
          const res = await client.query<PostgresMeterReading>(
            `UPDATE meter_readings
             SET cumulative_kwh = $1,
                 reading_timestamp = $2,
                 notes = COALESCE($3, notes),
                 version = version + 1
             WHERE id = $4 AND version = $5
             RETURNING *`,
            [newCumulative, newTimestamp, updates.notes ?? null, id, expectedVersion]
          );

          if (res.rows.length === 0) {
            throw new ConcurrencyError(`READING_CONCURRENCY_CONFLICT: Version mismatch during update.`);
          }

          const updated = res.rows[0];

          await this.logAudit(client, {
            householdId,
            actorAccountId: context.accountId,
            action: 'edit',
            entityType: 'meter_reading',
            entityId: id,
            entityVersion: updated.version,
            beforeState: current as unknown as Record<string, unknown>,
            afterState: updated as unknown as Record<string, unknown>,
            reason: context.reason,
            correlationId: context.correlationId,
          });

          return updated;
        }, householdId);
      });
    }, this.pool);
  }

  async deleteMeterReading(
    id: string,
    householdId: string,
    expectedVersion: number,
    context: MutationContext
  ): Promise<void> {
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withTenantContext(client, context.accountId, async () => {
          // 1. Authenticated account and authorized household membership are checked via tenant context and RLS
          // 2. Fetch reading with row lock
          const currentRes = await client.query<PostgresMeterReading>(
            'SELECT * FROM meter_readings WHERE id = $1 AND household_id = $2 FOR UPDATE',
            [id, householdId]
          );
          if (currentRes.rows.length === 0) {
            throw new IntegrityViolationError('not_found', `Meter reading ${id} not found.`);
          }
          const reading = currentRes.rows[0];

          // 3. Optimistic concurrency check
          if (reading.version !== expectedVersion) {
            throw new ConcurrencyError(
              `READING_CONCURRENCY_CONFLICT: Expected version ${expectedVersion}, but found ${reading.version}.`
            );
          }

          // 4. Verify billing cycle ownership and open status
          const cycleRes = await client.query<PostgresBillingCycle>(
            'SELECT * FROM billing_cycles WHERE id = $1 AND household_id = $2 FOR SHARE',
            [reading.cycle_id, householdId]
          );
          if (cycleRes.rows.length === 0) {
            throw new IntegrityViolationError('invalid_cycle', 'Associated billing cycle not found.');
          }
          const cycle = cycleRes.rows[0];
          if (cycle.status === 'closed' || cycle.status === 'locked') {
            throw new IntegrityViolationError(
              'READING_FINALIZED',
              `Cannot delete reading belonging to a ${cycle.status} billing cycle.`
            );
          }

          // 5. Baseline requirement check
          if (reading.is_baseline) {
            throw new IntegrityViolationError(
              'READING_BASELINE_REQUIRED',
              'Cannot delete baseline meter reading without resolving the associated meter lifecycle event.'
            );
          }

          // 6. Check if lifecycle event references this reading
          if (reading.lifecycle_event_id) {
            throw new IntegrityViolationError(
              'READING_REFERENCED',
              'Cannot delete meter reading that is bound to a lifecycle event.'
            );
          }

          // 7. Resulting sequence validity (check neighbors)
          await client.query(
            'SELECT * FROM meters WHERE id = $1 AND household_id = $2 FOR UPDATE',
            [reading.meter_id, householdId]
          );

          const prevRes = await client.query<PostgresMeterReading>(
            `SELECT * FROM meter_readings
             WHERE meter_id = $1 AND reading_timestamp < $2 AND id != $3
             ORDER BY reading_timestamp DESC
             LIMIT 1`,
            [reading.meter_id, reading.reading_timestamp, id]
          );
          const nextRes = await client.query<PostgresMeterReading>(
            `SELECT * FROM meter_readings
             WHERE meter_id = $1 AND reading_timestamp > $2 AND id != $3
             ORDER BY reading_timestamp ASC
             LIMIT 1`,
            [reading.meter_id, reading.reading_timestamp, id]
          );

          const prev = prevRes.rows[0];
          const next = nextRes.rows[0];

          if (prev && next && Number(next.cumulative_kwh) < Number(prev.cumulative_kwh) && !next.is_baseline) {
            throw new IntegrityViolationError(
              'READING_INVALID_AFTER_DELETE',
              `Deleting reading would create an invalid decreasing sequence between predecessor (${prev.cumulative_kwh}) and successor (${next.cumulative_kwh}).`
            );
          }

          // 8. Execute deletion
          const delRes = await client.query(
            'DELETE FROM meter_readings WHERE id = $1 AND version = $2',
            [id, expectedVersion]
          );
          if ((delRes.rowCount ?? 0) === 0) {
            throw new ConcurrencyError('READING_CONCURRENCY_CONFLICT: Version mismatch during delete.');
          }

          // 9. Record Audit Log
          await this.logAudit(client, {
            householdId,
            actorAccountId: context.accountId,
            action: 'delete',
            entityType: 'meter_reading',
            entityId: id,
            entityVersion: reading.version + 1,
            beforeState: reading as unknown as Record<string, unknown>,
            reason: context.reason,
            correlationId: context.correlationId,
          });
        }, householdId);
      });
    }, this.pool);
  }

  async deleteBillingCycle(
    id: string,
    householdId: string,
    expectedVersion: number,
    context: MutationContext
  ): Promise<void> {
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withTenantContext(client, context.accountId, async () => {
          const currentRes = await client.query<PostgresBillingCycle>(
            'SELECT * FROM billing_cycles WHERE id = $1 AND household_id = $2 FOR UPDATE',
            [id, householdId]
          );
          if (currentRes.rows.length === 0) {
            throw new IntegrityViolationError('not_found', `Billing cycle ${id} not found.`);
          }
          const cycle = currentRes.rows[0];
          if (cycle.status === 'closed' || cycle.status === 'locked') {
            throw new IntegrityViolationError(
              'CYCLE_FINALIZED',
              `Cannot delete finalized or locked billing cycle ${id}.`
            );
          }
          if (cycle.version !== expectedVersion) {
            throw new ConcurrencyError(`Concurrency error: Billing cycle ${id} version mismatch.`);
          }

          const delRes = await client.query(
            'DELETE FROM billing_cycles WHERE id = $1 AND version = $2',
            [id, expectedVersion]
          );
          if ((delRes.rowCount ?? 0) === 0) {
            throw new ConcurrencyError(`Concurrency error: Billing cycle ${id} version mismatch.`);
          }

          await this.logAudit(client, {
            householdId,
            actorAccountId: context.accountId,
            action: 'delete',
            entityType: 'billing_cycle',
            entityId: id,
            entityVersion: cycle.version + 1,
            beforeState: cycle as unknown as Record<string, unknown>,
            reason: context.reason,
            correlationId: context.correlationId,
          });
        }, householdId);
      });
    }, this.pool);
  }

  async deleteOfficialBill(
    id: string,
    householdId: string,
    expectedVersion: number,
    context: MutationContext
  ): Promise<void> {
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withTenantContext(client, context.accountId, async () => {
          const currentRes = await client.query<PostgresOfficialBill>(
            'SELECT * FROM official_bills WHERE id = $1 AND household_id = $2 FOR UPDATE',
            [id, householdId]
          );
          if (currentRes.rows.length === 0) {
            throw new IntegrityViolationError('not_found', `Official bill ${id} not found.`);
          }
          const bill = currentRes.rows[0];
          if (bill.revision_status === 'finalized') {
            throw new IntegrityViolationError(
              'BILL_FINALIZED',
              `Cannot delete finalized official bill ${id}.`
            );
          }
          if (bill.version !== expectedVersion) {
            throw new ConcurrencyError(`Concurrency error: Official bill ${id} version mismatch.`);
          }

          const delRes = await client.query(
            'DELETE FROM official_bills WHERE id = $1 AND version = $2',
            [id, expectedVersion]
          );
          if ((delRes.rowCount ?? 0) === 0) {
            throw new ConcurrencyError(`Concurrency error: Official bill ${id} version mismatch.`);
          }

          await this.logAudit(client, {
            householdId,
            actorAccountId: context.accountId,
            action: 'delete',
            entityType: 'official_bill',
            entityId: id,
            entityVersion: bill.version + 1,
            beforeState: bill as unknown as Record<string, unknown>,
            reason: context.reason,
            correlationId: context.correlationId,
          });
        }, householdId);
      });
    }, this.pool);
  }

  // ---------------------------------------------------------------------------
  // Official Bill Operations
  // ---------------------------------------------------------------------------

  async createOfficialBill(
    bill: {
      householdId: string;
      connectionId: string;
      billingCycleId: string;
      billReference: string;
      billingPeriodStart: string;
      billingPeriodEnd: string;
      issuedOn: string;
      dueOn?: string;
      previousReading: number;
      currentReading: number;
      billedUnits: number;
      billedAmount: number;
      tariffRatePerUnit?: number;
      electricityDuty?: number;
      tvFee?: number;
      fca?: number;
      gst?: number;
      fpa?: number;
      otherCharges?: number;
      source?: string;
      extractionState?: string;
    },
    context: MutationContext
  ): Promise<PostgresOfficialBill> {
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withTenantContext(client, context.accountId, async () => {
          const res = await client.query<PostgresOfficialBill>(
            `INSERT INTO official_bills (
              household_id, connection_id, billing_cycle_id, bill_reference,
              billing_period_start, billing_period_end, issued_on, due_on,
              previous_reading, current_reading, billed_units, billed_amount,
              tariff_rate_per_unit, electricity_duty, tv_fee, fca, gst, fpa, other_charges,
              source, extraction_state, revision_status, revision_number, version
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
              $13, $14, $15, $16, $17, $18, $19, $20, $21, 'active', 1, 1
            ) RETURNING *`,
            [
              bill.householdId,
              bill.connectionId,
              bill.billingCycleId,
              bill.billReference,
              bill.billingPeriodStart,
              bill.billingPeriodEnd,
              bill.issuedOn,
              bill.dueOn ?? null,
              bill.previousReading,
              bill.currentReading,
              bill.billedUnits,
              bill.billedAmount ?? (bill as any).totalCurrentBill ?? (bill as any).costOfElectricity ?? 0,
              bill.tariffRatePerUnit ?? 0,
              bill.electricityDuty ?? 0,
              bill.tvFee ?? 0,
              bill.fca ?? 0,
              bill.gst ?? 0,
              bill.fpa ?? 0,
              bill.otherCharges ?? 0,
              bill.source ?? 'user_entered',
              bill.extractionState ?? 'not_applicable',
            ]
          );
          const created = res.rows[0];
          await this.logAudit(client, {
            householdId: bill.householdId,
            actorAccountId: context.accountId,
            action: 'create',
            entityType: 'official_bill',
            entityId: created.id,
            entityVersion: 1,
            afterState: created as unknown as Record<string, unknown>,
            reason: context.reason,
            correlationId: context.correlationId,
          });
          return created;
        }, bill.householdId);
      });
    }, this.pool);
  }

  async finalizeOfficialBill(
    id: string,
    householdId: string,
    expectedVersion: number,
    context: MutationContext
  ): Promise<PostgresOfficialBill> {
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withTenantContext(client, context.accountId, async () => {
          const currentRes = await client.query<PostgresOfficialBill>(
            'SELECT * FROM official_bills WHERE id = $1 AND household_id = $2',
            [id, householdId]
          );
          if (currentRes.rows.length === 0) {
            throw new IntegrityViolationError('not_found', `Official bill ${id} not found.`);
          }
          const before = currentRes.rows[0];

          const res = await client.query<PostgresOfficialBill>(
            `UPDATE official_bills
             SET revision_status = 'finalized',
                 finalized_at = CURRENT_TIMESTAMP,
                 confirmed_by_account_id = $1,
                 confirmed_at = CURRENT_TIMESTAMP,
                 version = version + 1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND household_id = $3 AND version = $4
             RETURNING *`,
            [context.accountId, id, householdId, expectedVersion]
          );

          if (res.rows.length === 0) {
            throw new ConcurrencyError(`Stale write: Official bill ${id} version mismatch.`);
          }

          const updated = res.rows[0];
          await this.logAudit(client, {
            householdId,
            actorAccountId: context.accountId,
            action: 'finalize',
            entityType: 'official_bill',
            entityId: id,
            entityVersion: updated.version,
            beforeState: before as unknown as Record<string, unknown>,
            afterState: updated as unknown as Record<string, unknown>,
            reason: context.reason,
            correlationId: context.correlationId,
          });
          return updated;
        }, householdId);
      });
    }, this.pool);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle Event Operations
  // ---------------------------------------------------------------------------

  async createLifecycleEvent(
    event: {
      householdId: string;
      connectionId: string;
      meterId: string;
      type: string;
      occurredAt: string;
      previousMeterId?: string;
      baselineReading?: number;
      reason?: string;
    },
    context: MutationContext
  ): Promise<PostgresLifecycleEvent> {
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withTenantContext(client, context.accountId, async () => {
          const res = await client.query<PostgresLifecycleEvent>(
            `INSERT INTO meter_lifecycle_events (
              household_id, connection_id, meter_id, type, occurred_at,
              previous_meter_id, baseline_reading, reason, version
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1)
            RETURNING *`,
            [
              event.householdId,
              event.connectionId,
              event.meterId,
              event.type,
              event.occurredAt,
              event.previousMeterId ?? null,
              event.baselineReading ?? null,
              event.reason ?? null,
            ]
          );
          const created = res.rows[0];
          await this.logAudit(client, {
            householdId: event.householdId,
            actorAccountId: context.accountId,
            action: 'create',
            entityType: 'meter_lifecycle_event',
            entityId: created.id,
            entityVersion: 1,
            afterState: created as unknown as Record<string, unknown>,
            reason: context.reason,
            correlationId: context.correlationId,
          });
          return created;
        }, event.householdId);
      });
    }, this.pool);
  }

  // ---------------------------------------------------------------------------
  // Idempotency Foundations
  // ---------------------------------------------------------------------------

  async checkOrRecordIdempotency(params: {
    accountId: string;
    key: string;
    requestPath: string;
    requestHash: string;
  }): Promise<{ isExisting: boolean; record?: PostgresIdempotencyKey }> {
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        const existingRes = await client.query<PostgresIdempotencyKey>(
          `SELECT * FROM idempotency_keys
           WHERE account_id = $1 AND key = $2
           FOR UPDATE`,
          [params.accountId, params.key]
        );

        if (existingRes.rows.length > 0) {
          const existing = existingRes.rows[0];
          if (existing.request_hash !== params.requestHash) {
            throw new IntegrityViolationError(
              'idempotency_hash_mismatch',
              'Idempotency key reused with different payload.'
            );
          }
          return { isExisting: true, record: existing };
        }

        await client.query(
          `INSERT INTO idempotency_keys (account_id, key, request_path, request_hash, status)
           VALUES ($1, $2, $3, $4, 'in_progress')`,
          [params.accountId, params.key, params.requestPath, params.requestHash]
        );

        return { isExisting: false };
      });
    }, this.pool);
  }

  async completeIdempotency(params: {
    accountId: string;
    key: string;
    responseCode: number;
    responseBody: Record<string, unknown>;
  }): Promise<void> {
    return withClient(async (client) => {
      await client.query(
        `UPDATE idempotency_keys
         SET status = 'completed',
             response_code = $1,
             response_body = $2
         WHERE account_id = $3 AND key = $4`,
        [params.responseCode, JSON.stringify(params.responseBody), params.accountId, params.key]
      );
    }, this.pool);
  }

  // ---------------------------------------------------------------------------
  // Internal Transactional Audit Logger
  // ---------------------------------------------------------------------------

  private async logAudit(
    client: PoolClient,
    entry: {
      householdId: string;
      actorAccountId: string;
      action: string;
      entityType: string;
      entityId: string;
      entityVersion?: number;
      beforeState?: Record<string, unknown>;
      afterState?: Record<string, unknown>;
      reason?: string;
      correlationId?: string;
      idempotencyKey?: string;
    }
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_logs (
        household_id, actor_account_id, action, entity_type, entity_id,
        entity_version, before_state, after_state, reason, correlation_id, idempotency_key
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.householdId,
        entry.actorAccountId,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.entityVersion ?? null,
        entry.beforeState ? JSON.stringify(entry.beforeState) : null,
        entry.afterState ? JSON.stringify(entry.afterState) : null,
        entry.reason ?? null,
        entry.correlationId ?? null,
        entry.idempotencyKey ?? null,
      ]
    );
  }
}
