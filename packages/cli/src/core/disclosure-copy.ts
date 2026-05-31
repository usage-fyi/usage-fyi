// Single source of truth for all consent-related copy strings (docs/19).
// Any edit to a string here MUST increment CONSENT_COPY_VERSION so that
// stored consent records remain auditable.

export const CONSENT_COPY_VERSION = 3;

export const DISCLOSURE_COPY = Object.freeze({
  gateHeading: "### <Feature> — coming soon",
  gateSubline: "Want a heads-up when it ships?",

  notifyControlLoggedOut: "[ email ] [ Notify me ]",
  notifyControlLoggedIn: "[ Notify me ]",
  oneClickLeave: "What emails will I get? · One click to leave",

  whatThisIs:
    'Emails you asked for: a one-time "it\'s live" for a feature. Not sold or\n' +
    "shared, not mixed with your stats. Leave in one click; inactive contacts\n" +
    "auto-removed after ~12–18 mo.",

  confirmSubject: "Confirm: tell you when <Feature> ships?",
  confirmBody:
    "Confirm and we'll go quiet until it's live. [Confirm]\n" +
    "Didn't ask? Ignore this — nothing's stored.",

  shippedSubject: "<Feature> is live",
  shippedBody:
    "You asked to hear when this shipped: <link>\nUnsubscribe · Delete",

  closeOutSubject: "<Feature> — subscription cancelled",
  closeOutBody:
    "We're removing <Feature> from the roadmap and cancelling your notify subscription.\n" +
    "Your data will be auto-deleted. Delete now: <delete-link>",
});

export type DisclosureCopy = typeof DISCLOSURE_COPY;
