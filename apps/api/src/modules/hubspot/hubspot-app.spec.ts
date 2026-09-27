import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HUBSPOT_OAUTH_SCOPES } from './infrastructure/oauth-client';

const APP_DIR = resolve(__dirname, '../../../../../hubspot-app');
const read = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(APP_DIR, 'template', path), 'utf8'));

interface AppMeta {
  config: {
    distribution: string;
    auth: {
      type: string;
      redirectUrls: string[];
      requiredScopes: string[];
      optionalScopes: string[];
      conditionallyRequiredScopes: string[];
    };
    permittedUrls: { fetch: string[]; iframe: string[]; img: string[] };
  };
}
interface WebhooksMeta {
  config: {
    settings: { targetUrl: string };
    subscriptions: {
      crmObjects: { subscriptionType: string; objectType: string; propertyName?: string }[];
    } & Record<string, unknown>;
  };
}

/** Properties confirmed live on the test account (docs/integrations/hubspot/discovery-findings.md). */
const CONFIRMED_PROPERTIES: Record<string, string[]> = {
  contact: ['email', 'lifecyclestage', 'firstname', 'hs_lead_status'],
  company: ['name', 'domain', 'lifecyclestage'],
  lead: ['hs_pipeline_stage', 'hs_lead_name', 'hs_pipeline', 'hs_lead_type', 'hs_lead_label'],
};

describe('HubSpot app project definition (hubspot-app/, ADR 0011)', () => {
  const app = read('src/app/app-hsmeta.json') as AppMeta;
  const webhooks = read('src/app/webhooks/webhooks-hsmeta.json') as WebhooksMeta;

  it('is a private OAuth app requesting exactly the read scopes the install URL asks for', () => {
    expect(app.config.distribution).toBe('private');
    expect(app.config.auth.type).toBe('oauth');
    expect(app.config.auth.requiredScopes).toEqual([...HUBSPOT_OAUTH_SCOPES]);
    expect(app.config.auth.optionalScopes).toEqual([]);
    expect(app.config.auth.conditionallyRequiredScopes).toEqual([]);
    for (const scope of app.config.auth.requiredScopes) expect(scope).toMatch(/\.read$/);
  });

  it('never commits a public host: URLs are placeholders filled in by render.mjs', () => {
    expect(app.config.auth.redirectUrls).toEqual(['{{HUBSPOT_APP_REDIRECT_URI}}']);
    expect(webhooks.config.settings.targetUrl).toBe('{{HUBSPOT_WEBHOOK_TARGET_URL}}');
    const all = [
      'hsproject.json',
      'src/app/app-hsmeta.json',
      'src/app/webhooks/webhooks-hsmeta.json',
    ]
      .map((p) => readFileSync(resolve(APP_DIR, 'template', p), 'utf8'))
      .join('\n');
    // The only URL in the template is HubSpot's own API in permittedUrls (static, approved).
    expect(all.match(/https?:\/\/[^"]*/g)).toEqual(['https://api.hubapi.com']);
    expect(all).not.toMatch(/ngrok|trycloudflare|localhost|127\.0\.0\.1/);
  });

  it('declares config.permittedUrls (required by HubSpot 2026.03) with exactly the approved static value', () => {
    // HubSpot's upload validation: "Missing required field: 'config.permittedUrls'".
    // Structure per HubSpot's official 2026.03 templates: fetch, iframe, img arrays.
    expect(app.config.permittedUrls).toEqual({
      fetch: ['https://api.hubapi.com'],
      iframe: [],
      img: [],
    });
    expect(JSON.stringify(app.config.permittedUrls)).not.toContain('{{');
  });

  it('subscribes only to creation and property changes of contacts, companies and leads, on confirmed properties', () => {
    expect(Object.keys(webhooks.config.subscriptions)).toEqual(['crmObjects']);
    const subs = webhooks.config.subscriptions.crmObjects;
    expect(subs.length).toBeGreaterThan(0);
    for (const s of subs) {
      expect(['object.creation', 'object.propertyChange']).toContain(s.subscriptionType);
      expect(Object.keys(CONFIRMED_PROPERTIES)).toContain(s.objectType);
      if (s.subscriptionType === 'object.propertyChange') {
        expect(CONFIRMED_PROPERTIES[s.objectType]).toContain(s.propertyName);
      } else {
        expect(s.propertyName).toBeUndefined();
      }
    }
    for (const type of ['contact', 'company', 'lead']) {
      expect(
        subs.some((s) => s.objectType === type && s.subscriptionType === 'object.creation'),
      ).toBe(true);
    }
  });

  const RENDER = resolve(APP_DIR, 'render.mjs');
  const good = {
    HUBSPOT_APP_REDIRECT_URI: 'https://tunnel-host.example/oauth/hubspot/callback',
    HUBSPOT_WEBHOOK_TARGET_URL: 'https://tunnel-host.example/webhooks/hubspot',
  };
  const run = (env: Record<string, string>, flag = '--check') =>
    execFileSync(process.execPath, [RENDER, flag], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  /** Calls one of render.mjs's exports in a child process (plain ESM, outside the TS project). */
  const call = (code: string): string =>
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `import * as r from ${JSON.stringify(RENDER)};\n${code}`],
      { encoding: 'utf8', stdio: 'pipe' },
    );

  it('render.mjs fills in https URLs with the expected paths and refuses anything else', () => {
    expect(run(good)).toMatch(/tunnel-host\.example/);
    for (const bad of [
      { ...good, HUBSPOT_WEBHOOK_TARGET_URL: 'http://tunnel-host.example/webhooks/hubspot' },
      { ...good, HUBSPOT_WEBHOOK_TARGET_URL: 'https://tunnel-host.example/other' },
      {
        ...good,
        HUBSPOT_APP_REDIRECT_URI: 'https://tunnel-host.example/oauth/hubspot/callback?a=1',
      },
      { ...good, HUBSPOT_APP_REDIRECT_URI: 'https://other-host.example/oauth/hubspot/callback' },
      { HUBSPOT_APP_REDIRECT_URI: good.HUBSPOT_APP_REDIRECT_URI },
    ]) {
      expect(() => run(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('the generated app-hsmeta.json has the required permittedUrls, read-only scopes and only approved URLs', () => {
    const rendered = JSON.parse(run(good, '--print')) as Record<string, unknown>;
    const app = rendered['src/app/app-hsmeta.json'] as AppMeta;
    const hooks = rendered['src/app/webhooks/webhooks-hsmeta.json'] as WebhooksMeta;
    expect(app.config.permittedUrls).toEqual({
      fetch: ['https://api.hubapi.com'],
      iframe: [],
      img: [],
    });
    expect(app.config.distribution).toBe('private');
    expect(app.config.auth.type).toBe('oauth');
    expect(app.config.auth.requiredScopes).toEqual([...HUBSPOT_OAUTH_SCOPES]);
    expect(app.config.auth.redirectUrls).toEqual([good.HUBSPOT_APP_REDIRECT_URI]);
    expect(hooks.config.settings.targetUrl).toBe(good.HUBSPOT_WEBHOOK_TARGET_URL);
    // Every URL in the whole rendered project: the two environment URLs and HubSpot's API.
    const urls = JSON.stringify(rendered)
      .match(/https?:\/\/[^"]*/g)!
      .sort();
    expect(urls).toEqual(
      [
        good.HUBSPOT_APP_REDIRECT_URI,
        good.HUBSPOT_WEBHOOK_TARGET_URL,
        'https://api.hubapi.com',
      ].sort(),
    );
    // The tunnel host is not in permittedUrls.
    expect(JSON.stringify(app.config.permittedUrls)).not.toContain('tunnel-host');
  });

  it('extra URLs cannot be injected through the environment variables', () => {
    for (const injected of [
      'https://tunnel-host.example/oauth/hubspot/callback","https://evil.example/x',
      'https://tunnel-host.example/oauth/hubspot/callback\\"],"permittedUrls":{"fetch":["https://evil.example"]}}',
      'https://tunnel-host.example/oauth/hubspot/callback#"https://evil.example"',
    ]) {
      expect(
        () => run({ ...good, HUBSPOT_APP_REDIRECT_URI: injected }, '--print'),
        injected,
      ).toThrow();
    }
    // Even a value that got past URL validation is JSON-escaped: it stays one string.
    const out = call(
      `process.stdout.write(r.render('["{{A}}"]', { A: 'x","https://evil.example' }));`,
    );
    expect(JSON.parse(out)).toEqual(['x","https://evil.example']);
    expect(() => call(`r.render('{{UNKNOWN}}', {});`)).toThrow(/unknown placeholder/);
  });

  it('a template that widens permittedUrls, adds a URL or a write scope is refused before anything is written', () => {
    const base = `
      const values = r.publicUrls(${JSON.stringify(good)});
      const rendered = r.renderProject(values);
      const app = rendered[r.APP_META];`;
    const refused = (mutation: string) =>
      expect(
        () => call(`${base}\n${mutation}\nr.validateRendered(rendered, values);`),
        mutation,
      ).toThrow(/rendered app is not allowed/);
    expect(() => call(`${base}\nr.validateRendered(rendered, values);`)).not.toThrow();
    refused(`app.config.permittedUrls.fetch.push('https://evil.example');`);
    refused(`app.config.permittedUrls.iframe.push(values.HUBSPOT_WEBHOOK_TARGET_URL);`);
    refused(`delete app.config.permittedUrls;`);
    refused(`app.config.auth.redirectUrls.push('https://evil.example/cb');`);
    refused(`app.config.auth.requiredScopes.push('crm.objects.contacts.write');`);
    refused(`app.config.auth.optionalScopes.push('oauth');`);
    refused(`app.config.distribution = 'marketplace';`);
    refused(
      `rendered[r.WEBHOOKS_META].config.settings.targetUrl = 'https://evil.example/webhooks/hubspot';`,
    );
    refused(`app.config.description += ' ' + values.HUBSPOT_WEBHOOK_TARGET_URL;`);
  });
});
