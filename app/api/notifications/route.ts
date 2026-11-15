import type { NotificationDTO } from "@/lib/api-types";
import { requireSession } from "@/lib/server/auth";
import { toNotificationDTO } from "@/lib/server/dto";
import { route } from "@/lib/server/http";

/** Latest 50 notifications for the signed-in wallet (as subscriber and/or merchant). */
export const GET = route(async (req, { sql }): Promise<NotificationDTO[]> => {
  const session = await requireSession(sql, req);
  const rows = await sql<Record<string, unknown>>`
    SELECT * FROM notifications WHERE address = ${session.address} ORDER BY created_at DESC LIMIT 50`;
  return rows.map(toNotificationDTO);
});
