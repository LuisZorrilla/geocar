import pg from 'pg';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL no está definido. Copia .env.example a .env y configura la conexión a PostgreSQL.'
    );
  }
  pool = new pg.Pool({ connectionString, max: 10 });
  pool.on('error', (err) => console.error('[db] Error inesperado en el pool:', err));
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
