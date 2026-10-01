#!/usr/bin/env node
// Renders the HubSpot app project (template/) into build/ with the public URLs
// of the current environment, ready for `hs project upload` (ADR 0011).
//
//   HUBSPOT_APP_REDIRECT_URI=https://<host>/oauth/hubspot/callback \
//   HUBSPOT_WEBHOOK_TARGET_URL=https://<host>/webhooks/hubspot \
//   node hubspot-app/render.mjs            # writes build/
//   node hubspot-app/render.mjs --check    # validates only
//   node hubspot-app/render.mjs --print    # prints the rendered JSON files (tests)
//
// The public host (a tunnel hostname in development) changes between
// sessions, so it is never committed: build/ is git-ignored. Re-render and
// re-upload whenever it changes. No secrets are involved.
//
// The rendered output is checked against an exact allow-list before anything
// is written: the host may appear only as the OAuth redirect URL and the
// webhook target URL; `permittedUrls` must be exactly the approved static
// value; scopes must be read-only; distribution private; auth OAuth.
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const template = join(root, 'template');
const build = join(root, 'build');

const EXPECTED_PATHS = {
  HUBSPOT_APP_REDIRECT_URI: '/oauth/hubspot/callback',
  HUBSPOT_WEBHOOK_TARGET_URL: '/webhooks/hubspot',
};

/**
 * `config.permittedUrls` (required by the 2026.03 project schema): the URLs a
 * UI extension (card, settings page) may reach with hubspot.fetch, iframes and
 * images. This app has no UI extension, so the lists have no effect; the value
 * is HubSpot's own template default (hubspot-project-components,
 * 2026.03/components/app/oauth-private). It is static: the tunnel host never
 * belongs here (HubSpot calls the webhook target and redirects the browser to
 * the redirect URL; neither is a UI-extension request).
 */
export const APPROVED_PERMITTED_URLS = Object.freeze({
  fetch: ['https://api.hubapi.com'],
  iframe: [],
  img: [],
});

export const APP_META = 'src/app/app-hsmeta.json';
export const WEBHOOKS_META = 'src/app/webhooks/webhooks-hsmeta.json';

export function publicUrls(env) {
  const values = {};
  for (const [name, path] of Object.entries(EXPECTED_PATHS)) {
    const raw = env[name];
    if (!raw) throw new Error(`${name} is not set`);
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${name} is not a URL`);
    }
    if (url.protocol !== 'https:') throw new Error(`${name} must use https (HubSpot requires it)`);
    if (url.pathname !== path || url.search || url.hash || url.username || url.password) {
      throw new Error(`${name} must be https://<host>${path} (no query, fragment or credentials)`);
    }
    values[name] = url.toString();
  }
  const hosts = new Set(Object.values(values).map((v) => new URL(v).host));
  if (hosts.size !== 1) {
    throw new Error(
      'HUBSPOT_APP_REDIRECT_URI and HUBSPOT_WEBHOOK_TARGET_URL must use the same host',
    );
  }
  return values;
}

/** Substitutes known placeholders; values are JSON-escaped, so they cannot break out of a string. */
export function render(text, values) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (match, name) => {
    if (!(name in values)) throw new Error(`unknown placeholder ${match}`);
    return JSON.stringify(values[name]).slice(1, -1);
  });
}

/**
 * Checks the rendered project (a map of relative path → parsed JSON) against
 * the allow-list. Throws on anything unexpected.
 */
export function validateRendered(rendered, values) {
  const app = rendered[APP_META];
  const hooks = rendered[WEBHOOKS_META];
  if (!app || !hooks) throw new Error(`missing ${!app ? APP_META : WEBHOOKS_META}`);
  const cfg = app.config ?? {};
  const fail = (msg) => {
    throw new Error(`rendered app is not allowed: ${msg}`);
  };
  if (cfg.distribution !== 'private') fail('distribution must be private');
  if (cfg.auth?.type !== 'oauth') fail('auth.type must be oauth');
  if (!isDeepStrictEqual(cfg.auth?.redirectUrls, [values.HUBSPOT_APP_REDIRECT_URI])) {
    fail('auth.redirectUrls must be exactly [HUBSPOT_APP_REDIRECT_URI]');
  }
  const scopes = [
    ...(cfg.auth?.requiredScopes ?? []),
    ...(cfg.auth?.optionalScopes ?? []),
    ...(cfg.auth?.conditionallyRequiredScopes ?? []),
  ];
  // HubSpot's baseline `oauth` scope (required for every app; added by HubSpot
  // on upload) plus read-only CRM scopes, nothing else.
  if (!cfg.auth?.requiredScopes?.includes('oauth')) fail("the baseline 'oauth' scope is required");
  if (scopes.some((s) => s !== 'oauth' && !/^crm\.(objects|schemas)\.\w+\.read$/.test(s))) {
    fail("only 'oauth' and crm.*.read scopes are allowed");
  }
  if (scopes.filter((s) => s === 'oauth').length !== 1)
    fail("'oauth' must be requested exactly once");
  if (!isDeepStrictEqual(cfg.permittedUrls, { ...APPROVED_PERMITTED_URLS })) {
    fail('config.permittedUrls must be exactly the approved static value');
  }
  if (hooks.config?.settings?.targetUrl !== values.HUBSPOT_WEBHOOK_TARGET_URL) {
    fail('webhooks settings.targetUrl must be exactly HUBSPOT_WEBHOOK_TARGET_URL');
  }
  // The environment's host appears in exactly those two places, nowhere else.
  const host = new URL(values.HUBSPOT_WEBHOOK_TARGET_URL).host;
  const occurrences = Object.values(rendered)
    .map((json) => JSON.stringify(json).split(host).length - 1)
    .reduce((a, b) => a + b, 0);
  if (occurrences !== 2) fail(`the public host must appear exactly twice (found ${occurrences})`);
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Renders every JSON file of the template in memory and validates the result. */
export function renderProject(values, dir = template) {
  const rendered = {};
  for (const file of files(dir)) {
    if (!file.endsWith('.json')) continue;
    rendered[relative(dir, file).split('\\').join('/')] = JSON.parse(
      render(readFileSync(file, 'utf8'), values),
    );
  }
  validateRendered(rendered, values);
  return rendered;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const values = publicUrls(process.env);
  const rendered = renderProject(values);
  if (process.argv.includes('--print')) {
    process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
    process.exit(0);
  }
  if (process.argv.includes('--check')) {
    process.stdout.write(`OK for ${new URL(values.HUBSPOT_WEBHOOK_TARGET_URL).host}\n`);
    process.exit(0);
  }
  rmSync(build, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  cpSync(template, build, { recursive: true });
  for (const [path, json] of Object.entries(rendered)) {
    writeFileSync(join(build, path), `${JSON.stringify(json, null, 2)}\n`);
  }
  process.stdout.write(
    `Rendered ${relative(process.cwd(), build)} for ${new URL(values.HUBSPOT_WEBHOOK_TARGET_URL).host}\n` +
      `Next: cd ${relative(process.cwd(), build)} && hs project upload\n`,
  );
}
