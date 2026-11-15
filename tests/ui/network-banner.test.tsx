// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrongNetworkBanner, NotDeployedBanner } from "@/components/shared/network-banner";
import { networkState } from "@/lib/client/guard";
import { act, render, type Rendered } from "./render";

// jsdom has `window`, so the real module would build Mezo Passport's browser config; these tests don't connect.
vi.mock("@/lib/client/wagmi", () => ({ wagmiConfig: {}, isSmartAccountConnector: () => false }));

let r: Rendered | null = null;
afterEach(() => {
  r?.unmount();
  r = null;
});

describe("network state", () => {
  it("classifies wallet network", () => {
    expect(networkState(false, undefined).kind).toBe("disconnected");
    expect(networkState(true, 1).kind).toBe("wrong-network");
    expect(networkState(true, 31611).kind).toBe("ready");
  });
});

describe("WrongNetworkBanner", () => {
  it("names the current network and offers a switch", () => {
    const onSwitch = vi.fn();
    r = render(<WrongNetworkBanner chainId={1} onSwitch={onSwitch} />);
    expect(r.text()).toContain("network 1");
    expect(r.text()).toContain("Mezo Testnet (31611)");
    const btn = r.byRole("button")[0];
    expect(btn.textContent).toBe("Switch to Mezo Testnet");
    act(() => btn.click());
    expect(onSwitch).toHaveBeenCalledOnce();
    expect(r.byRole("alert")).toHaveLength(1);
  });
  it("shows progress while switching", () => {
    r = render(<WrongNetworkBanner chainId={undefined} switching onSwitch={() => {}} />);
    const btn = r.byRole("button")[0] as HTMLButtonElement;
    expect(btn.textContent).toBe("Switching…");
    expect(btn.disabled).toBe(true);
  });
  it("renders the not-deployed notice", () => {
    r = render(<NotDeployedBanner />);
    expect(r.text()).toContain("Contracts not deployed yet");
  });
});
