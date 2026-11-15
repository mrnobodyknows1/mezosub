import { describe, expect, it } from "vitest";
import { MUSD_TESTNET } from "@/lib/chain/config";
import { permitDomainMatches } from "@/lib/client/permit";

// Read live from Mezo testnet on 2026-11-09: cast call 0x1189…c503 "DOMAIN_SEPARATOR()(bytes32)"
const LIVE_MUSD_SEPARATOR = "0x6f9f5c5d441374bdc3939f5da85a145469d7ffbc96bfe0cce59e5de7d8f1474f" as const;

describe("permitDomainMatches", () => {
  it("matches the real MUSD domain (name 'Mezo USD', version '1', chain 31611)", () => {
    expect(permitDomainMatches({ tokenName: "Mezo USD", token: MUSD_TESTNET, onchainSeparator: LIVE_MUSD_SEPARATOR })).toBe(true);
  });
  it("rejects a wrong name, chain or token so checkout falls back to approve", () => {
    expect(permitDomainMatches({ tokenName: "MUSD", token: MUSD_TESTNET, onchainSeparator: LIVE_MUSD_SEPARATOR })).toBe(false);
    expect(permitDomainMatches({ tokenName: "Mezo USD", token: MUSD_TESTNET, onchainSeparator: LIVE_MUSD_SEPARATOR, chainId: 1 })).toBe(false);
    expect(
      permitDomainMatches({ tokenName: "Mezo USD", token: "0x0000000000000000000000000000000000000001", onchainSeparator: LIVE_MUSD_SEPARATOR }),
    ).toBe(false);
  });
});
