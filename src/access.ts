import { createRemoteJWKSet, customFetch, errors, jwtVerify } from "jose";
import { z } from "zod";
import { readBounded, sha256 } from "./common";
import type { authConfiguration } from "./auth-config";
import type { Principal } from "./auth";

type AccessConfiguration = NonNullable<ReturnType<typeof authConfiguration>["oauth"]>;
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const identitySchema = z.object({
  type: z.literal("app"),
  sub: z.string().max(256),
  common_name: z.string().max(256).optional(),
});
const invalidAssertionErrors = [
  z.ZodError,
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWSSignatureVerificationFailed,
  errors.JWSInvalid,
  errors.JWTInvalid,
  errors.JWKSNoMatchingKey,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
];

function keys(issuer: string) {
  let result = keySets.get(issuer);
  if (!result) {
    if (keySets.size >= 4) keySets.delete(keySets.keys().next().value!);
    result = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer), {
      timeoutDuration: 5000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
      [customFetch]: async (url, options) => {
        const response = await fetch(url, { ...options, redirect: "manual" });
        if (!response.ok || !response.body) throw new Error("Access key service unavailable");
        const body = await readBounded(response.body, 256 * 1024);
        return new Response(body, { headers: { "Content-Type": "application/json" } });
      },
    });
    keySets.set(issuer, result);
  }
  return result;
}

/** Verify only the signed origin assertion. Managed OAuth access tokens are opaque. */
export async function authenticateAccess(
  config: AccessConfiguration,
  assertion: string,
): Promise<Principal | Response> {
  if (assertion.length > 16_384)
    return Response.json({ error: "Invalid Access assertion" }, { status: 401 });
  let claims;
  try {
    const { payload } = await jwtVerify(assertion, keys(config.issuer), {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "type"],
    });
    claims = identitySchema.parse(payload);
  } catch (error) {
    return assertionFailure(error);
  }
  return accessPrincipal(config, claims);
}

function assertionFailure(error: unknown): Response {
  const invalid = invalidAssertionErrors.some((type) => error instanceof type);
  return Response.json(
    { error: invalid ? "Invalid Access assertion" : "Access verification unavailable" },
    { status: invalid ? 401 : 503 },
  );
}

function accessSubject(claims: z.output<typeof identitySchema>): string {
  if (claims.sub) return `user:${claims.sub}`;
  return claims.common_name ? `service:${claims.common_name}` : "";
}

async function accessPrincipal(
  config: AccessConfiguration,
  claims: z.output<typeof identitySchema>,
): Promise<Principal | Response> {
  const subject = accessSubject(claims);
  const role = config.grants[subject];
  if (!role) return Response.json({ error: "Identity has no agentpost grant" }, { status: 403 });
  const ownerId = await sha256(`agentpost:oauth:owner\0${config.issuer}\0${subject}`);
  // Stable across refreshes; changing this identity's role invalidates its old cursors.
  const tokenHash = await sha256(JSON.stringify({ issuer: config.issuer, subject, role }));
  return { admin: role === "admin", credential: "oauth", tokenHash, inboxId: null, ownerId };
}
