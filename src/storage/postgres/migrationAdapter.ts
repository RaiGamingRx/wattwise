import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { deserializeState } from '../schema';
import { PersistenceState } from '../ports';
import { withClient, withTransaction, withSystemContext, getAdminPool } from './db';

export interface MigrationSummary {
  accountsMigrated: number;
  householdsMigrated: number;
  membershipsMigrated: number;
  connectionsMigrated: number;
  metersMigrated: number;
  cyclesMigrated: number;
  billsMigrated: number;
  readingsMigrated: number;
  lifecycleEventsMigrated: number;
  auditLogsMigrated: number;
  idMap: Map<string, string>;
}

/**
 * Migration Adapter:
 * Imports and validates localStorage v3 persistence state into authoritative PostgreSQL schema.
 * Decouples legacy BillingCycle from meterId and moves official bill facts into official_bills.
 */
export class PostgresMigrationAdapter {
  constructor(private pool: Pool = getAdminPool()) {}

  async migrateFromLocalStorageJson(
    rawJson: string,
    fallbackAuthUserId = 'migrated-local-user'
  ): Promise<MigrationSummary> {
    const envelope = deserializeState(rawJson);
    return this.migrateState(envelope.state, fallbackAuthUserId);
  }

  async migrateState(
    state: PersistenceState,
    fallbackAuthUserId = 'migrated-local-user'
  ): Promise<MigrationSummary> {
    const idMap = new Map<string, string>();
    const getOrAssignUuid = (legacyId: string): string => {
      if (!idMap.has(legacyId)) {
        idMap.set(legacyId, randomUUID());
      }
      return idMap.get(legacyId)!;
    };

    const targetPool = getAdminPool();
    return withClient(async (client) => {
      return withTransaction(client, async () => {
        return withSystemContext(client, async () => {
          let accountsMigrated = 0;
          let householdsMigrated = 0;
          let membershipsMigrated = 0;
          let connectionsMigrated = 0;
          let metersMigrated = 0;
          let cyclesMigrated = 0;
          let billsMigrated = 0;
          let readingsMigrated = 0;
          let lifecycleEventsMigrated = 0;
          let auditLogsMigrated = 0;

        // 1. Accounts
        for (const acc of state.accounts) {
          const accUuid = getOrAssignUuid(acc.id);
          await client.query(
            `INSERT INTO accounts (id, auth_user_id, email, display_name, created_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id) DO NOTHING`,
            [accUuid, `${fallbackAuthUserId}-${acc.id}`, `${acc.id}@local.wattwise`, acc.id, acc.createdAt]
          );
          accountsMigrated++;
        }

        // 2. Household
        const hhUuid = getOrAssignUuid(state.household.id);
        await client.query(
          `INSERT INTO households (id, name, timezone, version, created_at)
           VALUES ($1, $2, $3, 1, CURRENT_TIMESTAMP)
           ON CONFLICT (id) DO NOTHING`,
          [hhUuid, state.household.name, (state.household as any).timezone ?? 'Asia/Karachi']
        );
        householdsMigrated++;

        // 3. Memberships
        for (const mem of state.memberships) {
          const memUuid = getOrAssignUuid(mem.id);
          const memHhUuid = getOrAssignUuid(mem.householdId);
          const memAccUuid = getOrAssignUuid(mem.accountId);
          await client.query(
            `INSERT INTO household_memberships (id, household_id, account_id, role, created_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (household_id, account_id) DO NOTHING`,
            [memUuid, memHhUuid, memAccUuid, mem.role, mem.createdAt]
          );
          membershipsMigrated++;
        }

        // 4. Connections
        for (const conn of state.connections) {
          const connUuid = getOrAssignUuid(conn.id);
          const connHhUuid = getOrAssignUuid(conn.householdId);
          await client.query(
            `INSERT INTO connections (id, household_id, provider, reference_number, tariff_category, is_active, version)
             VALUES ($1, $2, $3, $4, $5, $6, 1)
             ON CONFLICT (id) DO NOTHING`,
            [
              connUuid,
              connHhUuid,
              conn.provider ?? state.settings.provider ?? 'LESCO',
              conn.referenceNumber ?? state.settings.referenceNumber ?? '00000000000000',
              (conn as any).tariffCategory ?? state.settings.tariffCategory ?? 'domestic_protected',
              conn.isActive ?? true,
            ]
          );
          connectionsMigrated++;
        }

        // 5. Meters
        for (const m of state.meters) {
          const mUuid = getOrAssignUuid(m.id);
          const mHhUuid = getOrAssignUuid(m.householdId);
          const mConnUuid = getOrAssignUuid(m.connectionId);
          await client.query(
            `INSERT INTO meters (
              id, household_id, connection_id, name, type, unit,
              serial_number, is_indoor_reset_supported, is_active, version
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
            ON CONFLICT (id) DO NOTHING`,
            [
              mUuid,
              mHhUuid,
              mConnUuid,
              m.name,
              m.type,
              m.unit ?? 'kWh',
              m.serialNumber ?? null,
              m.isIndoorResetSupported ?? false,
              m.isActive ?? true,
            ]
          );
          metersMigrated++;
        }

        // 6. Billing Cycles (Clean: NO meter_id, DATE boundaries)
        for (const c of state.cycles) {
          const cUuid = getOrAssignUuid(c.id);
          const cHhUuid = getOrAssignUuid(c.householdId);
          const cConnUuid = getOrAssignUuid(c.connectionId ?? state.connections[0].id);
          await client.query(
            `INSERT INTO billing_cycles (
              id, household_id, connection_id,
              billing_period_start, billing_period_end, status,
              sync_outdoor_reading, sync_reading_timestamp, gap_units, notes, version
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)
            ON CONFLICT (id) DO NOTHING`,
            [
              cUuid,
              cHhUuid,
              cConnUuid,
              c.billingPeriodStart,
              c.billingPeriodEnd,
              c.status ?? 'active',
              c.syncOutdoorReading ?? null,
              c.syncReadingTimestamp ?? null,
              c.gapUnits ?? null,
              c.notes ?? null,
            ]
          );
          cyclesMigrated++;
        }

        // 7. Official Bills
        for (const b of state.bills) {
          const bUuid = getOrAssignUuid(b.id);
          const bHhUuid = getOrAssignUuid(b.householdId);
          const bConnUuid = getOrAssignUuid(b.connectionId);
          const bCycleUuid = getOrAssignUuid(b.billingCycleId);
          await client.query(
            `INSERT INTO official_bills (
              id, household_id, connection_id, billing_cycle_id,
              bill_reference, billing_period_start, billing_period_end,
              issued_on, due_on, previous_reading, current_reading,
              billed_units, billed_amount, tariff_rate_per_unit,
              electricity_duty, tv_fee, fca, gst, fpa, other_charges,
              source, extraction_state, revision_status, revision_number, version
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
              $12, $13, $14, $15, $16, $17, $18, $19, $20,
              $21, $22, 'active', 1, 1
            ) ON CONFLICT (id) DO NOTHING`,
            [
              bUuid,
              bHhUuid,
              bConnUuid,
              bCycleUuid,
              b.billReference,
              b.billingPeriodStart,
              b.billingPeriodEnd,
              b.issuedOn,
              b.dueOn ?? null,
              b.previousReading,
              b.currentReading,
              b.billedUnits,
              b.amount ?? (b as any).billedAmount ?? 0,
              b.charges?.tariffRatePerUnit ?? (b as any).tariffRatePerUnit ?? 0,
              b.charges?.electricityDuty ?? (b as any).electricityDuty ?? 0,
              b.charges?.tvFee ?? (b as any).tvFee ?? 0,
              b.charges?.fca ?? (b as any).fca ?? 0,
              b.charges?.gst ?? (b as any).gst ?? 0,
              b.charges?.fpa ?? (b as any).fpa ?? 0,
              b.charges?.otherCharges ?? (b as any).otherCharges ?? 0,
              b.source ?? 'user_entered',
              b.extractionState ?? 'not_applicable',
            ]
          );
          billsMigrated++;
        }

        // 8. Lifecycle Events
        for (const lc of state.lifecycleEvents) {
          const lcUuid = getOrAssignUuid(lc.id);
          const lcHhUuid = getOrAssignUuid(lc.householdId);
          const lcConnUuid = getOrAssignUuid(lc.connectionId);
          const lcMeterUuid = getOrAssignUuid(lc.meterId);
          const lcPrevMeterUuid = lc.previousMeterId ? getOrAssignUuid(lc.previousMeterId) : null;
          await client.query(
            `INSERT INTO meter_lifecycle_events (
              id, household_id, connection_id, meter_id,
              type, occurred_at, previous_meter_id, baseline_reading, reason, version
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
            ON CONFLICT (id) DO NOTHING`,
            [
              lcUuid,
              lcHhUuid,
              lcConnUuid,
              lcMeterUuid,
              lc.type,
              lc.occurredAt,
              lcPrevMeterUuid,
              lc.baselineReading ?? null,
              lc.reason ?? null,
            ]
          );
          lifecycleEventsMigrated++;
        }

        // 9. Readings
        for (const r of state.readings) {
          const rUuid = getOrAssignUuid(r.id);
          const rHhUuid = getOrAssignUuid(r.householdId);
          const rConnUuid = getOrAssignUuid(r.connectionId);
          const rMeterUuid = getOrAssignUuid(r.meterId);
          const rCycleUuid = getOrAssignUuid(r.cycleId);
          const rLcUuid = r.lifecycleEventId ? getOrAssignUuid(r.lifecycleEventId) : null;
          await client.query(
            `INSERT INTO meter_readings (
              id, household_id, connection_id, meter_id, cycle_id,
              cumulative_kwh, reading_timestamp, server_timestamp,
              source, is_baseline, lifecycle_event_id, notes, version
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1)
            ON CONFLICT (id) DO NOTHING`,
            [
              rUuid,
              rHhUuid,
              rConnUuid,
              rMeterUuid,
              rCycleUuid,
              r.cumulativeKWh,
              r.reading_timestamp,
              r.entry_timestamp, // retain original historical entry time as server_timestamp
              r.source,
              r.isBaseline ?? false,
              rLcUuid,
              r.notes ?? null,
            ]
          );
          readingsMigrated++;
        }

        // 10. Audit Logs
        const firstAccUuid = getOrAssignUuid(state.accounts[0].id);
        for (const a of state.auditLogs) {
          const aUuid = getOrAssignUuid(a.id);
          const aHhUuid = getOrAssignUuid(state.household.id);
          const targetEntityUuid = idMap.get(a.entityId) ?? aHhUuid;
          await client.query(
            `INSERT INTO audit_logs (
              id, household_id, actor_account_id, action,
              entity_type, entity_id, entity_version,
              before_state, after_state, reason, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (id) DO NOTHING`,
            [
              aUuid,
              aHhUuid,
              firstAccUuid,
              a.action,
              a.entityType,
              targetEntityUuid,
              1,
              a.oldValue !== undefined ? JSON.stringify(a.oldValue) : null,
              a.newValue !== undefined ? JSON.stringify(a.newValue) : null,
              a.reason ?? null,
              a.timestamp,
            ]
          );
          auditLogsMigrated++;
        }

        return {
          accountsMigrated,
          householdsMigrated,
          membershipsMigrated,
          connectionsMigrated,
          metersMigrated,
          cyclesMigrated,
          billsMigrated,
          readingsMigrated,
          lifecycleEventsMigrated,
          auditLogsMigrated,
          idMap,
        };
        });
      });
    }, targetPool);
  }
}
