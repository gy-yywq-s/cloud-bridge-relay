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

// A pending authorization: created when /authorize redirects the human to the
// login page; consumed when the login page mints the code after auth.
export function stashPending(c: Ctx, clientId: string, params: AuthorizationParams): string {
  const pid = "ar-" + randHex(12);
  c.db.prepare("INSERT INTO oauth_codes(code,client_id,account_id,redirect_uri,code_challenge,scope,expires_ts) VALUES(?,?,?,?,?,?,?)")
    .run(pid, clientId, null, params.redirectUri, params.codeChallenge, (params.scopes || []).join(" "), iso(CODE_TTL_S));
  // stash state separately in-band on the redirect URL; return the pending id
  return pid;
}

// After the human authenticates, bind the account and issue the real code.
export function mintCode(c: Ctx, pendingId: string, accountId: number): { code: string; redirectUri: string } | null {
  const p = c.db.prepare("SELECT * FROM oauth_codes WHERE code=?").get(pendingId) as
    { client_id: string; redirect_uri: string; code_challenge: string; scope: string; expires_ts: string } | undefined;
  if (!p || p.expires_ts < now()) return null;
  const code = "ac-" + randHex(16);
  c.db.prepare("INSERT INTO oauth_codes(code,client_id,account_id,redirect_uri,code_challenge,scope,expires_ts) VALUES(?,?,?,?,?,?,?)")
    .run(code, p.client_id, accountId, p.redirect_uri, p.code_challenge, p.scope, iso(CODE_TTL_S));
  c.db.prepare("DELETE FROM oauth_codes WHERE code=?").run(pendingId);
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

    async exchangeAuthorizationCode(client, authorizationCode): Promise<OAuthTokens> {
      const r = c.db.prepare("SELECT * FROM oauth_codes WHERE code=?").get(authorizationCode) as
        { client_id: string; account_id: number | null; scope: string; expires_ts: string } | undefined;
      if (!r || r.client_id !== client.client_id || r.expires_ts < now()) throw new Error("invalid_grant");
      c.db.prepare("DELETE FROM oauth_codes WHERE code=?").run(authorizationCode);
      const access = "at-" + randHex(24);
      const refresh = "rt-" + randHex(24);
      c.db.prepare("INSERT INTO oauth_tokens(token,client_id,account_id,scope,expires_ts,created_ts) VALUES(?,?,?,?,?,?)")
        .run(access, client.client_id, r.account_id, r.scope, iso(TOKEN_TTL_S), now());
      c.db.prepare("INSERT INTO oauth_tokens(token,client_id,account_id,scope,expires_ts,created_ts) VALUES(?,?,?,?,?,?)")
        .run(refresh, client.client_id, r.account_id, r.scope, null, now());
      return { access_token: access, token_type: "bearer", expires_in: TOKEN_TTL_S, refresh_token: refresh, scope: r.scope || undefined };
    },

    async exchangeRefreshToken(client, refreshToken, scopes): Promise<OAuthTokens> {
      const r = c.db.prepare("SELECT * FROM oauth_tokens WHERE token=? AND client_id=?").get(refreshToken, client.client_id) as
        { account_id: number | null; scope: string; expires_ts: string | null } | undefined;
      if (!r || (r.expires_ts && r.expires_ts < now())) throw new Error("invalid_grant");
      const access = "at-" + randHex(24);
      const scope = (scopes || []).join(" ") || r.scope;
      c.db.prepare("INSERT INTO oauth_tokens(token,client_id,account_id,scope,expires_ts,created_ts) VALUES(?,?,?,?,?,?)")
        .run(access, client.client_id, r.account_id, scope, iso(TOKEN_TTL_S), now());
      return { access_token: access, token_type: "bearer", expires_in: TOKEN_TTL_S, scope: scope || undefined };
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const r = c.db.prepare("SELECT * FROM oauth_tokens WHERE token=?").get(token) as
        { client_id: string; account_id: number | null; scope: string; expires_ts: string | null } | undefined;
      if (!r || (r.expires_ts && r.expires_ts < now())) throw new Error("invalid_token");
      return { token, clientId: r.client_id, scopes: r.scope ? r.scope.split(" ") : [], expiresAt: r.expires_ts ? Math.floor(new Date(r.expires_ts).getTime() / 1000) : undefined, extra: { accountId: r.account_id } } as AuthInfo;
    },

    async revokeToken(_client, request: OAuthTokenRevocationRequest): Promise<void> {
      c.db.prepare("DELETE FROM oauth_tokens WHERE token=?").run(request.token);
    },
  };
}
