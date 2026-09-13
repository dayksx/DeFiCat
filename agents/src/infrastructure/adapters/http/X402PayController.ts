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
  } from "@nestjs/common";
  import type { Response } from "express";
  import { z } from "zod";
  import { DomainError } from "../../../domain/errors/DomainError.js";
  import { GetX402Requirements } from "../../../app/use-cases/Billing/GetX402Requirements.js";
  import { SettlePaymentAndFulfill } from "../../../app/use-cases/Billing/SettlePaymentAndFulfill.js";
  
  const tokenQuery = z.object({
    token: z.string().min(8).max(128),
  });
  
  const settleBody = z.object({
    token: z.string().min(8).max(128),
    payload: z.unknown(),
  });
  
  @Controller("pay/x402")
  export class X402PayController {
    constructor(
      private readonly getRequirements: GetX402Requirements,
      private readonly settle: SettlePaymentAndFulfill,
    ) {}
  
    @Get()
    async requirements(@Query() query: unknown, @Res({ passthrough: true }) res: Response) {
      const parsed = tokenQuery.safeParse(query);
      if (!parsed.success) {
        throw new HttpException("Invalid token", HttpStatus.BAD_REQUEST);
      }
      try {
        const view = await this.getRequirements.execute(parsed.data.token);
        res.status(HttpStatus.PAYMENT_REQUIRED);
        return view;
      } catch (err) {
        if (err instanceof DomainError) {
          throw new HttpException(err.message, HttpStatus.UNAUTHORIZED);
        }
        throw err;
      }
    }
  
    @Post("settle")
    @HttpCode(200)
    async settlePayment(@Body() body: unknown) {
      const parsed = settleBody.safeParse(body);
      if (!parsed.success) {
        throw new HttpException("Invalid body", HttpStatus.BAD_REQUEST);
      }
      try {
        return await this.settle.execute({
          token: parsed.data.token,
          payload: parsed.data.payload,
        });
      } catch (err) {
        if (err instanceof DomainError) {
          throw new HttpException(err.message, HttpStatus.UNAUTHORIZED);
        }
        throw err;
      }
    }
  }