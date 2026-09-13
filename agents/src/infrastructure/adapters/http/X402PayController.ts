import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { PaymentPayload } from '@x402/core/types';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { DomainError } from '../../../domain/errors/DomainError.js';
import { PaymentError } from '../../../app/use-cases/Billing/PaymentError.js';
import { GetX402Requirements } from '../../../app/use-cases/Billing/GetX402Requirements.js';
import { SettlePaymentAndFulfill } from '../../../app/use-cases/Billing/SettlePaymentAndFulfill.js';

const tokenQuery = z.object({
  token: z.string().min(8).max(128),
});

const settleBody = z.object({
  token: z.string().min(8).max(128),
  payload: z.object({
    x402Version: z.literal(2),
    accepted: z.object({
      scheme: z.string(),
      network: z.string(),
      asset: z.string(),
      amount: z.string(),
      payTo: z.string(),
      maxTimeoutSeconds: z.number(),
      extra: z.record(z.string(), z.unknown()),
    }),
    payload: z.record(z.string(), z.unknown()),
    resource: z
      .object({
        url: z.string(),
        description: z.string().optional(),
        mimeType: z.string().optional(),
      })
      .optional(),
  }),
});

@Controller('pay/x402')
export class X402PayController {
  constructor(
    private readonly getRequirements: GetX402Requirements,
    private readonly settle: SettlePaymentAndFulfill,
  ) {}

  @Get()
  async requirements(
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = tokenQuery.safeParse(query);
    if (!parsed.success) {
      throw new HttpException('Invalid token', HttpStatus.BAD_REQUEST);
    }
    try {
      const view = await this.getRequirements.execute(parsed.data.token);
      res.setHeader(
        'PAYMENT-REQUIRED',
        encodePaymentRequiredHeader(view.paymentRequired),
      );
      res.status(HttpStatus.PAYMENT_REQUIRED);
      return view;
    } catch (err) {
      if (err instanceof DomainError) {
        throw paymentHttpException(err);
      }
      throw err;
    }
  }

  @Post('settle')
  @HttpCode(200)
  async settlePayment(@Body() body: unknown) {
    const parsed = settleBody.safeParse(body);
    if (!parsed.success) {
      throw new HttpException('Invalid body', HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.settle.execute({
        token: parsed.data.token,
        payload: parsed.data.payload as PaymentPayload,
      });
    } catch (err) {
      if (err instanceof DomainError) {
        throw paymentHttpException(err);
      }
      throw err;
    }
  }
}

function paymentHttpException(error: DomainError): HttpException {
  if (!(error instanceof PaymentError)) {
    return new HttpException(error.message, HttpStatus.GONE);
  }
  const status = {
    NOT_LINKED: HttpStatus.UNAUTHORIZED,
    UNKNOWN_SESSION: HttpStatus.GONE,
    INVALID_PAYMENT: HttpStatus.UNPROCESSABLE_ENTITY,
    SETTLEMENT_FAILED: HttpStatus.BAD_GATEWAY,
  }[error.code];
  return new HttpException(error.message, status);
}
