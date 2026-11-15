import "./setup-env";
import { describe, expect, it } from "vitest";
import { verifyReceipt } from "@/lib/server/chain";
import { HttpError } from "@/lib/server/errors";
import { E18, FakeChain, MERCHANT, STRANGER, SUBSCRIBER, rawLog, txHash } from "./fakes";

function collectedLog(hash: `0x${string}`, address?: `0x${string}`) {
  return rawLog(
    "manager",
    "PaymentCollected",
    {
      subscriptionId: 1n, merchantId: 1n, subscriber: SUBSCRIBER, payout: MERCHANT, token: SUBSCRIBER, amount: 5n * E18,
      periodIndex: 1, billedFor: 100n, nextBillingAt: 400n, collector: MERCHANT,
    },
    { blockNumber: 5n, txHash: hash, logIndex: 0, address },
  );
}

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof HttpError ? e.code : String(e);
  }
}

describe("verifyReceipt", () => {
  const opts = { to: "manager" as const, events: ["PaymentCollected"], from: MERCHANT, attempts: 1 };
  it("accepts a valid receipt and decodes logs", async () => {
    const c = new FakeChain();
    const h = txHash();
    c.addReceipt(h, [collectedLog(h)], { from: MERCHANT });
    const v = await verifyReceipt(c, h, opts);
    expect(v.matched).toHaveLength(1);
    expect(v.matched[0].args.amount).toBe(5n * E18);
  });
  it("rejects wrong to / reverted / missing event / wrong sender / foreign emitter / unknown tx", async () => {
    const c = new FakeChain();
    const h1 = txHash();
    c.addReceipt(h1, [collectedLog(h1)], { from: MERCHANT, to: STRANGER });
    expect(await code(verifyReceipt(c, h1, opts))).toBe("wrong_contract");
    const h2 = txHash();
    c.addReceipt(h2, [], { from: MERCHANT, status: "reverted" });
    expect(await code(verifyReceipt(c, h2, opts))).toBe("tx_reverted");
    const h3 = txHash();
    c.addReceipt(h3, [], { from: MERCHANT });
    expect(await code(verifyReceipt(c, h3, opts))).toBe("event_missing");
    const h4 = txHash();
    c.addReceipt(h4, [collectedLog(h4)], { from: STRANGER });
    expect(await code(verifyReceipt(c, h4, opts))).toBe("wrong_sender");
    const h5 = txHash();
    c.addReceipt(h5, [collectedLog(h5, STRANGER)], { from: MERCHANT }); // lookalike contract emitted the event
    expect(await code(verifyReceipt(c, h5, opts))).toBe("event_missing");
    expect(await code(verifyReceipt(c, txHash(), opts))).toBe("tx_not_found");
    expect(await code(verifyReceipt(c, "0x1234" as `0x${string}`, opts))).toBe("invalid_tx_hash");
  });
});
