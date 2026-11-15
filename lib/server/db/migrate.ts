// `npm run db:migrate` — applies schema.sql (idempotent) to DATABASE_URL or the local PGlite store.
import "../../../worker/load-env";
import { closeDb, dbKind, getDb } from "./index";

async function main() {
  const db = await getDb();
  const [r] = await db<{ n: number }>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema()`;
  console.log(`[db:migrate] ${dbKind()} ok — ${r?.n ?? 0} tables`);
  await closeDb();
}

main().catch((e) => {
  console.error("[db:migrate] failed", e);
  process.exit(1);
});
