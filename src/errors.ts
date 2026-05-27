export const EXIT = {
  OK: 0,
  ARGS: 1,
  ADAPTER: 2,
  PUBLISH: 3,
} as const;

interface ErrorInfo {
  message: string;
  retryable: boolean;
}

const HOSTED_ERRORS: Record<string, ErrorInfo> = {
  invalid_schema: {
    message:
      "Snapshot failed server validation. This is likely a bug — please report it.",
    retryable: false,
  },
  payload_too_large: {
    message: "Snapshot is too large to publish.",
    retryable: false,
  },
  rate_limited: {
    message:
      "Rate limited. Wait a moment and try again — nothing was published.",
    retryable: true,
  },
  not_found: {
    message: "Requested resource not found.",
    retryable: false,
  },
  gone: {
    message: "Resource has been removed.",
    retryable: false,
  },
  unauthorized: {
    message: "Unauthorized.",
    retryable: false,
  },
};

/**
 * Map a PublishError's HTTP status + response body to a user-facing message.
 * Tries the hosted error model { error: { code } } first; falls back to generic.
 */
export function resolvePublishError(
  status: number,
  body: string,
): ErrorInfo {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string } };
    if (parsed.error?.code) {
      const info = HOSTED_ERRORS[parsed.error.code];
      if (info) return info;
    }
  } catch {
    // body is not JSON
  }
  if (status >= 500) {
    return {
      message: `Server error (HTTP ${status}). The publish did not complete — retry is safe.`,
      retryable: true,
    };
  }
  return {
    message: `Publish failed (HTTP ${status}).`,
    retryable: false,
  };
}
