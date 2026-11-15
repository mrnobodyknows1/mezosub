import { describe, expect, it } from "vitest";
import { serializeSignature } from "viem";
import { permitDeadline, permitTypedData, splitPermitSignature } from "@/lib/client/permit";

describe("EIP-2612 permit", () => {
  it("builds the MUSD domain with version 1 on chain 31611", () => {
    const t = permitTypedData({
      tokenName: "Mezo USD",
      token: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
      owner: "0x1111111111111111111111111111111111111111",
      spender: "0x3333333333333333333333333333333333333333",
      value: 42n,
      nonce: 0n,
      deadline: 100n,
    });
    expect(t.domain).toEqual({ name: "Mezo USD", version: "1", chainId: 31611, verifyingContract: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503" });
    expect(t.primaryType).toBe("Permit");
    expect(t.message.value).toBe(42n);
  });
  it("splits a signature into v, r, s with v in {27, 28}", () => {
    const r = ("0x" + "11".repeat(32)) as `0x${string}`;
    const s = ("0x" + "22".repeat(32)) as `0x${string}`;
    const sig = serializeSignature({ r, s, yParity: 1 });
    expect(splitPermitSignature(sig)).toEqual({ v: 28, r, s });
  });
  it("sets a deadline 30 minutes out", () => {
    expect(permitDeadline(1_000_000)).toBe(BigInt(1000 + 1800));
  });
});
