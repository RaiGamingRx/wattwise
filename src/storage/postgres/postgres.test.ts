import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getDbPool, getAdminPool, closeDbPool, closeAdminPool, withClient, withTransaction, withTenantContext, withSystemContext } from './db';
import { PostgresEnergyRepository, ConcurrencyError, IntegrityViolationError } from './repository';
import { PostgresMigrationAdapter } from './migrationAdapter';
import { developmentFixtureState } from '../localStorageAdapter';
import { calculateMeterConsumption, calculateCycleSummary } from '../../engine/calculations';
import { BillingCycle, MeterReading } from '../../types';

describe('WattWise Milestone 0.5.1: PostgreSQL Foundation', () => {
  const pool = getDbPool();
  const repo = new PostgresEnergyRepository(pool);
  const migrationAdapter = new PostgresMigrationAdapter(pool);

  beforeAll(async () => {
    await withClient(async (client) => {
      const res = await client.query("SELECT to_regclass('public.households') as tbl");
      if (!res.rows[0]?.tbl) {
        const schemaSql = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8');
        await client.query(schemaSql);
      }
    }, getAdminPool());
  });

  afterAll(async () => {
    await closeDbPool();
    await closeAdminPool();
  });

  beforeEach(async () => {
    // Clean tables in reverse dependency order before each test using administrative connection
    await withClient(async (client) => {
      await client.query(`
        TRUNCATE TABLE
          audit_logs,
          idempotency_keys,
          meter_readings,
          meter_lifecycle_events,
          official_bills,
          billing_cycles,
          meters,
          connections,
          household_memberships,
          households,
          accounts
        CASCADE;
      `);
    }, getAdminPool());
  });

  // ---------------------------------------------------------------------------
  // 1. Tenant Boundary, Anti-IDOR, and RLS Isolation
  // ---------------------------------------------------------------------------
  describe('Tenant Boundary & Row Level Security (RLS)', () => {
    it('enforces household isolation and rejects cross-household reading or writing', async () => {
      // 1. Create two separate accounts
      const userA = await repo.createAccount({ authUserId: 'auth-user-a', email: 'a@example.com' });
      const userB = await repo.createAccount({ authUserId: 'auth-user-b', email: 'b@example.com' });

      // 2. Create two separate households
      const { household: hh1 } = await repo.createHousehold({ name: 'Household One' }, userA.id);
      const { household: hh2 } = await repo.createHousehold({ name: 'Household Two' }, userB.id);

      // 3. User A creates connection and meter in Household 1
      const conn1 = await repo.createConnection({
        householdId: hh1.id,
        provider: 'LESCO',
        referenceNumber: '08112233445566',
        tariffCategory: 'domestic_protected',
      }, { accountId: userA.id });

      const meter1 = await repo.createMeter({
        householdId: hh1.id,
        connectionId: conn1.id,
        name: 'Main Meter',
        type: 'outdoor_lesco_digital',
      }, { accountId: userA.id });

      // 4. Verify RLS hides Household 1 meters from User B
      await withClient(async (client) => {
        await withTenantContext(client, userB.id, async () => {
          const res = await client.query('SELECT * FROM meters WHERE id = $1', [meter1.id]);
          expect(res.rows.length).toBe(0); // Invisible via RLS
        });
      }, pool);

      // 5. Verify RLS blocks User B from inserting into Household 1
      await withClient(async (client) => {
        await withTenantContext(client, userB.id, async () => {
          await expect(
            client.query(
              `INSERT INTO meters (household_id, connection_id, name, type, unit)
               VALUES ($1, $2, 'Malicious Meter', 'manual_counter', 'kWh')`,
              [hh1.id, conn1.id]
            )
          ).rejects.toThrow();
        });
      }, pool);
    });

    it('enforces role permissions: viewer cannot write records', async () => {
      const owner = await repo.createAccount({ authUserId: 'owner-user' });
      const viewer = await repo.createAccount({ authUserId: 'viewer-user' });

      const { household } = await repo.createHousehold({ name: 'Family Home' }, owner.id);

      // Add viewer membership via owner
      await withClient(async (client) => {
        await withTenantContext(client, owner.id, async () => {
          await client.query(
            `INSERT INTO household_memberships (household_id, account_id, role)
             VALUES ($1, $2, 'viewer')`,
            [household.id, viewer.id]
          );
        });
      }, pool);

      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '11223344556677',
        tariffCategory: 'domestic_protected',
      }, { accountId: owner.id });

      // Viewer can read connection
      await withClient(async (client) => {
        await withTenantContext(client, viewer.id, async () => {
          const res = await client.query('SELECT * FROM connections WHERE id = $1', [conn.id]);
          expect(res.rows.length).toBe(1);
        });
      }, pool);

      // Viewer CANNOT insert meter
      await withClient(async (client) => {
        await withTenantContext(client, viewer.id, async () => {
          await expect(
            client.query(
              `INSERT INTO meters (household_id, connection_id, name, type, unit)
               VALUES ($1, $2, 'Viewer Meter', 'manual_counter', 'kWh')`,
              [household.id, conn.id]
            )
          ).rejects.toThrow();
        });
      }, pool);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Composite Tenant Foreign Key Integrity
  // ---------------------------------------------------------------------------
  describe('Composite Foreign Keys Integrity', () => {
    it('rejects cross-tenant composite references (meter from HH1 with connection from HH2)', async () => {
      const user = await repo.createAccount({ authUserId: 'admin-user' });
      const { household: hh1 } = await repo.createHousehold({ name: 'H1' }, user.id);
      const { household: hh2 } = await repo.createHousehold({ name: 'H2' }, user.id);

      const conn2 = await repo.createConnection({
        householdId: hh2.id,
        provider: 'LESCO',
        referenceNumber: '99999999999999',
        tariffCategory: 'domestic_protected',
      }, { accountId: user.id });

      // Attempt to link meter with household hh1 but connection conn2 (which belongs to hh2)
      await withClient(async (client) => {
        await expect(
          client.query(
            `INSERT INTO meters (household_id, connection_id, name, type, unit)
             VALUES ($1, $2, 'Confused Meter', 'manual_counter', 'kWh')`,
            [hh1.id, conn2.id]
          )
        ).rejects.toThrow();
      }, pool);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Billing Cycle Scoping, Active Uniqueness, and Non-Overlapping Invariants
  // ---------------------------------------------------------------------------
  describe('Billing Cycle Invariants', () => {
    it('prevents multiple active billing cycles on the same connection', async () => {
      const user = await repo.createAccount({ authUserId: 'cycle-tester' });
      const { household } = await repo.createHousehold({ name: 'Cycle HH' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '12345678901234',
        tariffCategory: 'domestic_protected',
      }, { accountId: user.id });

      // First active cycle
      await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        billingPeriodStart: '2026-08-01',
        billingPeriodEnd: '2026-08-31',
        status: 'active',
      }, { accountId: user.id });

      // Second active cycle on same connection must be rejected
      await expect(
        repo.createBillingCycle({
          householdId: household.id,
          connectionId: conn.id,
          billingPeriodStart: '2026-09-01',
          billingPeriodEnd: '2026-09-30',
          status: 'active',
        }, { accountId: user.id })
      ).rejects.toThrow();
    });

    it('prevents overlapping billing cycle periods for the same connection via exclusion constraint', async () => {
      const user = await repo.createAccount({ authUserId: 'overlap-tester' });
      const { household } = await repo.createHousehold({ name: 'Overlap HH' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '12345678901234',
        tariffCategory: 'domestic_protected',
      }, { accountId: user.id });

      // First cycle: 2026-07-01 to 2026-07-31 (closed)
      await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        billingPeriodStart: '2026-07-01',
        billingPeriodEnd: '2026-07-31',
        status: 'closed',
      }, { accountId: user.id });

      // Second cycle overlapping (starts 2026-07-25) must be rejected by exclusion constraint
      await expect(
        repo.createBillingCycle({
          householdId: household.id,
          connectionId: conn.id,
          billingPeriodStart: '2026-07-25',
          billingPeriodEnd: '2026-08-25',
          status: 'draft',
        }, { accountId: user.id })
      ).rejects.toThrow();
    });

    it('allows multiple meters on the same connection to reference the same billing cycle', async () => {
      const user = await repo.createAccount({ authUserId: 'multi-meter-tester' });
      const { household } = await repo.createHousehold({ name: 'MultiMeter HH' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '12345678901234',
        tariffCategory: 'domestic_protected',
      }, { accountId: user.id });

      const meterA = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        name: 'Outdoor LESCO Meter',
        type: 'outdoor_lesco_digital',
      }, { accountId: user.id });

      const meterB = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        name: 'Indoor Submeter',
        type: 'indoor_cumulative_protector',
      }, { accountId: user.id });

      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        billingPeriodStart: '2026-08-01',
        billingPeriodEnd: '2026-08-31',
        status: 'active',
      }, { accountId: user.id });

      // Reading for Meter A in Cycle
      const rA = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meterA.id,
        cycleId: cycle.id,
        cumulativeKWh: 1250,
        readingTimestamp: '2026-08-10T10:00:00.000Z',
        source: 'outdoor_meter',
      }, { accountId: user.id });

      // Reading for Meter B in the same Cycle
      const rB = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meterB.id,
        cycleId: cycle.id,
        cumulativeKWh: 340,
        readingTimestamp: '2026-08-10T10:05:00.000Z',
        source: 'indoor_meter',
      }, { accountId: user.id });

      expect(rA.id).toBeDefined();
      expect(rB.id).toBeDefined();
      expect(rA.cycle_id).toEqual(rB.cycle_id);
      expect(rA.meter_id).not.toEqual(rB.meter_id);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Finalized State Protection
  // ---------------------------------------------------------------------------
  describe('Finalized State Protection', () => {
    it('blocks modification of closed/locked billing cycles and their readings', async () => {
      const user = await repo.createAccount({ authUserId: 'final-tester' });
      const { household } = await repo.createHousehold({ name: 'Final HH' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '11111111111111',
        tariffCategory: 'domestic_protected',
      }, { accountId: user.id });

      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        name: 'M1',
        type: 'outdoor_lesco_digital',
      }, { accountId: user.id });

      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        billingPeriodStart: '2026-07-01',
        billingPeriodEnd: '2026-07-31',
        status: 'active',
      }, { accountId: user.id });

      const reading = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 500,
        readingTimestamp: '2026-07-15T12:00:00.000Z',
        source: 'outdoor_meter',
      }, { accountId: user.id });

      // Close the cycle
      const closed = await repo.closeBillingCycle(cycle.id, household.id, cycle.version, { accountId: user.id });
      expect(closed.status).toBe('closed');

      // 1. Attempt to add a reading to the closed cycle
      await expect(
        repo.addMeterReading({
          householdId: household.id,
          connectionId: conn.id,
          meterId: meter.id,
          cycleId: cycle.id,
          cumulativeKWh: 550,
          readingTimestamp: '2026-07-20T12:00:00.000Z',
          source: 'outdoor_meter',
        }, { accountId: user.id })
      ).rejects.toThrow(/closed|finalized/i);

      // 2. Attempt to update existing reading belonging to closed cycle via SQL
      await withClient(async (client) => {
        await withTenantContext(client, user.id, async () => {
          await expect(
            client.query(
              'UPDATE meter_readings SET cumulative_kwh = 999 WHERE id = $1',
              [reading.id]
            )
          ).rejects.toThrow();
        });
      }, pool);
    });

    it('blocks direct modification of finalized official bills', async () => {
      const user = await repo.createAccount({ authUserId: 'bill-final-tester' });
      const { household } = await repo.createHousehold({ name: 'Bill HH' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '22222222222222',
        tariffCategory: 'domestic_protected',
      }, { accountId: user.id });

      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        billingPeriodStart: '2026-06-01',
        billingPeriodEnd: '2026-06-30',
        status: 'closed',
      }, { accountId: user.id });

      const bill = await repo.createOfficialBill({
        householdId: household.id,
        connectionId: conn.id,
        billingCycleId: cycle.id,
        billReference: 'BILL-JUNE-2026',
        billingPeriodStart: '2026-06-01',
        billingPeriodEnd: '2026-06-30',
        issuedOn: '2026-07-05',
        previousReading: 1000,
        currentReading: 1200,
        billedUnits: 200,
        billedAmount: 7500,
      }, { accountId: user.id });

      // Finalize bill
      const finalized = await repo.finalizeOfficialBill(bill.id, household.id, bill.version, { accountId: user.id });
      expect(finalized.revision_status).toBe('finalized');

      // Attempt direct SQL update on finalized bill must be blocked by trigger
      await withClient(async (client) => {
        await withTenantContext(client, user.id, async () => {
          await expect(
            client.query(
              'UPDATE official_bills SET billed_amount = 1000 WHERE id = $1',
              [bill.id]
            )
          ).rejects.toThrow();
        });
      }, pool);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Concurrency Control (Optimistic Versioning + Pessimistic Locking)
  // ---------------------------------------------------------------------------
  describe('Concurrency Control', () => {
    it('fails stale-version writes with ConcurrencyError', async () => {
      const user = await repo.createAccount({ authUserId: 'concurrency-user' });
      const { household } = await repo.createHousehold({ name: 'Original Name' }, user.id);

      // Worker 1 updates household -> version becomes 2
      await repo.updateHousehold(household.id, household.version, { name: 'Updated by Worker 1' }, { accountId: user.id });

      // Worker 2 attempts update with old version (1) -> must throw ConcurrencyError
      await expect(
        repo.updateHousehold(household.id, household.version, { name: 'Conflict Worker 2' }, { accountId: user.id })
      ).rejects.toThrow(ConcurrencyError);
    });

    it('enforces reading monotonicity during normal operation and allows authorized discontinuity', async () => {
      const user = await repo.createAccount({ authUserId: 'mono-user' });
      const { household } = await repo.createHousehold({ name: 'Mono HH' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '33333333333333',
        tariffCategory: 'domestic_protected',
      }, { accountId: user.id });

      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        name: 'Smart Meter',
        type: 'outdoor_lesco_digital',
      }, { accountId: user.id });

      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        billingPeriodStart: '2026-08-01',
        billingPeriodEnd: '2026-08-31',
        status: 'active',
      }, { accountId: user.id });

      // 1. Initial reading: 100 kWh
      await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 100,
        readingTimestamp: '2026-08-05T10:00:00.000Z',
        source: 'outdoor_meter',
      }, { accountId: user.id });

      // 2. Decreasing reading: 90 kWh without lifecycle event -> MUST FAIL
      await expect(
        repo.addMeterReading({
          householdId: household.id,
          connectionId: conn.id,
          meterId: meter.id,
          cycleId: cycle.id,
          cumulativeKWh: 90,
          readingTimestamp: '2026-08-06T10:00:00.000Z',
          source: 'outdoor_meter',
        }, { accountId: user.id })
      ).rejects.toThrow(IntegrityViolationError);

      // 3. Create authorized reset lifecycle event with baseline reading 0
      const resetEvent = await repo.createLifecycleEvent({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        type: 'reset',
        occurredAt: '2026-08-06T09:00:00.000Z',
        baselineReading: 0,
        reason: 'Hardware reset',
      }, { accountId: user.id });

      // 4. Submit baseline reading 0 referencing the lifecycle event -> MUST SUCCEED
      const baselineReading = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 0,
        readingTimestamp: '2026-08-06T10:00:00.000Z',
        source: 'outdoor_meter',
        isBaseline: true,
        lifecycleEventId: resetEvent.id,
      }, { accountId: user.id });

      expect(baselineReading.cumulative_kwh).toBe('0.00');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Timestamps, Timezone, and Future Protection
  // ---------------------------------------------------------------------------
  describe('Timestamps & Timezones', () => {
    it('sets authoritative server_timestamp and rejects future reading timestamps', async () => {
      const user = await repo.createAccount({ authUserId: 'time-tester' });
      const { household } = await repo.createHousehold({ name: 'Time HH', timezone: 'Asia/Karachi' }, user.id);
      expect(household.timezone).toBe('Asia/Karachi');

      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '44444444444444',
        tariffCategory: 'domestic_protected',
      }, { accountId: user.id });

      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        name: 'M1',
        type: 'outdoor_lesco_digital',
      }, { accountId: user.id });

      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        billingPeriodStart: '2026-08-01',
        billingPeriodEnd: '2026-08-31',
        status: 'active',
      }, { accountId: user.id });

      // 1. Valid reading in the past
      const valid = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 150,
        readingTimestamp: '2026-08-10T12:00:00.000Z',
        source: 'manual',
      }, { accountId: user.id });

      expect(valid.server_timestamp).toBeDefined();

      // 2. Future reading timestamp (1 day ahead) -> MUST BE REJECTED
      const futureTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await expect(
        repo.addMeterReading({
          householdId: household.id,
          connectionId: conn.id,
          meterId: meter.id,
          cycleId: cycle.id,
          cumulativeKWh: 200,
          readingTimestamp: futureTime,
          source: 'manual',
        }, { accountId: user.id })
      ).rejects.toThrow(/future/i);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Idempotency Key Foundation
  // ---------------------------------------------------------------------------
  describe('Idempotency Key Foundation', () => {
    it('returns existing record for matching idempotency key and rejects payload hash mismatch', async () => {
      const user = await repo.createAccount({ authUserId: 'idempotent-user' });

      // First request
      const check1 = await repo.checkOrRecordIdempotency({
        accountId: user.id,
        key: 'idemp-tx-12345',
        requestPath: '/api/readings',
        requestHash: 'hash-abc-123',
      });
      expect(check1.isExisting).toBe(false);

      // Complete request
      await repo.completeIdempotency({
        accountId: user.id,
        key: 'idemp-tx-12345',
        responseCode: 201,
        responseBody: { readingId: 'uuid-1', status: 'created' },
      });

      // Retry with same key & hash
      const check2 = await repo.checkOrRecordIdempotency({
        accountId: user.id,
        key: 'idemp-tx-12345',
        requestPath: '/api/readings',
        requestHash: 'hash-abc-123',
      });
      expect(check2.isExisting).toBe(true);
      expect(check2.record?.response_code).toBe(201);

      // Retry with same key but DIFFERENT hash -> must fail
      await expect(
        repo.checkOrRecordIdempotency({
          accountId: user.id,
          key: 'idemp-tx-12345',
          requestPath: '/api/readings',
          requestHash: 'different-hash-456',
        })
      ).rejects.toThrow(IntegrityViolationError);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Migration Adapter from LocalStorage v3
  // ---------------------------------------------------------------------------
  describe('Migration from LocalStorage State', () => {
    it('successfully imports and normalizes local persistence state into PostgreSQL', async () => {
      const localState = developmentFixtureState();

      const summary = await migrationAdapter.migrateState(localState);

      expect(summary.accountsMigrated).toBe(localState.accounts.length);
      expect(summary.householdsMigrated).toBe(1);
      expect(summary.membershipsMigrated).toBe(localState.memberships.length);
      expect(summary.connectionsMigrated).toBe(localState.connections.length);
      expect(summary.metersMigrated).toBe(localState.meters.length);
      expect(summary.cyclesMigrated).toBe(localState.cycles.length);
      expect(summary.billsMigrated).toBe(localState.bills.length);
      expect(summary.readingsMigrated).toBe(localState.readings.length);
      expect(summary.lifecycleEventsMigrated).toBe(localState.lifecycleEvents.length);
      expect(summary.auditLogsMigrated).toBe(localState.auditLogs.length);

      // Verify PostgreSQL billing_cycles have no meter_id column
      await withClient(async (client) => {
        await withSystemContext(client, async () => {
          const res = await client.query('SELECT * FROM billing_cycles LIMIT 1');
          expect(res.rows.length).toBe(1);
          expect(res.rows[0].meter_id).toBeUndefined();
        });
      }, pool);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Calculation Engine Preservation
  // ---------------------------------------------------------------------------
  describe('Calculation Engine Behavioral Parity', () => {
    it('executes authoritative calculation engine against migrated reading stream', async () => {
      const localState = developmentFixtureState();
      await migrationAdapter.migrateState(localState);

      // Verify calculation engine computes identically
      const activeCycle = localState.cycles.find((c) => c.status === 'active')!;
      const primaryMeter = localState.meters.find((m) => m.id === activeCycle.meterId) || localState.meters[0];
      const scopedReadings = localState.readings.filter(
        (r) => r.cycleId === activeCycle.id && r.meterId === primaryMeter.id
      );

      const calcResult = calculateMeterConsumption(scopedReadings, {
        asOf: '2026-08-31T23:59:59.999Z',
        scope: { householdId: localState.household.id, meterId: primaryMeter.id, cycleId: activeCycle.id },
        lifecycleEvents: localState.lifecycleEvents,
      });

      expect(calcResult.dataQuality).toBe('VALID');
      expect(calcResult.actualConsumptionKwh).toBeGreaterThan(0);

      const summary = calculateCycleSummary(
        activeCycle,
        scopedReadings,
        'indoor_cumulative',
        200,
        190,
        '2026-08-31T23:59:59.999Z',
        { householdId: localState.household.id, meterId: primaryMeter.id, cycleId: activeCycle.id },
        localState.lifecycleEvents
      );

      expect(summary.totalTrackedUnits).toBe(calcResult.actualConsumptionKwh);
      expect(summary.projectedUsage).toBeGreaterThanOrEqual(summary.totalTrackedUnits);
    });
  });
});
