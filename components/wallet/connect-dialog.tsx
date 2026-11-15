"use client";

import { useEffect, useRef } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";

/**
 * Opens Mezo Passport's connect modal (Bitcoin wallets via a Mezo smart account, or Ethereum
 * wallets). Keeps the controlled `open`/`onOpenChange` shape so call sites stay the same:
 * `onOpenChange(false)` fires once the modal closes, connected or not.
 */
export function ConnectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { openConnectModal, connectModalOpen } = useConnectModal();
  const shown = useRef(false);

  useEffect(() => {
    if (open && !connectModalOpen && !shown.current) {
      if (!openConnectModal) {
        // Already connected: nothing to open.
        onOpenChange(false);
        return;
      }
      shown.current = true;
      openConnectModal();
    }
  }, [open, connectModalOpen, openConnectModal, onOpenChange]);

  useEffect(() => {
    if (shown.current && !connectModalOpen) {
      shown.current = false;
      onOpenChange(false);
    }
  }, [connectModalOpen, onOpenChange]);

  return null;
}
