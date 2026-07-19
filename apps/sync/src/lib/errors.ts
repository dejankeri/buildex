// Typed errors the HTTP layer maps to status codes (AuthError → 401, ValidationError → 400).

/** Authentication/authorization failure - bad, expired, consumed, or revoked credential. */
export class AuthError extends Error {
  readonly status = 401;
  constructor(message = "unauthorized") {
    super(message);
    this.name = "AuthError";
  }
}

/** Malformed request input. */
export class ValidationError extends Error {
  readonly status = 400;
  constructor(message = "invalid request") {
    super(message);
    this.name = "ValidationError";
  }
}
