/**
 * The Jira mark.
 *
 * The Atlassian mark is a trademark, so this is a hand-drawn stand-in in the
 * same spirit — the blue-to-teal gradient tile with the white "J" hook — not
 * a copy of Atlassian's artwork. It exists so the settings card is
 * identifiable at a glance; drop the official asset in here if the brand
 * guidelines of your deployment require it.
 */
import * as React from 'react'

export interface JiraLogoProps {
  /** Square edge length in pixels. */
  size?: number
  className?: string
}

/**
 * Render the Jira mark.
 *
 * The gradient id is derived from React's `useId` so two marks on one page
 * never share a `<defs>` entry — the id is what makes the fill resolve.
 * @param props - the edge length and an optional class.
 * @returns the mark element.
 */
export function JiraLogo({ size = 20, className }: JiraLogoProps): React.ReactElement {
  const gradientId = React.useId()
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0052CC" />
          <stop offset="0.55" stopColor="#2684FF" />
          <stop offset="1" stopColor="#36E3DA" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="6" fill={`url(#${gradientId})`} />
      <path
        d="M15.4 6.4v7.3a4.3 4.3 0 0 1-4.3 4.3h-.8"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}
