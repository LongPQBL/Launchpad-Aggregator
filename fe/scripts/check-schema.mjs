import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const feRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaPath = join(feRoot, 'src/api/schema.ts');
const openapiPath = join(feRoot, '../be/openapi.json');

const committed = readFileSync(schemaPath, 'utf8');
const generated = execFileSync('npx', ['openapi-typescript', openapiPath], { cwd: feRoot, encoding: 'utf8' });

if (committed !== generated) {
  console.error('fe/src/api/schema.ts is out of date with be/openapi.json. Run `npm run generate:schema -w fe`.');
  process.exit(1);
}
