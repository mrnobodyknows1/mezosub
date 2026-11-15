import { randomBytes } from "node:crypto";
import type { Sql } from "./db";

export function slugify(input: string): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return s.length >= 3 ? s : (s ? `${s}-` : "") + randomBytes(3).toString("hex");
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58})[a-z0-9]$/;

/** First free slug: base, base-2, base-3 … then base-<random>. `table` is a trusted identifier. */
export async function uniqueSlug(tx: Sql, table: "plans" | "merchants", base: string): Promise<string> {
  const root = slugify(base);
  const like = `${root}%`;
  const rows = await tx<{ slug: string }>`SELECT slug FROM ${tx.raw(table)} WHERE slug LIKE ${like}`;
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(root)) return root;
  for (let i = 2; i < 100; i++) {
    const c = `${root}-${i}`;
    if (!taken.has(c)) return c;
  }
  return `${root}-${randomBytes(3).toString("hex")}`;
}
