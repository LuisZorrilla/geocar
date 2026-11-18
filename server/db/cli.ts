import 'dotenv/config';
import { runMigrations } from './migrate.ts';
import { getPool, closePool } from './pool.ts';
import { ALL_TABLES } from './stateRepository.ts';

/**
 * Usage:
 *   npm run db:migrate   apply pending migrations
 *   npm run db:reset     DEV ONLY: drop every table; the next `npm run dev` re-seeds
 */
async function main() {
  const command = process.argv[2];
  if (command === 'migrate') {
    await runMigrations();
    console.log('[db] Migraciones al día.');
  } else if (command === 'reset') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('db:reset está deshabilitado con NODE_ENV=production.');
    }
    await getPool().query(`DROP TABLE IF EXISTS ${[...ALL_TABLES, 'schema_migrations'].join(', ')} CASCADE`);
    console.log('[db] Tablas eliminadas. Ejecuta `npm run dev` para migrar y sembrar de nuevo.');
  } else {
    throw new Error('Comando desconocido. Usa: migrate | reset');
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
