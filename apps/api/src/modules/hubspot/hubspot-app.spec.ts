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
    expect(all).not.toMatch(/https?:\/\//);
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

  it('render.mjs fills in https URLs with the expected paths and refuses anything else', () => {
    const run = (env: Record<string, string>) =>
      execFileSync(process.execPath, [resolve(APP_DIR, 'render.mjs'), '--check'], {
        env: { PATH: process.env.PATH ?? '', ...env },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    const good = {
      HUBSPOT_APP_REDIRECT_URI: 'https://x.example/oauth/hubspot/callback',
      HUBSPOT_WEBHOOK_TARGET_URL: 'https://x.example/webhooks/hubspot',
    };
    expect(run(good)).toMatch(/x\.example/);
    for (const bad of [
      { ...good, HUBSPOT_WEBHOOK_TARGET_URL: 'http://x.example/webhooks/hubspot' },
      { ...good, HUBSPOT_WEBHOOK_TARGET_URL: 'https://x.example/other' },
      { ...good, HUBSPOT_APP_REDIRECT_URI: 'https://x.example/oauth/hubspot/callback?a=1' },
      { HUBSPOT_APP_REDIRECT_URI: good.HUBSPOT_APP_REDIRECT_URI },
    ]) {
      expect(() => run(bad), JSON.stringify(bad)).toThrow();
    }
  });
});
