import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { readEnvioProgress } from '../envioSync/envioDb.js';
import { runParity } from '../fastLane/parity.js';

// Compares what the fast lane wrote with what Envio produced. Exit code 1 when anything differs or is missing.
const databaseUrl = process.env.DATABASE_URL;
const envioDatabaseUrl = process.env.ENVIO_DATABASE_URL;
if (!databaseUrl || !envioDatabaseUrl) throw new Error('DATABASE_URL and ENVIO_DATABASE_URL are required');
const { db, pool } = createDatabase(databaseUrl);
const envioPool = new Pool({ connectionString: envioDatabaseUrl });
const { processedBlock } = await readEnvioProgress(envioPool);
const report = await runParity(db, envioPool, { chainId: 4663, olderThanSeconds: Number(process.env.FAST_LANE_PARITY_MIN_AGE_SECONDS ?? 300), processedBlock });
console.log(JSON.stringify(report, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2));
await pool.end();
await envioPool.end();
process.exit(report.mismatched.length > 0 || report.missingInEnvio.length > 0 ? 1 : 0);
