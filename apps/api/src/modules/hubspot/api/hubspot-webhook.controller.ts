import { Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { HubSpotWebhookService, type WebhookOutcome } from '../application/hubspot-webhook.service';
import { SIGNATURE_V3_HEADER, TIMESTAMP_HEADER } from '../infrastructure/webhook-signature';

/**
 * Webhook target of the HubSpot app (API process; ADR 0011). The body arrives
 * as raw bytes (see bootstrap: rawRequestBody on /webhooks), is never logged
 * and never stored; the response carries only counts.
 */
@Controller('webhooks/hubspot')
export class HubSpotWebhookController {
  constructor(private readonly webhooks: HubSpotWebhookService) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WebhookOutcome['body']> {
    res.setHeader('Cache-Control', 'no-store');
    if (!Buffer.isBuffer(req.body)) {
      // Fail closed: without the exact bytes no signature can be verified.
      throw new Error('Webhook raw body missing: rawRequestBody middleware not applied');
    }
    const outcome = await this.webhooks.receive({
      method: req.method,
      originalUrl: req.originalUrl,
      rawBody: req.body,
      signatureV3: header(req, SIGNATURE_V3_HEADER),
      timestamp: header(req, TIMESTAMP_HEADER),
      legacySignature: req.headers['x-hubspot-signature'] !== undefined,
    });
    res.status(outcome.status);
    return outcome.body;
  }
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}
