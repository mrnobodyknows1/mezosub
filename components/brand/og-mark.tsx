// Inline mark for next/og image routes (hex colours; ImageResponse doesn't read CSS variables).
export function OgMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <rect width="32" height="32" rx="8" fill="#1f2430" />
      <path d="M9 17.5a7 7 0 0 1 12.2-4.7" fill="none" stroke="#f7f8fa" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M23 14.5a7 7 0 0 1-12.2 4.7" fill="none" stroke="#3aa37f" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M21.6 9.4v3.7h-3.7" fill="none" stroke="#f7f8fa" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
