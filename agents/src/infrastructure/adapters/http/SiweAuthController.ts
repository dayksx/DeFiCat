import {
    Body,
    Controller,
    Get,
    HttpException,
    HttpStatus,
    Post,
    Query,
  } from "@nestjs/common";
  import { z } from "zod";
  import { DomainError } from "../../../domain/errors/DomainError.js";
  import { CompleteSiweBind } from "../../../app/use-cases/SiweAuth/CompleteSiweBind.js";
  import { GetSiweChallenge } from "../../../app/use-cases/SiweAuth/GetSiweChallenge.js";
  
  const tokenQuery = z.object({
    token: z.string().min(8).max(128),
  });
  
  const verifyBody = z.object({
    token: z.string().min(8).max(128),
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    message: z.string().min(1).max(4096),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(2000),
  });
  
  @Controller("auth/siwe")
  export class SiweAuthController {
    constructor(
      private readonly getChallenge: GetSiweChallenge,
      private readonly complete: CompleteSiweBind,
    ) {}
  
    @Get("challenge")
    async challenge(@Query() query: unknown) {
      const parsed = tokenQuery.safeParse(query);
      if (!parsed.success) {
        throw new HttpException("Invalid token", HttpStatus.BAD_REQUEST);
      }
      try {
        return await this.getChallenge.execute(parsed.data.token);
      } catch (err) {
        if (err instanceof DomainError) {
          throw new HttpException(err.message, HttpStatus.UNAUTHORIZED);
        }
        throw err;
      }
    }
  
    @Post("verify")
    async verify(@Body() body: unknown) {
      const parsed = verifyBody.safeParse(body);
      if (!parsed.success) {
        throw new HttpException("Invalid body", HttpStatus.BAD_REQUEST);
      }
      try {
        const result = await this.complete.execute(parsed.data);
        return { ok: true, address: result.address };
      } catch (err) {
        if (err instanceof DomainError) {
          throw new HttpException(err.message, HttpStatus.UNAUTHORIZED);
        }
        throw err;
      }
    }
  }