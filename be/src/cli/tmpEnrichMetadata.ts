import { Pool } from 'pg';
import { createDatabase } from '../db/client.js';
import { createRobinhoodPublicClient } from '../chains/robinhood.js';
import { enrichMetadataSafely } from '../launchpads/pons/metadataEnrichment.js';
const { db, pool } = createDatabase(process.env.DATABASE_URL!);
const envioPool = new Pool({ connectionString: process.env.ENVIO_DATABASE_URL, max: 2 });
const client = createRobinhoodPublicClient(process.env.RH_HTTP_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com');
const pending = async () => Number((await pool.query("SELECT count(*) FROM launches WHERE core_metadata_read_state = 'pending'")).rows[0].count);
for (let round = 0; round < 200 && (await pending()) > 0; round++) {
  await enrichMetadataSafely(db, envioPool, client, new Date(), (event) => console.log(event), 50);
  console.log(new Date().toISOString(), 'pending', await pending());
  await new Promise((resolve) => setTimeout(resolve, 65_000));
}
await envioPool.end();
await pool.end();
