#!/usr/bin/env node
// Renders the HubSpot app project (template/) into build/ with the public URLs
// of the current environment, ready for `hs project upload` (ADR 0011).
//
//   HUBSPOT_APP_REDIRECT_URI=https://<host>/oauth/hubspot/callback \
//   HUBSPOT_WEBHOOK_TARGET_URL=https://<host>/webhooks/hubspot \
//   node hubspot-app/render.mjs
//
// The public host (e.g. a Cloudflare Quick Tunnel hostname) changes between
// sessions, so it is never committed: build/ is git-ignored. Re-render and
// re-upload whenever it changes. No secrets are involved.
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
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const template = join(root, 'template');
const build = join(root, 'build');

const EXPECTED_PATHS = {
  HUBSPOT_APP_REDIRECT_URI: '/oauth/hubspot/callback',
  HUBSPOT_WEBHOOK_TARGET_URL: '/webhooks/hubspot',
};

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
  return values;
}

export function render(text, values) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (match, name) => {
    if (!(name in values)) throw new Error(`unknown placeholder ${match}`);
    return values[name];
  });
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const values = publicUrls(process.env);
  if (process.argv.includes('--check')) {
    // Validate and render in memory only (tests); build/ is left untouched.
    for (const file of files(template)) {
      if (file.endsWith('.json')) JSON.parse(render(readFileSync(file, 'utf8'), values));
    }
    process.stdout.write(`OK for ${new URL(values.HUBSPOT_WEBHOOK_TARGET_URL).host}\n`);
    process.exit(0);
  }
  rmSync(build, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  cpSync(template, build, { recursive: true });
  for (const file of files(build)) {
    if (!file.endsWith('.json')) continue;
    const rendered = render(readFileSync(file, 'utf8'), values);
    JSON.parse(rendered); // still valid JSON
    writeFileSync(file, rendered);
  }
  process.stdout.write(
    `Rendered ${relative(process.cwd(), build)} for ${new URL(values.HUBSPOT_WEBHOOK_TARGET_URL).host}\n` +
      `Next: cd ${relative(process.cwd(), build)} && hs project upload\n`,
  );
}
