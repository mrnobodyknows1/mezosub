export const SITE = {
  name: "MezoSub",
  tagline: "Recurring payments, powered by MUSD.",
  description:
    "Accept recurring MUSD payments on Mezo. Create a subscription, share one link, and manage your subscribers with transparent on-chain billing.",
  url: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  faucetUrl: "https://testnet.mezo.org",
} as const;
