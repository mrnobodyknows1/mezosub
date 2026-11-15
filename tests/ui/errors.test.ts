import { describe, expect, it } from "vitest";
import { encodeErrorResult } from "viem";
import { subscriptionManagerAbi, merchantRegistryAbi } from "@/lib/chain/abis";
import { COLLECTION_REASONS, decodeRevertData, describeTxError, ERROR_MESSAGES, humanizeErrorName, reasonText } from "@/lib/client/errors";
import { COLLECTION_CHECK } from "@/lib/chain/config";

const encode = (errorName: string) => encodeErrorResult({ abi: subscriptionManagerAbi, errorName: errorName as never });

describe("describeTxError", () => {
  it("decodes custom errors carried as structured data (viem ContractFunctionRevertedError)", () => {
    const err = { name: "ContractFunctionExecutionError", shortMessage: "reverted", cause: { name: "ContractFunctionRevertedError", data: { errorName: "NotDue", args: [] } } };
    const r = describeTxError(err);
    expect(r.kind).toBe("revert");
    expect(r.errorName).toBe("NotDue");
    expect(r.message).toMatch(/isn't due yet/);
  });

  it.each([
    ["SubscriptionNotActive", /cancelled/],
    ["InsufficientAllowance", /allowance is too low/],
    ["TermsChanged", /changed this plan's terms/],
    ["SpendCapExceeded", /spending limit is used up/],
    ["InsufficientBalance", /doesn't hold enough MUSD/],
    ["AlreadySubscribed", /already has an active subscription/],
    ["NotAuthorizedCollector", /can't collect/],
  ])("decodes raw revert data for %s", (name, msg) => {
    const data = encode(name);
    expect(decodeRevertData(data)?.errorName).toBe(name);
    const r = describeTxError({ shortMessage: "Execution reverted", cause: { raw: data } });
    expect(r.errorName).toBe(name);
    expect(r.message).toMatch(msg);
  });

  it("decodes registry errors and OpenZeppelin errors", () => {
    const data = encodeErrorResult({ abi: merchantRegistryAbi, errorName: "AlreadyRegistered" });
    expect(describeTxError({ cause: { data } }).message).toBe(ERROR_MESSAGES.AlreadyRegistered);
    // EnforcedPause() selector 0xd93c0665
    expect(describeTxError({ cause: { data: "0xd93c0665" } }).errorName).toBe("EnforcedPause");
  });

  it("finds revert hex inside a message string", () => {
    const r = describeTxError(new Error(`execution reverted: ${encode("PlanFull")}`));
    expect(r.errorName).toBe("PlanFull");
  });

  it("treats wallet rejection as cancelled, not failed", () => {
    expect(describeTxError({ name: "UserRejectedRequestError" }).kind).toBe("rejected");
    expect(describeTxError({ code: 4001, message: "User rejected the request." }).kind).toBe("rejected");
  });

  it("explains missing gas, wrong network and unknown errors in plain words", () => {
    expect(describeTxError(new Error("insufficient funds for gas * price + value")).kind).toBe("funds");
    expect(describeTxError({ name: "WrongNetworkError" }).kind).toBe("network");
    expect(describeTxError(null).message).toBe("Please try again.");
    expect(describeTxError({}).title).toBe("Something went wrong");
  });

  it("has a plain message for every custom error in the ABIs", () => {
    const names = [...subscriptionManagerAbi, ...merchantRegistryAbi].filter((x) => x.type === "error").map((x) => (x as { name: string }).name);
    for (const n of names) expect(ERROR_MESSAGES[n], n).toBeTruthy();
  });

  it("humanizes unknown error names", () => {
    expect(humanizeErrorName("SomethingOddHappened")).toBe("Something odd happened.");
  });
});

describe("collection reasons", () => {
  it("covers every CollectionCheck with a title", () => {
    for (const c of COLLECTION_CHECK) expect(COLLECTION_REASONS[c].title).toBeTruthy();
    expect(reasonText("insufficient_balance")).toBe("Not enough MUSD");
    expect(COLLECTION_REASONS.spend_cap_exceeded.subscriberFix).toBe("renew");
    expect(COLLECTION_REASONS.insufficient_allowance.subscriberFix).toBe("allowance");
  });
});
