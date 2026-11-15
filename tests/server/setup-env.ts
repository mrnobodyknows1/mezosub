// Imported FIRST by every server test: lib/chain/config reads addresses at module load.
process.env.NEXT_PUBLIC_MANAGER_ADDRESS = "0x1111111111111111111111111111111111111111";
process.env.NEXT_PUBLIC_REGISTRY_ADDRESS = "0x2222222222222222222222222222222222222222";
process.env.NEXT_PUBLIC_DEPLOY_BLOCK = "1";
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef0123456789";
process.env.BILLING_DEMO_MODE = "1";
process.env.CONFIRMATIONS = "0";
delete process.env.DATABASE_URL;
delete process.env.KEEPER_PRIVATE_KEY;
// Boot the in-memory PGlite + schema during import (no hook timeout applies here).
const { getDb } = await import("@/lib/server/db");
await getDb();
export {};
