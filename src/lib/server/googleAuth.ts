export interface SyncEnv {
  [key: string]: string | undefined;
}

export interface ServiceAccountCreds {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

const tokenCache = new Map<string, { token: string; exp: number }>();

export function readEnv(name: string, runtimeEnv?: SyncEnv): string | undefined {
  const fromRuntime = runtimeEnv?.[name];
  if (typeof fromRuntime === "string" && fromRuntime.trim() !== "") return fromRuntime.trim();
  const fromProcess = typeof process !== "undefined" ? process.env[name] : undefined;
  if (typeof fromProcess === "string" && fromProcess.trim() !== "") return fromProcess.trim();
  return undefined;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function utf8ToBase64Url(str: string): string {
  return bytesToBase64Url(new TextEncoder().encode(str));
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function getUserOAuthAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const cacheKey = `oauth_refresh|${clientId}|${refreshToken.slice(-8)}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.exp > nowSec + 60) return cached.token;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google OAuth refresh token failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  tokenCache.set(cacheKey, {
    token: json.access_token,
    exp: nowSec + (json.expires_in ?? 3600),
  });
  return json.access_token;
}

export async function getGoogleAccessToken(
  creds: ServiceAccountCreds,
  scopes: string[],
): Promise<string> {
  const cacheKey = `${creds.client_email}|${scopes.join(" ")}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.exp > nowSec + 60) return cached.token;

  const pem = creds.private_key
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const keyBytes = base64ToBytes(pem);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const tokenUri = creds.token_uri || "https://oauth2.googleapis.com/token";
  const header = utf8ToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claimSet = {
    iss: creds.client_email,
    scope: scopes.join(" "),
    aud: tokenUri,
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const signingInput = `${header}.${utf8ToBase64Url(JSON.stringify(claimSet))}`;
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );
  const assertion = `${signingInput}.${bytesToBase64Url(new Uint8Array(sigBuf))}`;

  const tokenRes = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(
      `Google OAuth token exchange failed (${tokenRes.status}): ${await tokenRes.text()}`,
    );
  }
  const tokenJson = (await tokenRes.json()) as { access_token: string; expires_in?: number };
  tokenCache.set(cacheKey, {
    token: tokenJson.access_token,
    exp: nowSec + (tokenJson.expires_in ?? 3600),
  });
  return tokenJson.access_token;
}
