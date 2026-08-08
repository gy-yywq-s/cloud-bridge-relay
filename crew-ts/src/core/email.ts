// Email dispatch via Resend (official SDK). Returns a discriminated result so
// callers can surface the exact failure to the human.
import { Resend } from "resend";
import type { Config } from "../config.js";

export type EmailFn = (to: string, subject: string, text: string, html?: string, sender?: string)
  => Promise<{ ok: true; resendId?: string } | { error: string }>;

export function makeEmail(cfg: Config): EmailFn {
  return async (to, subject, text, html, sender) => {
    if (cfg.email.provider === "none")
      return { error: "email is disabled (email.provider = none). Set email.provider = resend, email.from, and the API key env to enable owner email." };
    const key = process.env[cfg.email.api_key_env] || "";
    if (!key) return { error: `${cfg.email.api_key_env} is not set on the server. The deployer must set it to enable owner email.` };
    if (!cfg.email.from) return { error: "email.from is not configured (e.g. crew@verification.example.com)." };
    const resend = new Resend(key);
    const label = sender || cfg.brand.name;
    try {
      const { data, error } = await resend.emails.send({
        from: `${label} <${cfg.email.from}>`, to: [to], subject, text, ...(html ? { html } : {}),
      });
      if (error) return { error: `resend: ${error.message || JSON.stringify(error)}`.slice(0, 300) };
      return { ok: true, resendId: data?.id };
    } catch (e) {
      return { error: `resend: ${(e as Error).message}`.slice(0, 300) };
    }
  };
}
