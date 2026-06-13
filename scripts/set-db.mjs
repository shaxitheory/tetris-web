// Flip the Prisma datasource provider in prisma/schema.prisma.
// Local dev keeps "sqlite"; the Render build runs `node scripts/set-db.mjs postgres`
// to target Postgres before generating the client and pushing the schema.
//
// Usage: node scripts/set-db.mjs <sqlite|postgres>
import { readFileSync, writeFileSync } from 'fs';

const arg = process.argv[2];
const provider = { sqlite: 'sqlite', postgres: 'postgresql', postgresql: 'postgresql' }[arg];
if (!provider) {
  console.error('Usage: node scripts/set-db.mjs <sqlite|postgres>');
  process.exit(1);
}

const path = 'prisma/schema.prisma';
const updated = readFileSync(path, 'utf8')
  .replace(/provider\s*=\s*"(sqlite|postgresql)"/, `provider = "${provider}"`);
writeFileSync(path, updated);
console.log(`Prisma datasource provider set to "${provider}".`);
