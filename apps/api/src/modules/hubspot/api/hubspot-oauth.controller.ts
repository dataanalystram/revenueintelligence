import { Controller, Get, HttpStatus, Logger, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { HubSpotOAuthService } from '../application/hubspot-oauth.service';
import { LockTimeoutError, TenantInactiveError, TenantNotFoundError } from '../../tenancy';
import { isHubSpotError } from '../errors';

const CallbackQuerySchema = z.object({
  code: z
    .string()
    .regex(/^[A-Za-z0-9._~-]{1,512}$/)
    .optional(),
  state: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,900}\.[A-Za-z0-9_-]{43}$/)
    .optional(),
  error: z.string().max(200).optional(),
});

interface CallbackResult {
  readonly status: 'installed' | 'error';
  readonly reason?: string;
  readonly tenant?: string;
  readonly accountId?: string;
}

/**
 * OAuth redirect target for the HubSpot app (API process; ADR 0002, 0010).
 * The response never echoes the code or state, is not cacheable, and sends no
 * referrer; request logs never contain the query string.
 */
@Controller('oauth/hubspot')
export class HubSpotOAuthController {
  private readonly logger = new Logger(HubSpotOAuthController.name);

  constructor(private readonly oauth: HubSpotOAuthService) {}

  @Get('callback')
  async callback(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CallbackResult> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const input = CallbackQuerySchema.safeParse(query);
    if (!input.success || !input.data.state) {
      return this.fail(res, HttpStatus.BAD_REQUEST, 'invalid_request');
    }
    if (input.data.error !== undefined || !input.data.code) {
      // The user declined, or HubSpot reported an error. The state stays unredeemed and expires.
      return this.fail(res, HttpStatus.BAD_REQUEST, 'authorization_not_granted');
    }
    try {
      const done = await this.oauth.completeInstall({
        code: input.data.code,
        state: input.data.state,
      });
      return { status: 'installed', tenant: done.tenantSlug, accountId: done.accountId };
    } catch (err) {
      if (err instanceof LockTimeoutError) {
        return this.fail(res, HttpStatus.SERVICE_UNAVAILABLE, 'busy');
      }
      if (err instanceof TenantInactiveError || err instanceof TenantNotFoundError) {
        return this.fail(res, HttpStatus.CONFLICT, 'tenant_not_ready');
      }
      if (!isHubSpotError(err)) throw err;
      this.logger.warn({
        msg: 'HubSpot OAuth install refused',
        kind: err.kind,
        category: err.details.category,
      });
      if (err.details.category?.startsWith('oauth_state_')) {
        return this.fail(res, HttpStatus.BAD_REQUEST, 'invalid_state');
      }
      switch (err.kind) {
        case 'account_mismatch':
          return this.fail(res, HttpStatus.CONFLICT, 'account_mismatch');
        case 'not_configured':
        case 'integration_disabled':
          return this.fail(res, HttpStatus.CONFLICT, 'tenant_not_ready');
        case 'bad_request':
        case 'reauthorization_required':
          return this.fail(res, HttpStatus.BAD_REQUEST, 'code_rejected');
        case 'invalid_payload':
        case 'server_error':
        case 'timeout':
        case 'network':
        case 'rate_limited':
          return this.fail(res, HttpStatus.BAD_GATEWAY, 'hubspot_unavailable');
        default:
          throw err;
      }
    }
  }

  private fail(res: Response, status: number, reason: string): CallbackResult {
    res.status(status);
    return { status: 'error', reason };
  }
}
