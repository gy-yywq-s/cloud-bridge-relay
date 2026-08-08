// OAuth 2.1 authorization-server state, backed by SQLite. Implements the SDK's
// OAuthServerProvider so @hono/mcp's mcpAuthRouter can serve /authorize,
// /token, /register (DCR), and revocation with PKCE — the flow claude.ai and
// Claude Code speak natively.
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Context } from "hono";
import type { Ctx } from "../core/context.js";
import { randHex } from "../core/context.js";
import { now } from "../db.js";

const TOKEN_TTL_S = 3600;
const CODE_TTL_S = 300;
const REFRESH_TTL_S = 60 * 60 * 24 * 30;
const iso = (secFromNow: number) => new Date(Date.now() + secFromNow * 1000).toISOString();

export function clientsStore(c: Ctx): OAuthRegisteredClientsStore {
  return {
    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
      const r = c.db.prepare("SELECT * FROM oauth_clients WHERE client_id=?").get(clientId) as
        { client_id: string; client_secret: string | null; redirect_uris: string; name: string } | undefined;
      if (!r) return undefined;
      return {
        client_id: r.client_id, client_secret: r.client_secret ?? undefined,
        redirect_uris: JSON.parse(r.redirect_uris), client_name: r.name || undefined,
        token_endpoint_auth_method: r.client_secret ? "client_secret_post" : "none",
      } as OAuthClientInformationFull;
    },
    async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
      c.db.prepare("INSERT OR REPLACE INTO oauth_clients(client_id,client_secret,redirect_uris,name,created_ts) VALUES(?,?,?,?,?)")
        .run(client.client_id, client.client_secret ?? null, JSON.stringify(client.redirect_uris), client.client_name ?? "", now());
      return client;
    },
  };
}

// A pending authorization lives in its OWN table (oauth_pending), never in
// oauth_codes — so the token endpoint cannot exchange a pre-login record for a
// token (security review finding 1).
export function stashPending(c: Ctx, clientId: string, params: AuthorizationParams): string {
  const pid = "ar-" + randHex(12);
  c.db.prepare("INSERT INTO oauth_pending(pid,client_id,redirect_uri,code_challenge,scope,expires_ts) VALUES(?,?,?,?,?,?)")
    .run(pid, clientId, params.redirectUri, params.codeChallenge, (params.scopes || []).join(" "), iso(CODE_TTL_S));
  return pid;
}

// After the human authenticates, consume the pending record and issue the real
// authorization code (account-bound) into oauth_codes.
export function mintCode(c: Ctx, pendingId: string, accountId: number): { code: string; redirectUri: string } | null {
  const p = c.db.prepare("SELECT * FROM oauth_pending WHERE pid=?").get(pendingId) as
    { client_id: string; redirect_uri: string; code_challenge: string; scope: string; expires_ts: string } | undefined;
  if (!p || p.expires_ts < now()) return null;
  const code = "ac-" + randHex(16);
  c.db.prepare("INSERT INTO oauth_codes(code,client_id,account_id,redirect_uri,code_challenge,scope,expires_ts) VALUES(?,?,?,?,?,?,?)")
    .run(code, p.client_id, accountId, p.redirect_uri, p.code_challenge, p.scope, iso(CODE_TTL_S));
  c.db.prepare("DELETE FROM oauth_pending WHERE pid=?").run(pendingId);
  return { code, redirectUri: p.redirect_uri };
}

export function provider(c: Ctx, loginPath = "/login"): OAuthServerProvider {
  const store = clientsStore(c);
  return {
    get clientsStore() { return store; },

    // Hono Context is passed at runtime (SDK types it as express Response).
    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: unknown): Promise<void> {
      const ctx = res as Context;
      const pid = stashPending(c, client.client_id, params);
      const u = new URL(loginPath, c.cfg.public_url || "http://localhost");
      u.searchParams.set("auth", pid);
      if (params.state) u.searchParams.set("state", params.state);
      // relative redirect keeps us on whatever host actually served the request
      ctx.res = ctx.redirect(`${loginPath}?${u.searchParams.toString()}`);
    },

    async challengeForAuthorizationCode(_client, authorizationCode): Promise<string> {
      const r = c.db.prepare("SELECT code_challenge FROM oauth_codes WHERE code=?").get(authorizationCode) as { code_challenge: string } | undefined;
      return r?.code_challenge ?? "";
    },

    async exchangeAuthorizationCode(client, authorizationCode, _verifier, redirectUri): Promise<OAuthTokens> {
      const r = c.db.prepare("SELECT * FROM oauth_codes WHERE code=?").get(authorizationCode) as
        { client_id: string; account_id: number | null; redirect_uri: string; scope: string; expires_ts: string } | undefined;
      // real, account-bound code only; client + redirect_uri must match; single-use.
      if (!r || r.client_id !== client.client_id || r.account_id == null || r.expires_ts < now())
        throw new Error("invalid_grant");
      if (redirectUri && redirectUri !== r.redirect_uri) throw new Error("invalid_grant");
      c.db.prepare("DELETE FROM oauth_codes WHERE code=?").run(authorizationCode);
      const access = "at-" + randHex(24);
      const refresh = "rt-" + randHex(24);
      c.db.prepare("INSERT INTO oauth_tokens(token,client_id,account_id,kind,scope,expires_ts,created_ts) VALUES(?,?,?,'access',?,?,?)")
        .run(access, client.client_id, r.account_id, r.scope, iso(TOKEN_TTL_S), now());
      c.db.prepare("INSERT INTO oauth_tokens(token,client_id,account_id,kind,scope,expires_ts,created_ts) VALUES(?,?,?,'refresh',?,?,?)")
        .run(refresh, client.client_id, r.account_id, r.scope, iso(REFRESH_TTL_S), now());
      return { access_token: access, token_type: "bearer", expires_in: TOKEN_TTL_S, refresh_token: refresh, scope: r.scope || undefined };
    },

    async exchangeRefreshToken(client, refreshToken, scopes): Promise<OAuthTokens> {
      const r = c.db.prepare("SELECT * FROM oauth_tokens WHERE token=? AND client_id=? AND kind='refresh'").get(refreshToken, client.client_id) as
        { account_id: number | null; scope: string; expires_ts: string | null } | undefined;
      if (!r || (r.expires_ts && r.expires_ts < now())) throw new Error("invalid_grant");
      // scope may only narrow, never widen the original grant.
      const granted = new Set(r.scope ? r.scope.split(" ") : []);
      const requested = (scopes || []).filter((s) => granted.has(s));
      const scope = requested.length ? requested.join(" ") : r.scope;
      // rotate: the presented refresh token is consumed and replaced.
      c.db.prepare("DELETE FROM oauth_tokens WHERE token=?").run(refreshToken);
      const access = "at-" + randHex(24);
      const newRefresh = "rt-" + randHex(24);
      c.db.prepare("INSERT INTO oauth_tokens(token,client_id,account_id,kind,scope,expires_ts,created_ts) VALUES(?,?,?,'access',?,?,?)")
        .run(access, client.client_id, r.account_id, scope, iso(TOKEN_TTL_S), now());
      c.db.prepare("INSERT INTO oauth_tokens(token,client_id,account_id,kind,scope,expires_ts,created_ts) VALUES(?,?,?,'refresh',?,?,?)")
        .run(newRefresh, client.client_id, r.account_id, scope, iso(REFRESH_TTL_S), now());
      return { access_token: access, token_type: "bearer", expires_in: TOKEN_TTL_S, refresh_token: newRefresh, scope: scope || undefined };
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      // ONLY access tokens authorize the data plane — a refresh token presented
      // as a bearer must be rejected (finding 2).
      const r = c.db.prepare("SELECT * FROM oauth_tokens WHERE token=? AND kind='access'").get(token) as
        { client_id: string; account_id: number | null; scope: string; expires_ts: string | null } | undefined;
      if (!r || r.account_id == null || (r.expires_ts && r.expires_ts < now())) throw new Error("invalid_token");
      return { token, clientId: r.client_id, scopes: r.scope ? r.scope.split(" ") : [], expiresAt: r.expires_ts ? Math.floor(new Date(r.expires_ts).getTime() / 1000) : undefined, extra: { accountId: r.account_id } } as AuthInfo;
    },

    async revokeToken(_client, request: OAuthTokenRevocationRequest): Promise<void> {
      c.db.prepare("DELETE FROM oauth_tokens WHERE token=?").run(request.token);
    },
  };
}
