import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PaymentPayload } from '@x402/core/types';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
} from '@x402/core/http';
import { DomainError } from '../../../domain/errors/DomainError.js';
import { PaymentError } from '../../../app/use-cases/Billing/PaymentError.js';
import { EnsPurchaseError } from '../../../app/use-cases/PurchaseEnsName/EnsPurchaseError.js';
import { EnsWatchError } from '../../../app/use-cases/EnsWatch/EnsWatchError.js';
import { GetEnsInsight } from '../../../app/use-cases/EnsInsight/GetEnsInsight.js';
import { HandleA2AEnsSkill } from '../../../app/use-cases/A2A/HandleA2AEnsSkill.js';
import { offerFor } from '../../../domain/billing/ServiceCatalog.js';

const insightQuery = z
  .object({
    name: z.string().min(3).max(255).optional(),
    address: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(20).optional(),
  })
  .refine((value) => value.name !== undefined || value.address !== undefined, {
    message: 'name or address is required',
  });

const paidBody = z.object({
  name: z.string().min(3).max(255),
  years: z.number().int().min(1).max(5).optional(),
});

@Controller()
export class A2AEnsController {
  constructor(
    private readonly insight: GetEnsInsight,
    private readonly paid: HandleA2AEnsSkill,
  ) {}

  @Get('.well-known/agent-card.json')
  wellKnownCard(@Req() req: Request) {
    return agentCard(requestOrigin(req));
  }

  @Get('a2a/agent-card.json')
  a2aCard(@Req() req: Request) {
    return agentCard(requestOrigin(req));
  }

  @Get('a2a/ens/insight')
  async getInsight(@Query() query: unknown) {
    const parsed = insightQuery.safeParse(query);
    if (!parsed.success) {
      throw new HttpException(
        'Provide name or address',
        HttpStatus.BAD_REQUEST,
      );
    }
    try {
      return await this.insight.execute(parsed.data);
    } catch (err) {
      throw a2aHttpException(err);
    }
  }

  @Post('a2a/ens/buy')
  async buy(
    @Body() body: unknown,
    @Headers('payment-signature') signature: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.paidSkill('buy', body, signature, req, res);
  }

  @Post('a2a/ens/schedule')
  async schedule(
    @Body() body: unknown,
    @Headers('payment-signature') signature: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.paidSkill('schedule', body, signature, req, res);
  }

  private async paidSkill(
    skill: 'buy' | 'schedule',
    body: unknown,
    signature: string | undefined,
    req: Request,
    res: Response,
  ) {
    const parsed = paidBody.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        'Body must include name and optional years (1-5)',
        HttpStatus.BAD_REQUEST,
      );
    }
    let payload: PaymentPayload | undefined;
    if (signature !== undefined && signature.length > 0) {
      try {
        payload = decodePaymentSignatureHeader(signature);
      } catch {
        throw new HttpException(
          'Invalid PAYMENT-SIGNATURE',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    try {
      const result = await this.paid.execute({
        skill,
        name: parsed.data.name,
        years: parsed.data.years ?? 1,
        resourceUrl: skillUrl(req, skill),
        payload,
      });
      if (result.status === 'payment_required') {
        res.setHeader(
          'PAYMENT-REQUIRED',
          encodePaymentRequiredHeader(result.paymentRequired),
        );
        res.status(HttpStatus.PAYMENT_REQUIRED);
        return {
          skill,
          sku: result.offer.sku,
          amountUsdc: (
            Number(result.offer.amountAtomic) / 1_000_000
          ).toString(),
          expiresAt: result.expiresAt.toISOString(),
          paymentRequired: result.paymentRequired,
        };
      }
      return {
        skill,
        paid: true,
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
        fulfillment: result.fulfillment,
      };
    } catch (err) {
      throw a2aHttpException(err);
    }
  }
}

function agentCard(origin: string) {
  return {
    protocolVersion: '0.3.0',
    name: 'DeFiCat',
    description:
      'ENS lookup via The Graph, plus x402-gated buy-now (0.01 USDC) and drop-watch (0.1 USDC) on Base Sepolia.',
    url: `${origin}/a2a`,
    version: '0.1.0',
    preferredTransport: 'HTTP',
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [
        {
          uri: 'https://github.com/google-a2a/a2a-x402',
          description:
            'Pay USDC with x402 exact/EIP-3009 on buy and schedule skills',
          required: false,
        },
      ],
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'ens-insight',
        name: 'ENS insight',
        description: `Free The Graph lookup. GET ${origin}/a2a/ens/insight?name=vitalik.eth`,
        tags: ['ens', 'thegraph'],
        examples: ['Who owns kikoulol.eth?', 'When does vitalik.eth expire?'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'ens-buy',
        name: 'Buy ENS',
        description: `Register an available 2LD .eth. POST ${origin}/a2a/ens/buy with {name, years}. x402 ${usdcLabel('ens.buy.now')} USDC.`,
        tags: ['ens', 'x402'],
        examples: ['Buy kikoulol.eth for 1 year'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
      {
        id: 'ens-schedule',
        name: 'Schedule ENS',
        description: `Watch a taken or over-budget 2LD and buy when it drops. POST ${origin}/a2a/ens/schedule with {name, years}. x402 ${usdcLabel('ens.watch.arm')} USDC.`,
        tags: ['ens', 'x402', 'temporal'],
        examples: ['Watch takenname.eth and buy it when it drops'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],
  };
}

function usdcLabel(sku: 'ens.buy.now' | 'ens.watch.arm'): string {
  return (Number(offerFor(sku).amountAtomic) / 1_000_000).toString();
}

function skillUrl(req: Request, skill: 'buy' | 'schedule'): string {
  return `${requestOrigin(req)}/a2a/ens/${skill}`;
}

function requestOrigin(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)
    ?.split(',')[0]
    ?.trim();
  const host = (req.headers['x-forwarded-host'] as string | undefined)
    ?.split(',')[0]
    ?.trim();
  return `${proto && proto.length > 0 ? proto : req.protocol}://${host && host.length > 0 ? host : req.get('host')}`;
}

function a2aHttpException(error: unknown): HttpException {
  if (error instanceof PaymentError) {
    const status = {
      NOT_LINKED: HttpStatus.UNAUTHORIZED,
      UNKNOWN_SESSION: HttpStatus.GONE,
      INVALID_PAYMENT: HttpStatus.UNPROCESSABLE_ENTITY,
      SETTLEMENT_FAILED: HttpStatus.BAD_GATEWAY,
    }[error.code];
    return new HttpException(error.message, status);
  }
  if (error instanceof EnsPurchaseError || error instanceof EnsWatchError) {
    return new HttpException(
      error.message,
      error.retryable ? HttpStatus.BAD_GATEWAY : HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  if (error instanceof DomainError) {
    return new HttpException(error.message, HttpStatus.UNPROCESSABLE_ENTITY);
  }
  return new HttpException(
    'The A2A request failed',
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}
