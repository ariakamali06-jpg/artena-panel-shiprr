export function ArtenaLogoMark({ className = 'w-8 h-8' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="artenaMarkBg" x1="2" y1="2" x2="34" y2="34" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4CBAC4" />
          <stop offset="55%" stopColor="#2E8A94" />
          <stop offset="100%" stopColor="#0F766E" />
        </linearGradient>
      </defs>
      <rect width="36" height="36" rx="10" fill="url(#artenaMarkBg)" />
      <rect x="0.75" y="0.75" width="34.5" height="34.5" rx="9.25" stroke="white" strokeOpacity="0.18" strokeWidth="1.5" />
      {/* Precision architectural 'A' prism & signal arc */}
      <path
        d="M18 8.2L26.8 26.2H22.8L20.9 22.1H15.1L13.2 26.2H9.2L18 8.2ZM19.55 19.1L18 15.65L16.45 19.1H19.55Z"
        fill="white"
      />
      <path
        d="M14.2 24.4H21.8"
        stroke="white"
        strokeOpacity="0.45"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
