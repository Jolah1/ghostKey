/**
 * The security headers the live site sends, read from vercel.json, so a
 * test page runs under the same Content-Security-Policy as production.
 * Without this, a policy that blocks something the app needs (the wasm
 * signer, a new API host) passes every test and breaks only in
 * production.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

type Rule = { source: string; headers: { key: string; value: string }[] };

const vercel = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "vercel.json"), "utf8"),
) as { headers: Rule[] };

const siteWide = vercel.headers.find((r) => r.source === "/(.*)");
if (!siteWide) throw new Error("vercel.json has no site-wide header rule");

/** Every site-wide header from vercel.json. */
export const prodHeaders: Record<string, string> = Object.fromEntries(
  siteWide.headers.map((h) => [h.key, h.value]),
);
