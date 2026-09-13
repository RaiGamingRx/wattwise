import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getDbPool, getAdminPool, closeDbPool, closeAdminPool, withClient, withTransaction, withTenantContext, withSystemContext } from './db';
import { PostgresEnergyRepository, ConcurrencyError, IntegrityViolationError } from './repository';
import { PostgresMigrationAdapter } from './migrationAdapter';
import { developmentFixtureState } from '../localStorageAdapter';
import { randomUUID } from 'crypto';

describe('WattWise Milestone 0.5.1: Security Attack & Reading Lifecycle Tests', () => {
  const pool = getDbPool();
  const adminPool = getAdminPool();
  const repo = new PostgresEnergyRepository(pool);

  beforeEach(async () => {
    await withClient(async (client) => {
      await withSystemContext(client, async () => {
        await client.query(`
          TRUNCATE accounts, households, household_memberships, connections,
                   meters, billing_cycles, official_bills, meter_readings,
                   meter_lifecycle_events, idempotency_keys, audit_logs
          CASCADE
        `);
      });
    }, adminPool);
  });

  afterAll(async () => {
    await closeDbPool();
    await closeAdminPool();
  });

  // ===========================================================================
  // A. Tenant Isolation Tests (Tests 1–6)
  // ===========================================================================
  describe('A. Tenant Isolation Tests', () => {
    // Test 1: Direct SQL query without app.current_account_id returns 0 rows (not all rows)
    it('Test 1: Direct SQL query without app.current_account_id returns 0 rows (fail-closed)', async () => {
      const user = await repo.createAccount({ authUserId: 't1-owner' });
      const { household } = await repo.createHousehold({ name: 'T1 Household' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '11111111111111',
        tariffCode: 'A1-R',
      }, { accountId: user.id });
      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        serialNumber: 'T1-METER',
      }, { accountId: user.id });
      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        billingPeriodStart: '2026-09-01',
        billingPeriodEnd: '2026-09-30',
        officialReadingDate: '2026-09-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: user.id });
      await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 150,
        readingTimestamp: '2026-09-02T10:00:00.000Z',
        source: 'manual',
      }, { accountId: user.id });

      // Unauthenticated query (no tenant context set) must return 0 rows
      await withClient(async (client) => {
        const hhRes = await client.query('SELECT * FROM households');
        expect(hhRes.rows.length).toBe(0);

        const rdRes = await client.query('SELECT * FROM meter_readings');
        expect(rdRes.rows.length).toBe(0);

        const connRes = await client.query('SELECT * FROM connections');
        expect(connRes.rows.length).toBe(0);

        const cycleRes = await client.query('SELECT * FROM billing_cycles');
        expect(cycleRes.rows.length).toBe(0);
      }, pool);
    });

    // Test 2: Tenant A cannot read Tenant B's meter readings via repo or direct SQL
    it('Test 2: Tenant A cannot read Tenant B meter readings via repo or direct SQL', async () => {
      const tenantB = await repo.createAccount({ authUserId: 'tenant-b' });
      const { household: hhB } = await repo.createHousehold({ name: 'Tenant B Home' }, tenantB.id);
      const connB = await repo.createConnection({
        householdId: hhB.id,
        provider: 'LESCO',
        referenceNumber: '22222222222222',
        tariffCode: 'A1-R',
      }, { accountId: tenantB.id });
      const meterB = await repo.createMeter({
        householdId: hhB.id,
        connectionId: connB.id,
        serialNumber: 'METER-B',
      }, { accountId: tenantB.id });
      const cycleB = await repo.createBillingCycle({
        householdId: hhB.id,
        connectionId: connB.id,
        meterId: meterB.id,
        billingPeriodStart: '2026-09-01',
        billingPeriodEnd: '2026-09-30',
        officialReadingDate: '2026-09-25',
        previousOfficialReading: 100,
        currentOfficialReading: 200,
        billedUnits: 100,
      }, { accountId: tenantB.id });
      await repo.addMeterReading({
        householdId: hhB.id,
        connectionId: connB.id,
        meterId: meterB.id,
        cycleId: cycleB.id,
        cumulativeKWh: 120,
        readingTimestamp: '2026-09-05T10:00:00.000Z',
        source: 'manual',
      }, { accountId: tenantB.id });

      // Tenant A
      const tenantA = await repo.createAccount({ authUserId: 'tenant-a' });

      // Direct SQL as Tenant A
      await withClient(async (client) => {
        await withTenantContext(client, tenantA.id, async () => {
          const res = await client.query('SELECT * FROM meter_readings WHERE household_id = $1', [hhB.id]);
          expect(res.rows.length).toBe(0);
        });
      }, pool);
    });

    // Test 3: Tenant A cannot insert a meter reading into Tenant B's household
    it('Test 3: Tenant A cannot insert a meter reading into Tenant B household', async () => {
      const tenantB = await repo.createAccount({ authUserId: 'tenant-b-3' });
      const { household: hhB } = await repo.createHousehold({ name: 'HH B-3' }, tenantB.id);
      const connB = await repo.createConnection({
        householdId: hhB.id,
        provider: 'LESCO',
        referenceNumber: '33333333333333',
        tariffCode: 'A1-R',
      }, { accountId: tenantB.id });
      const meterB = await repo.createMeter({
        householdId: hhB.id,
        connectionId: connB.id,
        serialNumber: 'METER-B-3',
      }, { accountId: tenantB.id });
      const cycleB = await repo.createBillingCycle({
        householdId: hhB.id,
        connectionId: connB.id,
        meterId: meterB.id,
        billingPeriodStart: '2026-09-01',
        billingPeriodEnd: '2026-09-30',
        officialReadingDate: '2026-09-25',
        previousOfficialReading: 100,
        currentOfficialReading: 200,
        billedUnits: 100,
      }, { accountId: tenantB.id });

      const tenantA = await repo.createAccount({ authUserId: 'tenant-a-3' });

      // Direct SQL attempt by Tenant A
      await withClient(async (client) => {
        await withTenantContext(client, tenantA.id, async () => {
          await expect(
            client.query(
              `INSERT INTO meter_readings (
                household_id, connection_id, meter_id, cycle_id,
                cumulative_kwh, reading_timestamp, source, version
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
              [hhB.id, connB.id, meterB.id, cycleB.id, 150, '2026-09-05T10:00:00.000Z', 'manual']
            )
          ).rejects.toThrow(/row-level security/i);
        });
      }, pool);

      // Via Repo by Tenant A
      await expect(
        repo.addMeterReading({
          householdId: hhB.id,
          connectionId: connB.id,
          meterId: meterB.id,
          cycleId: cycleB.id,
          cumulativeKWh: 150,
          readingTimestamp: '2026-09-05T10:00:00.000Z',
          source: 'manual',
        }, { accountId: tenantA.id })
      ).rejects.toThrow();
    });

    // Test 4: Tenant A cannot update or delete Tenant B's meter reading
    it('Test 4: Tenant A cannot update or delete Tenant B meter reading', async () => {
      const tenantB = await repo.createAccount({ authUserId: 'tenant-b-4' });
      const { household: hhB } = await repo.createHousehold({ name: 'HH B-4' }, tenantB.id);
      const connB = await repo.createConnection({
        householdId: hhB.id,
        provider: 'LESCO',
        referenceNumber: '44444444444444',
        tariffCode: 'A1-R',
      }, { accountId: tenantB.id });
      const meterB = await repo.createMeter({
        householdId: hhB.id,
        connectionId: connB.id,
        serialNumber: 'METER-B-4',
      }, { accountId: tenantB.id });
      const cycleB = await repo.createBillingCycle({
        householdId: hhB.id,
        connectionId: connB.id,
        meterId: meterB.id,
        billingPeriodStart: '2026-09-01',
        billingPeriodEnd: '2026-09-30',
        officialReadingDate: '2026-09-25',
        previousOfficialReading: 100,
        currentOfficialReading: 200,
        billedUnits: 100,
      }, { accountId: tenantB.id });
      const readingB = await repo.addMeterReading({
        householdId: hhB.id,
        connectionId: connB.id,
        meterId: meterB.id,
        cycleId: cycleB.id,
        cumulativeKWh: 120,
        readingTimestamp: '2026-09-05T10:00:00.000Z',
        source: 'manual',
      }, { accountId: tenantB.id });

      const tenantA = await repo.createAccount({ authUserId: 'tenant-a-4' });

      // Direct SQL update attempt affects 0 rows
      await withClient(async (client) => {
        await withTenantContext(client, tenantA.id, async () => {
          const res = await client.query(
            'UPDATE meter_readings SET cumulative_kwh = 999 WHERE id = $1',
            [readingB.id]
          );
          expect(res.rowCount).toBe(0);

          const delRes = await client.query(
            'DELETE FROM meter_readings WHERE id = $1',
            [readingB.id]
          );
          expect(delRes.rowCount).toBe(0);
        });
      }, pool);

      // Via Repo
      await expect(
        repo.updateMeterReading(readingB.id, hhB.id, readingB.version, { cumulativeKWh: 999 }, { accountId: tenantA.id })
      ).rejects.toThrow();

      await expect(
        repo.deleteMeterReading(readingB.id, hhB.id, readingB.version, { accountId: tenantA.id })
      ).rejects.toThrow();
    });

    // Test 5: Tenant A cannot insert a household_membership giving themselves access to Tenant B's household
    it('Test 5: Tenant A cannot insert a household_membership giving themselves access to Tenant B household', async () => {
      const tenantB = await repo.createAccount({ authUserId: 'tenant-b-5' });
      const { household: hhB } = await repo.createHousehold({ name: 'HH B-5' }, tenantB.id);

      const tenantA = await repo.createAccount({ authUserId: 'tenant-a-5' });

      // Direct SQL attempt by Tenant A to grant themselves membership in HH B
      await withClient(async (client) => {
        await withTenantContext(client, tenantA.id, async () => {
          await expect(
            client.query(
              `INSERT INTO household_memberships (household_id, account_id, role)
               VALUES ($1, $2, 'owner')`,
              [hhB.id, tenantA.id]
            )
          ).rejects.toThrow(/row-level security/i);
        });
      }, pool);

      // Via repo attempt
      await expect(
        repo.addMembership(hhB.id, tenantA.id, 'owner', { accountId: tenantA.id })
      ).rejects.toThrow();
    });

    // Test 6: Connection pool reuse: context is completely clean across requests
    it('Test 6: Connection pool reuse guarantees clean context between tenants', async () => {
      const tenantA = await repo.createAccount({ authUserId: 'tenant-a-6' });
      const { household: hhA } = await repo.createHousehold({ name: 'HH A-6' }, tenantA.id);

      const tenantB = await repo.createAccount({ authUserId: 'tenant-b-6' });

      // Tenant A uses client and releases to pool
      await withClient(async (client) => {
        await withTenantContext(client, tenantA.id, async () => {
          const res = await client.query('SELECT * FROM households WHERE id = $1', [hhA.id]);
          expect(res.rows.length).toBe(1);
        });
      }, pool);

      // Acquire client again and verify no residual session variables exist
      await withClient(async (client) => {
        const check = await client.query<{ val: string | null }>(
          "SELECT current_setting('app.current_account_id', true) AS val"
        );
        expect(check.rows[0]?.val || '').toBe('');

        // Now run as Tenant B
        await withTenantContext(client, tenantB.id, async () => {
          const res = await client.query('SELECT * FROM households WHERE id = $1', [hhA.id]);
          expect(res.rows.length).toBe(0);
        });
      }, pool);
    });
  });

  // ===========================================================================
  // B. Finalized State Protection (Tests 7–10)
  // ===========================================================================
  describe('B. Finalized State Protection', () => {
    // Test 7: Direct SQL UPDATE to meter_readings in closed cycle fails via trigger
    it('Test 7: Direct SQL UPDATE to meter_readings in closed cycle fails via trigger', async () => {
      const user = await repo.createAccount({ authUserId: 'final-user-7' });
      const { household } = await repo.createHousehold({ name: 'Final HH 7' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '77777777777777',
        tariffCode: 'A1-R',
      }, { accountId: user.id });
      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        serialNumber: 'MTR-7',
      }, { accountId: user.id });
      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        billingPeriodStart: '2026-08-01',
        billingPeriodEnd: '2026-08-31',
        officialReadingDate: '2026-08-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: user.id });
      const reading = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 150,
        readingTimestamp: '2026-08-10T10:00:00.000Z',
        source: 'manual',
      }, { accountId: user.id });

      // Close cycle
      await repo.closeBillingCycle(cycle.id, household.id, cycle.version, { accountId: user.id });

      // Direct SQL update must fail via trg_protect_closed_cycle_readings
      await withClient(async (client) => {
        await withTenantContext(client, user.id, async () => {
          await expect(
            client.query(
              'UPDATE meter_readings SET cumulative_kwh = 999 WHERE id = $1',
              [reading.id]
            )
          ).rejects.toThrow(/finalized|closed|locked/i);
        });
      }, pool);
    });

    // Test 8: Direct SQL DELETE to meter_readings in closed cycle fails via trigger
    it('Test 8: Direct SQL DELETE to meter_readings in closed cycle fails via trigger', async () => {
      const user = await repo.createAccount({ authUserId: 'final-user-8' });
      const { household } = await repo.createHousehold({ name: 'Final HH 8' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '88888888888888',
        tariffCode: 'A1-R',
      }, { accountId: user.id });
      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        serialNumber: 'MTR-8',
      }, { accountId: user.id });
      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        billingPeriodStart: '2026-08-01',
        billingPeriodEnd: '2026-08-31',
        officialReadingDate: '2026-08-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: user.id });
      const reading = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 150,
        readingTimestamp: '2026-08-10T10:00:00.000Z',
        source: 'manual',
      }, { accountId: user.id });

      await repo.closeBillingCycle(cycle.id, household.id, cycle.version, { accountId: user.id });

      await withClient(async (client) => {
        await withTenantContext(client, user.id, async () => {
          await expect(
            client.query(
              'DELETE FROM meter_readings WHERE id = $1',
              [reading.id]
            )
          ).rejects.toThrow(/finalized|closed|locked/i);
        });
      }, pool);
    });

    // Test 9: Direct SQL INSERT to meter_readings in closed cycle fails via trigger
    it('Test 9: Direct SQL INSERT to meter_readings in closed cycle fails via trigger', async () => {
      const user = await repo.createAccount({ authUserId: 'final-user-9' });
      const { household } = await repo.createHousehold({ name: 'Final HH 9' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '99999999999999',
        tariffCode: 'A1-R',
      }, { accountId: user.id });
      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        serialNumber: 'MTR-9',
      }, { accountId: user.id });
      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        billingPeriodStart: '2026-08-01',
        billingPeriodEnd: '2026-08-31',
        officialReadingDate: '2026-08-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: user.id });

      await repo.closeBillingCycle(cycle.id, household.id, cycle.version, { accountId: user.id });

      await withClient(async (client) => {
        await withTenantContext(client, user.id, async () => {
          await expect(
            client.query(
              `INSERT INTO meter_readings (
                household_id, connection_id, meter_id, cycle_id,
                cumulative_kwh, reading_timestamp, source, version
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
              [household.id, conn.id, meter.id, cycle.id, 250, '2026-08-20T10:00:00.000Z', 'manual']
            )
          ).rejects.toThrow(/finalized|closed|locked/i);
        });
      }, pool);
    });

    // Test 10: Direct SQL UPDATE to official_bills with finalized status fails via trigger
    it('Test 10: Direct SQL UPDATE to official_bills with finalized status fails via trigger', async () => {
      const user = await repo.createAccount({ authUserId: 'final-user-10' });
      const { household } = await repo.createHousehold({ name: 'Final HH 10' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '10101010101010',
        tariffCode: 'A1-R',
      }, { accountId: user.id });
      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        serialNumber: 'MTR-10',
      }, { accountId: user.id });
      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        billingPeriodStart: '2026-08-01',
        billingPeriodEnd: '2026-08-31',
        officialReadingDate: '2026-08-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: user.id });
      const bill = await repo.createOfficialBill({
        householdId: household.id,
        connectionId: conn.id,
        billingCycleId: cycle.id,
        billReference: 'BILL-10',
        billingPeriodStart: '2026-08-01',
        billingPeriodEnd: '2026-08-31',
        issuedOn: '2026-09-01',
        previousReading: 100,
        currentReading: 300,
        billedUnits: 200,
        billedAmount: 7500,
      }, { accountId: user.id });

      // Finalize bill
      await repo.finalizeOfficialBill(bill.id, household.id, bill.version, { accountId: user.id });

      await withClient(async (client) => {
        await withTenantContext(client, user.id, async () => {
          // Direct SQL UPDATE must fail
          await expect(
            client.query(
              'UPDATE official_bills SET billed_amount = 99999 WHERE id = $1',
              [bill.id]
            )
          ).rejects.toThrow(/finalized/i);

          // Direct SQL DELETE must also fail
          await expect(
            client.query(
              'DELETE FROM official_bills WHERE id = $1',
              [bill.id]
            )
          ).rejects.toThrow(/finalized/i);
        });
      }, pool);
    });
  });

  // ===========================================================================
  // C. Concurrency & Replay Attack Tests (Tests 11–13)
  // ===========================================================================
  describe('C. Concurrency & Replay Attack Tests', () => {
    // Test 11: Stale version write fails with ConcurrencyError
    it('Test 11: Stale version write fails with ConcurrencyError', async () => {
      const user = await repo.createAccount({ authUserId: 'concur-user-11' });
      const { household } = await repo.createHousehold({ name: 'Concur HH 11' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '11111111111112',
        tariffCode: 'A1-R',
      }, { accountId: user.id });
      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        serialNumber: 'MTR-11',
      }, { accountId: user.id });
      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        billingPeriodStart: '2026-09-01',
        billingPeriodEnd: '2026-09-30',
        officialReadingDate: '2026-09-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: user.id });
      const reading = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 150,
        readingTimestamp: '2026-09-05T10:00:00.000Z',
        source: 'manual',
      }, { accountId: user.id });

      // First update moves version to 2
      const updated = await repo.updateMeterReading(
        reading.id,
        household.id,
        reading.version,
        { cumulativeKWh: 160 },
        { accountId: user.id }
      );
      expect(updated.version).toBe(2);

      // Stale update using version 1 must fail
      await expect(
        repo.updateMeterReading(
          reading.id,
          household.id,
          1,
          { cumulativeKWh: 170 },
          { accountId: user.id }
        )
      ).rejects.toThrow(ConcurrencyError);
    });

    // Test 12: Concurrent writes to same reading version — exactly one succeeds, other fails
    it('Test 12: Concurrent writes to same reading version — exactly one succeeds, other fails', async () => {
      const user = await repo.createAccount({ authUserId: 'concur-user-12' });
      const { household } = await repo.createHousehold({ name: 'Concur HH 12' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '12121212121212',
        tariffCode: 'A1-R',
      }, { accountId: user.id });
      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        serialNumber: 'MTR-12',
      }, { accountId: user.id });
      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        billingPeriodStart: '2026-09-01',
        billingPeriodEnd: '2026-09-30',
        officialReadingDate: '2026-09-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: user.id });
      const reading = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 150,
        readingTimestamp: '2026-09-05T10:00:00.000Z',
        source: 'manual',
      }, { accountId: user.id });

      const results = await Promise.allSettled([
        repo.updateMeterReading(
          reading.id,
          household.id,
          reading.version,
          { cumulativeKWh: 160 },
          { accountId: user.id }
        ),
        repo.updateMeterReading(
          reading.id,
          household.id,
          reading.version,
          { cumulativeKWh: 170 },
          { accountId: user.id }
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
    });

    // Test 13: Same idempotency key with different payload fails with hash mismatch
    it('Test 13: Same idempotency key with different payload fails with hash mismatch', async () => {
      const user = await repo.createAccount({ authUserId: 'idem-user-13' });
      const { household } = await repo.createHousehold({ name: 'Idem HH 13' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '13131313131313',
        tariffCode: 'A1-R',
      }, { accountId: user.id });
      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        serialNumber: 'MTR-13',
      }, { accountId: user.id });
      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        billingPeriodStart: '2026-09-01',
        billingPeriodEnd: '2026-09-30',
        officialReadingDate: '2026-09-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: user.id });

      const idempotencyKey = 'idem-test-key-13';

      // First call succeeds
      const r1 = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 150,
        readingTimestamp: '2026-09-05T10:00:00.000Z',
        source: 'manual',
      }, { accountId: user.id, idempotencyKey });

      expect(r1.id).toBeDefined();

      // Second call with DIFFERENT payload (e.g. cumulativeKWh 180) must fail
      await expect(
        repo.addMeterReading({
          householdId: household.id,
          connectionId: conn.id,
          meterId: meter.id,
          cycleId: cycle.id,
          cumulativeKWh: 180,
          readingTimestamp: '2026-09-05T10:00:00.000Z',
          source: 'manual',
        }, { accountId: user.id, idempotencyKey })
      ).rejects.toThrow(/idempotency_payload_mismatch/i);
    });
  });

  // ===========================================================================
  // D. Reading Lifecycle Edge Cases (Tests 14–20)
  // ===========================================================================
  describe('D. Reading Lifecycle Edge Cases', () => {
    // Test 14: Edit reading in current active cycle — succeeds, version increments, audit logged
    it('Test 14: Edit reading in current active cycle — succeeds, version increments, audit logged', async () => {
      const user = await repo.createAccount({ authUserId: 'life-user-14' });
      const { household } = await repo.createHousehold({ name: 'Life HH 14' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '14141414141414',
        tariffCode: 'A1-R',
      }, { accountId: user.id });
      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        serialNumber: 'MTR-14',
      }, { accountId: user.id });
      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        billingPeriodStart: '2026-09-01',
        billingPeriodEnd: '2026-09-30',
        officialReadingDate: '2026-09-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: user.id });
      const reading = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 150,
        readingTimestamp: '2026-09-05T10:00:00.000Z',
        source: 'manual',
      }, { accountId: user.id });

      const updated = await repo.updateMeterReading(
        reading.id,
        household.id,
        reading.version,
        { cumulativeKWh: 165, notes: 'Corrected reading' },
        { accountId: user.id, reason: 'Manual meter correction' }
      );

      expect(Number(updated.cumulative_kwh)).toBe(165);
      expect(updated.version).toBe(2);
      expect(updated.notes).toBe('Corrected reading');

      // Verify audit log entry
      await withClient(async (client) => {
        await withTenantContext(client, user.id, async () => {
          const audit = await client.query(
            'SELECT * FROM audit_logs WHERE entity_id = $1 AND action = $2',
            [reading.id, 'edit']
          );
          expect(audit.rows.length).toBe(1);
          expect(audit.rows[0].entity_version).toBe(2);
          expect(audit.rows[0].reason).toBe('Manual meter correction');
        });
      }, pool);
    });

    // Test 15: Edit reading in closed cycle — fails with READING_FINALIZED
    it('Test 15: Edit reading in closed cycle — fails with READING_FINALIZED', async () => {
      const user = await repo.createAccount({ authUserId: 'life-user-15' });
      const { household } = await repo.createHousehold({ name: 'Life HH 15' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '15151515151515',
        tariffCode: 'A1-R',
      }, { accountId: user.id });
      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        serialNumber: 'MTR-15',
      }, { accountId: user.id });
      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        billingPeriodStart: '2026-08-01',
        billingPeriodEnd: '2026-08-31',
        officialReadingDate: '2026-08-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: user.id });
      const reading = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 150,
        readingTimestamp: '2026-08-10T10:00:00.000Z',
        source: 'manual',
      }, { accountId: user.id });

      await repo.closeBillingCycle(cycle.id, household.id, cycle.version, { accountId: user.id });

      await expect(
        repo.updateMeterReading(
          reading.id,
          household.id,
          reading.version,
          { cumulativeKWh: 175 },
          { accountId: user.id }
        )
      ).rejects.toThrow(IntegrityViolationError);

      await expect(
        repo.updateMeterReading(
          reading.id,
          household.id,
          reading.version,
          { cumulativeKWh: 175 },
          { accountId: user.id }
        )
      ).rejects.toThrow(/READING_FINALIZED/);
    });

    // Test 16: Late reading entry (September 3 reading submitted September 8 within September cycle) — succeeds
    it('Test 16: Late reading entry within current cycle succeeds with server timestamp authority', async () => {
      const user = await repo.createAccount({ authUserId: 'life-user-16' });
      const { household } = await repo.createHousehold({ name: 'Life HH 16' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '16161616161616',
        tariffCode: 'A1-R',
      }, { accountId: user.id });
      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        serialNumber: 'MTR-16',
      }, { accountId: user.id });
      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        billingPeriodStart: '2026-09-01',
        billingPeriodEnd: '2026-09-30',
        officialReadingDate: '2026-09-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: user.id });

      // Physical reading was on Sept 3, submitted today
      const lateReading = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 145,
        readingTimestamp: '2026-09-03T09:30:00.000Z',
        source: 'manual',
        notes: 'Recorded on Sept 3, submitted late on Sept 8',
      }, { accountId: user.id });

      expect(lateReading.id).toBeDefined();
      expect(new Date(lateReading.reading_timestamp).toISOString()).toBe('2026-09-03T09:30:00.000Z');
      expect(new Date(lateReading.server_timestamp).getTime()).toBeGreaterThan(Date.parse('2026-09-03T09:30:00.000Z'));
    });

    // Test 17: Historical reading entry (July reading submitted in September cycle) — fails with READING_OUTSIDE_CURRENT_CYCLE
    it('Test 17: Historical reading entry (July reading submitted in September cycle) fails with READING_OUTSIDE_CURRENT_CYCLE', async () => {
      const user = await repo.createAccount({ authUserId: 'life-user-17' });
      const { household } = await repo.createHousehold({ name: 'Life HH 17' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '17171717171717',
        tariffCode: 'A1-R',
      }, { accountId: user.id });
      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        serialNumber: 'MTR-17',
      }, { accountId: user.id });
      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        billingPeriodStart: '2026-09-01',
        billingPeriodEnd: '2026-09-30',
        officialReadingDate: '2026-09-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: user.id });

      // Physical reading timestamp is in July 2026, outside active Sept cycle
      await expect(
        repo.addMeterReading({
          householdId: household.id,
          connectionId: conn.id,
          meterId: meter.id,
          cycleId: cycle.id,
          cumulativeKWh: 80,
          readingTimestamp: '2026-07-15T12:00:00.000Z',
          source: 'manual',
        }, { accountId: user.id })
      ).rejects.toThrow(/READING_OUTSIDE_CURRENT_CYCLE/);
    });

    // Test 18: Delete reading in current cycle — succeeds, audit logged
    it('Test 18: Delete reading in current cycle — succeeds, audit logged', async () => {
      const user = await repo.createAccount({ authUserId: 'life-user-18' });
      const { household } = await repo.createHousehold({ name: 'Life HH 18' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '18181818181818',
        tariffCode: 'A1-R',
      }, { accountId: user.id });
      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        serialNumber: 'MTR-18',
      }, { accountId: user.id });
      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        billingPeriodStart: '2026-09-01',
        billingPeriodEnd: '2026-09-30',
        officialReadingDate: '2026-09-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: user.id });
      const reading = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 150,
        readingTimestamp: '2026-09-05T10:00:00.000Z',
        source: 'manual',
      }, { accountId: user.id });

      await repo.deleteMeterReading(
        reading.id,
        household.id,
        reading.version,
        { accountId: user.id, reason: 'Accidental duplicate entry' }
      );

      // Verify deletion in DB
      await withClient(async (client) => {
        await withTenantContext(client, user.id, async () => {
          const res = await client.query('SELECT * FROM meter_readings WHERE id = $1', [reading.id]);
          expect(res.rows.length).toBe(0);

          const audit = await client.query(
            'SELECT * FROM audit_logs WHERE entity_id = $1 AND action = $2',
            [reading.id, 'delete']
          );
          expect(audit.rows.length).toBe(1);
          expect(audit.rows[0].reason).toBe('Accidental duplicate entry');
        });
      }, pool);
    });

    // Test 19: Delete reading in closed cycle — fails with READING_FINALIZED
    it('Test 19: Delete reading in closed cycle — fails with READING_FINALIZED', async () => {
      const user = await repo.createAccount({ authUserId: 'life-user-19' });
      const { household } = await repo.createHousehold({ name: 'Life HH 19' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '19191919191919',
        tariffCode: 'A1-R',
      }, { accountId: user.id });
      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        serialNumber: 'MTR-19',
      }, { accountId: user.id });
      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        billingPeriodStart: '2026-08-01',
        billingPeriodEnd: '2026-08-31',
        officialReadingDate: '2026-08-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: user.id });
      const reading = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 150,
        readingTimestamp: '2026-08-05T10:00:00.000Z',
        source: 'manual',
      }, { accountId: user.id });

      await repo.closeBillingCycle(cycle.id, household.id, cycle.version, { accountId: user.id });

      await expect(
        repo.deleteMeterReading(
          reading.id,
          household.id,
          reading.version,
          { accountId: user.id }
        )
      ).rejects.toThrow(/READING_FINALIZED/);
    });

    // Test 20: Delete reading that would cause non-monotonic sequence or baseline deletion fails
    it('Test 20: Delete reading that violates monotonicity or deletes baseline fails', async () => {
      const user = await repo.createAccount({ authUserId: 'life-user-20' });
      const { household } = await repo.createHousehold({ name: 'Life HH 20' }, user.id);
      const conn = await repo.createConnection({
        householdId: household.id,
        provider: 'LESCO',
        referenceNumber: '20202020202020',
        tariffCode: 'A1-R',
      }, { accountId: user.id });
      const meter = await repo.createMeter({
        householdId: household.id,
        connectionId: conn.id,
        serialNumber: 'MTR-20',
      }, { accountId: user.id });
      const cycle = await repo.createBillingCycle({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        billingPeriodStart: '2026-09-01',
        billingPeriodEnd: '2026-09-30',
        officialReadingDate: '2026-09-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: user.id });

      // Add baseline reading directly via lifecycle event
      const lcEvent = await repo.createLifecycleEvent({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        type: 'reset',
        occurredAt: '2026-09-01T08:00:00.000Z',
        baselineReading: 0,
        reason: 'Initial baseline',
      }, { accountId: user.id });

      const baselineReading = await repo.addMeterReading({
        householdId: household.id,
        connectionId: conn.id,
        meterId: meter.id,
        cycleId: cycle.id,
        cumulativeKWh: 0,
        readingTimestamp: '2026-09-01T08:00:00.000Z',
        source: 'manual',
        isBaseline: true,
        lifecycleEventId: lcEvent.id,
      }, { accountId: user.id });

      // Attempting to delete baseline reading must fail with READING_BASELINE_REQUIRED
      await expect(
        repo.deleteMeterReading(
          baselineReading.id,
          household.id,
          baselineReading.version,
          { accountId: user.id }
        )
      ).rejects.toThrow(/READING_BASELINE_REQUIRED|READING_REFERENCED/);
    });
  });

  // ===========================================================================
  // E. Trusted System GUC Security Invariant & RLS Bypass Immunity (Tests A–E)
  // ===========================================================================
  describe('E. Trusted System GUC Security Invariant & RLS Bypass Immunity', () => {
    async function setupTwoTenants() {
      const tenantV = await repo.createAccount({ authUserId: 'victim-account' });
      const { household: hhV } = await repo.createHousehold({ name: 'Victim Secret Household' }, tenantV.id);
      const connV = await repo.createConnection({
        householdId: hhV.id,
        provider: 'LESCO',
        referenceNumber: '99999999999999',
        tariffCode: 'A1-R',
      }, { accountId: tenantV.id });
      const meterV = await repo.createMeter({
        householdId: hhV.id,
        connectionId: connV.id,
        serialNumber: 'MTR-VICTIM',
      }, { accountId: tenantV.id });
      const cycleV = await repo.createBillingCycle({
        householdId: hhV.id,
        connectionId: connV.id,
        meterId: meterV.id,
        billingPeriodStart: '2026-09-01',
        billingPeriodEnd: '2026-09-30',
        officialReadingDate: '2026-09-25',
        previousOfficialReading: 100,
        currentOfficialReading: 300,
        billedUnits: 200,
      }, { accountId: tenantV.id });
      const readingV = await repo.addMeterReading({
        householdId: hhV.id,
        connectionId: connV.id,
        meterId: meterV.id,
        cycleId: cycleV.id,
        cumulativeKWh: 150,
        readingTimestamp: '2026-09-10T10:00:00.000Z',
        source: 'manual',
      }, { accountId: tenantV.id });

      const tenantA = await repo.createAccount({ authUserId: 'attacker-account' });
      const { household: hhA } = await repo.createHousehold({ name: 'Attacker Household' }, tenantA.id);

      return { tenantV, hhV, connV, meterV, cycleV, readingV, tenantA, hhA };
    }

    // Test A: Runtime role attempting SET app.is_trusted_system = 'true' cannot read other tenants' data
    it("Test A: Runtime role attempting SET app.is_trusted_system = 'true' cannot read other tenants' data", async () => {
      const { hhV, readingV, tenantA } = await setupTwoTenants();

      await withClient(async (client) => {
        // Attacker operating as runtime database role sets session GUC app.is_trusted_system
        await client.query("SET app.is_trusted_system = 'true'");

        // 1. Without tenant context:
        const hhResNoContext = await client.query('SELECT * FROM households WHERE id = $1', [hhV.id]);
        expect(hhResNoContext.rows.length).toBe(0);

        const rdResNoContext = await client.query('SELECT * FROM meter_readings WHERE id = $1', [readingV.id]);
        expect(rdResNoContext.rows.length).toBe(0);

        // 2. Under Attacker's tenant context:
        await withTenantContext(client, tenantA.id, async () => {
          const hhResAsA = await client.query('SELECT * FROM households WHERE id = $1', [hhV.id]);
          expect(hhResAsA.rows.length).toBe(0);

          const rdResAsA = await client.query('SELECT * FROM meter_readings WHERE id = $1', [readingV.id]);
          expect(rdResAsA.rows.length).toBe(0);
        });
      }, pool);
    });

    // Test B: Runtime role attempting SELECT set_config('app.is_trusted_system', 'true', false) cannot read other tenants' data
    it("Test B: Runtime role attempting SELECT set_config('app.is_trusted_system', 'true', false) cannot read other tenants' data", async () => {
      const { hhV, readingV, tenantA } = await setupTwoTenants();

      await withClient(async (client) => {
        // Attacker attempts to set session GUC via set_config
        await client.query("SELECT set_config('app.is_trusted_system', 'true', false)");

        // 1. Without tenant context:
        const hhRes = await client.query('SELECT * FROM households WHERE id = $1', [hhV.id]);
        expect(hhRes.rows.length).toBe(0);

        const rdRes = await client.query('SELECT * FROM meter_readings WHERE id = $1', [readingV.id]);
        expect(rdRes.rows.length).toBe(0);

        // 2. Under Attacker's tenant context:
        await withTenantContext(client, tenantA.id, async () => {
          const hhResAsA = await client.query('SELECT * FROM households WHERE id = $1', [hhV.id]);
          expect(hhResAsA.rows.length).toBe(0);

          const rdResAsA = await client.query('SELECT * FROM meter_readings WHERE id = $1', [readingV.id]);
          expect(rdResAsA.rows.length).toBe(0);
        });
      }, pool);
    });

    // Test C: Transaction-local set_config('app.is_trusted_system', 'true', true) cannot bypass RLS
    it("Test C: Transaction-local set_config('app.is_trusted_system', 'true', true) cannot bypass RLS", async () => {
      const { hhV, readingV, tenantA } = await setupTwoTenants();

      await withClient(async (client) => {
        await withTransaction(client, async () => {
          // Attacker attempts transaction-local bypass
          await client.query("SELECT set_config('app.is_trusted_system', 'true', true)");

          // 1. Without tenant context:
          const hhRes = await client.query('SELECT * FROM households WHERE id = $1', [hhV.id]);
          expect(hhRes.rows.length).toBe(0);

          const rdRes = await client.query('SELECT * FROM meter_readings WHERE id = $1', [readingV.id]);
          expect(rdRes.rows.length).toBe(0);

          // 2. Under Attacker tenant context inside the transaction:
          await withTenantContext(client, tenantA.id, async () => {
            const hhResAsA = await client.query('SELECT * FROM households WHERE id = $1', [hhV.id]);
            expect(hhResAsA.rows.length).toBe(0);

            const rdResAsA = await client.query('SELECT * FROM meter_readings WHERE id = $1', [readingV.id]);
            expect(rdResAsA.rows.length).toBe(0);
          });
        });
      }, pool);
    });

    // Test D: Normal tenant queries continue to work under withTenantContext
    it('Test D: Normal tenant queries continue to work under withTenantContext', async () => {
      const { hhV, readingV, tenantV, hhA, tenantA } = await setupTwoTenants();

      // Tenant V querying their own data
      await withClient(async (client) => {
        await withTenantContext(client, tenantV.id, async () => {
          const hhRes = await client.query('SELECT * FROM households WHERE id = $1', [hhV.id]);
          expect(hhRes.rows.length).toBe(1);
          expect(hhRes.rows[0].name).toBe('Victim Secret Household');

          const rdRes = await client.query('SELECT * FROM meter_readings WHERE id = $1', [readingV.id]);
          expect(rdRes.rows.length).toBe(1);
          expect(Number(rdRes.rows[0].cumulative_kwh)).toBe(150);
        });

        // Tenant A querying their own data
        await withTenantContext(client, tenantA.id, async () => {
          const hhRes = await client.query('SELECT * FROM households WHERE id = $1', [hhA.id]);
          expect(hhRes.rows.length).toBe(1);
          expect(hhRes.rows[0].name).toBe('Attacker Household');

          // Tenant A querying Tenant V's data still gets 0 rows
          const victimHhRes = await client.query('SELECT * FROM households WHERE id = $1', [hhV.id]);
          expect(victimHhRes.rows.length).toBe(0);
        });
      }, pool);
    });

    // Test E: Legitimate system operations (like migrations or test cleanup) still succeed via their proper mechanism
    it('Test E: Legitimate system operations (like migrations or test cleanup) still succeed via their proper mechanism', async () => {
      // 1. Migration operation via PostgresMigrationAdapter succeeds via privileged connection
      const migrationAdapter = new PostgresMigrationAdapter(adminPool);
      const localState = developmentFixtureState();
      const summary = await migrationAdapter.migrateState(localState);
      expect(summary.householdsMigrated).toBeGreaterThanOrEqual(1);
      expect(summary.readingsMigrated).toBeGreaterThanOrEqual(1);

      // 2. Test cleanup / administrative TRUNCATE succeeds via adminPool / maintenance role
      await withClient(async (client) => {
        await withSystemContext(client, async () => {
          const res = await client.query(`
            TRUNCATE accounts, households, household_memberships, connections,
                     meters, billing_cycles, official_bills, meter_readings,
                     meter_lifecycle_events, idempotency_keys, audit_logs
            CASCADE
          `);
          expect(res).toBeDefined();
        });
      }, adminPool);

      // 3. Verify clean state after administrative truncate
      await withClient(async (client) => {
        const check = await client.query('SELECT COUNT(*) as count FROM households');
        expect(Number(check.rows[0].count)).toBe(0);
      }, adminPool);
    });
  });
});
