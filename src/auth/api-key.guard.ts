import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

export const API_KEY_ENV = Symbol("api-key-env");

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const envName = this.reflector.getAllAndOverride<string>(API_KEY_ENV, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!envName) {
      return true;
    }

    const expected = process.env[envName];
    if (!expected) {
      throw new InternalServerErrorException(
        `Required authentication configuration ${envName} is missing`,
      );
    }

    const request = context.switchToHttp().getRequest<{ headers?: Record<string, string | string[]> }>();
    const supplied = request.headers?.["x-api-key"];
    const apiKey = Array.isArray(supplied) ? supplied[0] : supplied;
    if (!apiKey || apiKey !== expected) {
      throw new UnauthorizedException("Invalid API key");
    }

    return true;
  }
}
