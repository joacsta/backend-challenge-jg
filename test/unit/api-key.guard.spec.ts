import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiKeyGuard } from "../../src/auth/api-key.guard";

const contextFor = (headers: Record<string, string>): ExecutionContext =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as unknown as ExecutionContext;

describe("ApiKeyGuard", () => {
  test("accepts the configured key", () => {
    process.env.API_KEY = "expected";
    const reflector = {
      getAllAndOverride: () => "API_KEY",
    } as unknown as Reflector;
    const guard = new ApiKeyGuard(reflector);

    expect(guard.canActivate(contextFor({ "x-api-key": "expected" }))).toBe(true);
  });

  test("rejects missing or invalid keys", () => {
    process.env.API_KEY = "expected";
    const reflector = {
      getAllAndOverride: () => "API_KEY",
    } as unknown as Reflector;
    const guard = new ApiKeyGuard(reflector);

    try {
      guard.canActivate(contextFor({}));
      throw new Error("expected unauthorized");
    } catch (error) {
      expect(error instanceof UnauthorizedException).toBe(true);
    }
    try {
      guard.canActivate(contextFor({ "x-api-key": "wrong" }));
      throw new Error("expected unauthorized");
    } catch (error) {
      expect(error instanceof UnauthorizedException).toBe(true);
    }
  });

  test("does not bypass a route with missing configuration", () => {
    delete process.env.API_KEY;
    const reflector = {
      getAllAndOverride: () => "API_KEY",
    } as unknown as Reflector;
    const guard = new ApiKeyGuard(reflector);

    try {
      guard.canActivate(contextFor({}));
      throw new Error("expected missing configuration");
    } catch (error) {
      expect(error instanceof UnauthorizedException).toBe(false);
    }
  });
});
