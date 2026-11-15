import { z } from "zod";
import { requireSession } from "@/lib/server/auth";
import { clock } from "@/lib/server/clock";
import { parseBody, route } from "@/lib/server/http";

/** Body: { ids?: string[] } — omit ids (or pass { all: true }) to mark everything read. */
export const POST = route(
  async (req, { sql }) => {
    const session = await requireSession(sql, req);
    const b = await parseBody(req, z.object({ ids: z.array(z.uuid()).max(200).optional(), all: z.boolean().optional() }));
    const now = clock.now();
    if (b.ids && b.ids.length && !b.all) {
      const list = sql.join(b.ids.map((id) => sql.frag`${id}`), ", ");
      await sql`UPDATE notifications SET read_at = ${now} WHERE address = ${session.address} AND read_at IS NULL AND id IN (${list})`;
    } else {
      await sql`UPDATE notifications SET read_at = ${now} WHERE address = ${session.address} AND read_at IS NULL`;
    }
    return { ok: true };
  },
  { rateLimit: { bucket: "notif_read", limit: 60 } },
);
