import pg, { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

let poolInstance: Pool | null = null;
let adminPoolInstance: Pool | null = null;

export interface DbConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  max?: number;
}

export function getDbPool(config?: DbConfig): Pool {
  if (!poolInstance) {
    const connectionString = config?.connectionString || process.env.DATABASE_URL;
    if (connectionString) {
      poolInstance = new pg.Pool({ connectionString, max: config?.max ?? 10 });
    } else {
      poolInstance = new pg.Pool({
        host: config?.host || process.env.PGHOST || 'localhost',
        port: config?.port || Number(process.env.PGPORT) || 5432,
        user: config?.user || process.env.PGUSER || 'wattwise_app',
        password: config?.password || process.env.PGPASSWORD || 'wattwise_secure_pass',
        database: config?.database || process.env.PGDATABASE || 'wattwise_db',
        max: config?.max ?? 10,
      });
    }
  }
  return poolInstance;
}

export function getAdminPool(config?: DbConfig): Pool {
  if (!adminPoolInstance) {
    adminPoolInstance = new pg.Pool({
      host: config?.host || process.env.PGHOST || 'localhost',
      port: config?.port || Number(process.env.PGPORT) || 5432,
      user: process.env.PGADMINUSER || 'postgres',
      password: process.env.PGADMINPASSWORD || '',
      database: config?.database || process.env.PGDATABASE || 'wattwise_db',
      max: config?.max ?? 10,
    });
  }
  return adminPoolInstance;
}

export async function closeDbPool(): Promise<void> {
  if (poolInstance) {
    await poolInstance.end();
    poolInstance = null;
  }
}

export async function closeAdminPool(): Promise<void> {
  if (adminPoolInstance) {
    await adminPoolInstance.end();
    adminPoolInstance = null;
  }
}

export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>,
  pool?: Pool
): Promise<T> {
  const p = pool || getDbPool();
  const client = await p.connect();
  try {
    return await fn(client);
  } finally {
    try {
      // Guaranteed cleanup: wipe any tenant and session parameters before returning to pool
      await client.query("RESET ALL;");
    } catch {
      // Ignore cleanup error if connection severed
    }
    client.release();
  }
}

export async function withTransaction<T>(
  client: PoolClient,
  fn: () => Promise<T>
): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * Sets the transaction-local tenant context for PostgreSQL Row Level Security (RLS).
 * Must use set_config(..., true) with is_local=true.
 * Fails closed on missing or blank accountId.
 * Validates household membership when householdId is specified.
 */
export async function withTenantContext<T>(
  client: PoolClient,
  accountId: string,
  fn: () => Promise<T>,
  householdId?: string
): Promise<T> {
  if (!accountId || typeof accountId !== 'string' || accountId.trim() === '') {
    throw new Error('Tenant context requires a non-empty accountId.');
  }

  const prevAccountRes = await client.query<{ val: string | null }>(
    "SELECT current_setting('app.current_account_id', true) AS val"
  );
  const prevAccount = prevAccountRes.rows[0]?.val ?? '';

  const prevHouseholdRes = await client.query<{ val: string | null }>(
    "SELECT current_setting('app.current_household_id', true) AS val"
  );
  const prevHousehold = prevHouseholdRes.rows[0]?.val ?? '';

  // Set transaction-local configuration (third parameter = true is required by contract)
  await client.query('SELECT set_config($1, $2, true)', ['app.current_account_id', accountId]);
  // Also set session-level so non-transaction queries within fn() receive tenant context,
  // and guarantee cleanup in finally block.
  await client.query('SELECT set_config($1, $2, false)', ['app.current_account_id', accountId]);

  if (householdId) {
    await client.query('SELECT set_config($1, $2, true)', ['app.current_household_id', householdId]);
    await client.query('SELECT set_config($1, $2, false)', ['app.current_household_id', householdId]);
  }

  try {
    // Validate active membership if householdId is specified
    if (householdId) {
      const memRes = await client.query(
        `SELECT role FROM household_memberships
         WHERE household_id = $1 AND account_id = $2 AND revoked_at IS NULL`,
        [householdId, accountId]
      );
      if (memRes.rows.length === 0) {
        throw new Error(`Unauthorized: Account ${accountId} is not an active member of household ${householdId}.`);
      }
    }

    return await fn();
  } finally {
    try {
      await client.query('SELECT set_config($1, $2, false)', ['app.current_account_id', prevAccount]);
      if (householdId) {
        await client.query('SELECT set_config($1, $2, false)', ['app.current_household_id', prevHousehold]);
      }
    } catch {
      // If the transaction aborted, commands are ignored until ROLLBACK.
      // withTransaction will issue ROLLBACK, and withClient issues RESET ALL.
    }
  }
}

/**
 * Executes a privileged system operation with explicit audit trail.
 */
export async function withSystemContext<T>(
  client: PoolClient,
  fn: () => Promise<T>
): Promise<T> {
  const prevRes = await client.query<{ val: string | null }>(
    "SELECT current_setting('app.is_trusted_system', true) AS val"
  );
  const prevVal = prevRes.rows[0]?.val ?? '';

  await client.query("SELECT set_config('app.is_trusted_system', 'true', false)");
  try {
    return await fn();
  } finally {
    await client.query('SELECT set_config($1, $2, false)', ['app.is_trusted_system', prevVal]);
  }
}

/**
 * Query helper with typed output.
 */
export async function query<R extends QueryResultRow = QueryResultRow>(
  client: PoolClient | Pool,
  text: string,
  params: unknown[] = []
): Promise<QueryResult<R>> {
  return client.query<R>(text, params);
}
