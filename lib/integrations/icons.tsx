export function GoogleIcon({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path fill="#4285F4" d="M23.52 12.27c0-.82-.07-1.6-.2-2.36H12v4.47h6.47c-.28 1.5-1.13 2.77-2.4 3.62v3.01h3.89c2.27-2.09 3.56-5.17 3.56-8.74z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.9l-3.89-3.01c-1.08.72-2.46 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.94H1.27v3.1C3.25 21.3 7.31 24 12 24z" />
      <path fill="#FBBC05" d="M5.29 14.3a7.2 7.2 0 0 1 0-4.6v-3.1H1.27a12 12 0 0 0 0 10.8z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.45-3.45C17.95 1.19 15.24 0 12 0 7.31 0 3.25 2.7 1.27 6.6l4.02 3.1C6.23 6.86 8.88 4.75 12 4.75z" />
    </svg>
  );
}

export function ZoomIcon({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" rx="5" fill="#2D8CFF" />
      <path fill="#fff" d="M5 9.2c0-.66.54-1.2 1.2-1.2h6.1c.66 0 1.2.54 1.2 1.2v5.6c0 .66-.54 1.2-1.2 1.2H6.2c-.66 0-1.2-.54-1.2-1.2V9.2z" />
      <path fill="#fff" d="M14.4 10.4l3.4-1.9c.4-.22.9.07.9.53v5.9c0 .46-.5.75-.9.53l-3.4-1.9v-3.16z" />
    </svg>
  );
}

/**
 * Generic email icon — used for the per-action Email permission rows on
 * the Agent settings page (app/dashboard/agent/page.tsx): gmail.read/
 * draft/send/archive/delete. Deliberately provider-neutral (a plain
 * envelope, not Gmail's specific brand colors) since these permissions
 * are conceptually about "the connected email account," and the app
 * may support inboxes other than Gmail down the line — a Gmail-branded
 * icon would be actively wrong once that happens. GoogleIcon (above)
 * is still the right choice specifically on the Settings page, where
 * it represents the actual Google OAuth connection.
 */
export function EmailIcon({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none">
      <rect x="2" y="4.5" width="20" height="15" rx="2.5" fill="#fff" stroke="#52525b" strokeWidth="1.6" />
      <path d="M3 6 L12 13 L21 6" stroke="#52525b" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Google Calendar — same rationale as EmailIcon above, used on the
 * Agent settings page's Calendar permission rows.
 */
export function CalendarIcon({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect width="24" height="24" rx="5" fill="#fff" stroke="#e4e4e7" />
      <rect x="4" y="5.5" width="16" height="14" rx="2" fill="#4285F4" />
      <rect x="4" y="5.5" width="16" height="4" rx="2" fill="#1a56c4" />
      <rect x="7" y="12" width="3" height="3" fill="#fff" />
      <rect x="12" y="12" width="3" height="3" fill="#fff" opacity="0.75" />
      <rect x="7" y="4" width="1.6" height="3" rx="0.8" fill="#1a56c4" />
      <rect x="15.4" y="4" width="1.6" height="3" rx="0.8" fill="#1a56c4" />
    </svg>
  );
}