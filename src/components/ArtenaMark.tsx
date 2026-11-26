import type { SVGProps } from 'react';

/**
 * Artena brand mark — a shield outline enclosing a node-graph crossed by an
 * infinity ribbon whose center rises into an amber "A" triangle.
 * Colors follow the brand palette: teal #2E8A94 / amber #E19F48.
 */
export function ArtenaMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" {...props}>
      {/* shield outline */}
      <path
        d="M24 4 40 10v14c0 9.5-6.4 16.2-16 20C14.4 40.2 8 33.5 8 24V10L24 4Z"
        stroke="currentColor"
        className="text-teal-600 dark:text-teal-400"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      {/* infinity ribbon */}
      <path
        d="M15.5 24c0-3 2.3-5.2 5-5.2 4.4 0 5.6 10.4 10 10.4 2.7 0 5-2.2 5-5.2s-2.3-5.2-5-5.2c-4.4 0-5.6 10.4-10 10.4-2.7 0-5-2.2-5-5.2Z"
        stroke="currentColor"
        className="text-teal-600 dark:text-teal-400"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      {/* amber "A" node rising from the crossing */}
      <path
        d="M24 15.5 28.6 27h-9.2L24 15.5Z"
        fill="#E19F48"
        className="drop-shadow-[0_0_4px_rgba(225,159,72,0.55)]"
      />
      {/* network nodes */}
      <circle cx="15.5" cy="24" r="2.1" fill="#E19F48" />
      <circle cx="35.5" cy="24" r="2.1" fill="#E19F48" />
      <circle cx="24" cy="33.5" r="1.7" className="text-teal-500 dark:text-teal-300" fill="currentColor" />
    </svg>
  );
}

/** Square tile version for headers / auth screens: navy tile + glowing mark. */
export function ArtenaLogoTile({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const dim = size === 'lg' ? 'w-14 h-14' : size === 'sm' ? 'w-8 h-8' : 'w-10 h-10';
  return (
    <div
      className={`${dim} shrink-0 rounded-xl bg-[#122333] dark:bg-[#122333] border border-teal-500/25 flex items-center justify-center shadow-[0_0_18px_rgba(225,159,72,0.18),inset_0_0_12px_rgba(46,138,148,0.12)]`}
    >
      <ArtenaMark className={size === 'lg' ? 'w-9 h-9' : size === 'sm' ? 'w-5 h-5' : 'w-6 h-6'} />
    </div>
  );
}
