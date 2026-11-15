import { domainSeparator, parseSignature, type Address, type Hex } from "viem";
import { MEZO_TESTNET_ID } from "@/lib/chain/config";

/** EIP-2612 typed data for MUSD. `tokenName` is read live via name() ("Mezo USD" on chain 31611). */
export function permitTypedData(args: {
  tokenName: string;
  token: Address;
  owner: Address;
  spender: Address;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
  chainId?: number;
}) {
  return {
    domain: { name: args.tokenName, version: "1", chainId: args.chainId ?? MEZO_TESTNET_ID, verifyingContract: args.token },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit" as const,
    message: { owner: args.owner, spender: args.spender, value: args.value, nonce: args.nonce, deadline: args.deadline },
  };
}

/** Split a 65-byte signature into v/r/s for subscribeWithPermit. */
export function splitPermitSignature(sig: Hex): { v: number; r: Hex; s: Hex } {
  const p = parseSignature(sig);
  const v = p.v !== undefined ? Number(p.v) : (p.yParity ?? 0) + 27;
  return { v: v < 27 ? v + 27 : v, r: p.r, s: p.s };
}

/** Permit deadline: 30 minutes from now (unix seconds). */
export function permitDeadline(nowMs: number = Date.now(), minutes = 30): bigint {
  return BigInt(Math.floor(nowMs / 1000) + minutes * 60);
}

/**
 * True only if the token's on-chain DOMAIN_SEPARATOR equals the domain we would sign (name, version "1",
 * chainId, token). A mismatch means the permit would silently fail on-chain, so callers use approve instead.
 */
export function permitDomainMatches(args: { tokenName: string; token: Address; onchainSeparator: Hex; chainId?: number }): boolean {
  const expected = domainSeparator({
    domain: { name: args.tokenName, version: "1", chainId: args.chainId ?? MEZO_TESTNET_ID, verifyingContract: args.token },
  });
  return expected.toLowerCase() === args.onchainSeparator.toLowerCase();
}
