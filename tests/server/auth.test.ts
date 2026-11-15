import "./setup-env";
import { beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { issueNonce, requireSession, sessionFromRequest, signSessionId, unsignSessionCookie, verifySignIn, SESSION_COOKIE } from "@/lib/server/auth";
import { clock } from "@/lib/server/clock";
import { resetDbForTests, type Sql } from "@/lib/server/db";
import { HttpError } from "@/lib/server/errors";
import { FakeChain } from "./fakes";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const other = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const origin = { domain: "localhost:3000", uri: "http://localhost:3000" };
let sql: Sql;
const chain = new FakeChain();

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof HttpError ? e.code : String(e);
  }
}

beforeEach(async () => {
  clock.set(null);
  sql = await resetDbForTests();
});

describe("auth", () => {
  it("issues a SIWE message with the required fields", async () => {
    const { nonce, message } = await issueNonce(sql, account.address, origin);
    expect(message).toContain("localhost:3000 wants you to sign in");
    expect(message).toContain(account.address);
    expect(message).toContain("Chain ID: 31611");
    expect(message).toContain(`Nonce: ${nonce}`);
    expect(message).toContain("Version: 1");
    expect(message).toMatch(/Issued At: .+/);
    expect(message).toMatch(/Expiration Time: .+/);
  });

  it("verifies, opens a session, and rejects replay", async () => {
    const { message } = await issueNonce(sql, account.address, origin);
    const signature = await account.signMessage({ message });
    const s = await verifySignIn(sql, chain, { address: account.address, message, signature }, { allowedDomains: ["localhost:3000"] });
    expect(s.address).toBe(account.address.toLowerCase());
    const req = new Request("http://localhost:3000/x", { headers: { cookie: `${SESSION_COOKIE}=${signSessionId(s.id)}` } });
    expect((await sessionFromRequest(sql, req))?.address).toBe(account.address.toLowerCase());
    expect(await code(verifySignIn(sql, chain, { address: account.address, message, signature }, { allowedDomains: ["localhost:3000"] }))).toBe("nonce_used");
  });

  it("rejects wrong address, wrong domain, bad signature, expiry", async () => {
    const opts = { allowedDomains: ["localhost:3000"] };
    const a = await issueNonce(sql, account.address, origin);
    const sigA = await account.signMessage({ message: a.message });
    expect(await code(verifySignIn(sql, chain, { address: other.address, message: a.message, signature: sigA }, opts))).toBe("address_mismatch");
    expect(await code(verifySignIn(sql, chain, { address: account.address, message: a.message, signature: sigA }, { allowedDomains: ["evil.com"] }))).toBe(
      "domain_mismatch",
    );
    const badSig = await other.signMessage({ message: a.message });
    expect(await code(verifySignIn(sql, chain, { address: account.address, message: a.message, signature: badSig }, opts))).toBe("invalid_signature");
    // Tampered nonce field → unknown nonce
    const tampered = a.message.replace(/Nonce: \w+/, "Nonce: deadbeefdeadbeefdeadbeefdeadbeef");
    expect(
      await code(verifySignIn(sql, chain, { address: account.address, message: tampered, signature: await account.signMessage({ message: tampered }) }, opts)),
    ).toBe("invalid_nonce");
    // the original still works (failures above did not burn it)
    expect(await code(verifySignIn(sql, chain, { address: account.address, message: a.message, signature: sigA }, opts))).toBe("ok");

    const b = await issueNonce(sql, account.address, origin);
    const sigB = await account.signMessage({ message: b.message });
    const t0 = Date.now();
    clock.set(() => new Date(t0 + 11 * 60_000));
    expect(await code(verifySignIn(sql, chain, { address: account.address, message: b.message, signature: sigB }, opts))).toBe("message_expired");
  });

  it("signed cookies: tamper → rejected; requireSession → 401", async () => {
    const id = "a".repeat(64);
    expect(unsignSessionCookie(signSessionId(id))).toBe(id);
    expect(unsignSessionCookie(signSessionId(id).slice(0, -2) + "xx")).toBeNull();
    expect(unsignSessionCookie(`${"b".repeat(64)}.${signSessionId(id).split(".")[1]}`)).toBeNull();
    const req = new Request("http://localhost:3000/x");
    expect(await code(requireSession(sql, req))).toBe("unauthorized");
    const forged = new Request("http://localhost:3000/x", { headers: { cookie: `${SESSION_COOKIE}=${signSessionId(id)}` } });
    expect(await code(requireSession(sql, forged))).toBe("unauthorized"); // valid MAC but no DB session
  });
});
