/**
 * Standalone in-memory PostgreSQL (PGlite/WASM) speaking the wire protocol.
 * Run as a child process by the test harness: `tsx tests/helpers/pgliteServer.ts <port>`.
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.argv[2]);
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 50 });
await server.start();
console.log(`PGLITE_READY ${port}`);
