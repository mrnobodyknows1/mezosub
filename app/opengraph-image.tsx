import { ImageResponse } from "next/og";
import { OgMark } from "@/components/brand/og-mark";

export const alt = "MezoSub: Subscriptions, without borders. Recurring payments, powered by MUSD.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 80,
          background: "#fcfcfd",
          color: "#1f2430",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <OgMark size={64} />
          <div style={{ fontSize: 36, fontWeight: 600, letterSpacing: -1 }}>MezoSub</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ fontSize: 84, fontWeight: 700, letterSpacing: -3, lineHeight: 1.05 }}>Subscriptions, without borders.</div>
          <div style={{ fontSize: 36, color: "#5b6170" }}>Recurring payments, powered by MUSD.</div>
        </div>
        <div style={{ display: "flex", height: 8, width: 160, background: "#2f8f6f", borderRadius: 4 }} />
      </div>
    ),
    size,
  );
}
