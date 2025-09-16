import { Pool } from 'pg';
import { logger } from '../utils/logger';

let pool: Pool | null = null;

function shouldDisableDb(): boolean {
  const envDisabled = (process.env.DB_DISABLED || '').toLowerCase();
  if (envDisabled === 'true' || envDisabled === '1') return true;
  // Default: disable DB in non-production so dev can run without Postgres
  return process.env.NODE_ENV !== 'production';
}

export async function connectDatabase() {
  if (shouldDisableDb()) {
    logger.warn('Database disabled (DB_DISABLED or non-production). Using in-memory stub.');
    return;
  }

  if (!pool) {
    pool = new Pool({
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      database: process.env.DB_NAME || 'test_automation',
      password: process.env.DB_PASSWORD || 'password',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    pool.on('error', (err) => {
      logger.error('Unexpected error on idle client', err);
    });
  }

  try {
    const client = await pool.connect();
    await client.query('SELECT NOW()');
    client.release();
    logger.info('Database connection successful');
  } catch (error) {
    logger.warn('Database connection failed; continuing in stub mode', { error });
  }
}

export { pool };
