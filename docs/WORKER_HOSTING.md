# Worker hosting

The worker does four things on every pass: index chain events, run the billing scheduler (the keeper sends due
collections), deliver webhooks, and send upcoming-charge notifications. One pass is `runWorkerPass` in
`lib/server/worker.ts`. There are two ways to run it.

## Free: scheduled calls to the web app (current)

`POST /api/indexer/sync` runs one worker pass. It needs `Authorization: Bearer $INDEXER_SECRET`.

- A scheduler calls it every minute. On Supabase this is `pg_cron` + `pg_net` (both free):

  ```sql
  create extension if not exists pg_net;
  create extension if not exists pg_cron;
  select cron.schedule('mezosub-worker', '* * * * *', $$
    select net.http_post(
      url := 'https://<your-app>.vercel.app/api/indexer/sync',
      headers := jsonb_build_object('Authorization', 'Bearer <INDEXER_SECRET>', 'Content-Type', 'application/json'),
      timeout_milliseconds := 60000
    );
  $$);
  ```

  Any other free scheduler that can send a POST with a header every minute (for example cron-job.org) works too.
- To send collections, the web host also needs `KEEPER_ON_WEB=true` and `KEEPER_PRIVATE_KEY`. Without them the
  pass still indexes and plans jobs, but renewals wait for a merchant to click "Collect due payment".
- Trade-off: the keeper key lives on the web host. The keeper can only trigger charges that are already due, for the
  exact amount, to the merchant's own payout, so a stolen keeper key gains the attacker nothing (see SECURITY.md).
  Use a keeper wallet that holds only a little BTC for gas.
- Timing: one pass per minute (a pass can take up to 60 s on Vercel Hobby). Fine for the 5-minute demo plan.

## Render background worker (later)

`render.yaml` defines a long-running worker (`npm run worker`, a pass every `WORKER_INTERVAL_MS`, default 15 s).

1. Render → New → Blueprint → pick this repo. Connect GitHub under Account Settings → Git Providers first.
2. Fill in the `sync: false` values: `DATABASE_URL` (Supabase session pooler), `KEEPER_PRIVATE_KEY`, and the
   chain env (same values as the web app). `DATABASE_SCHEMA=mezosub` is already set.
3. After it is running, remove `KEEPER_PRIVATE_KEY` and `KEEPER_ON_WEB` from the web host and unschedule the free
   trigger (`select cron.unschedule('mezosub-worker');`).

- Billing: Render has no free plan for background workers. The smallest (Starter) is about $7/month, so add a payment method under Billing first. The free web service plan won't work because it goes to sleep, and renewals would stop.

Check either setup with `GET /api/health`: `worker.healthy` is true and the indexer lag is a few blocks.
