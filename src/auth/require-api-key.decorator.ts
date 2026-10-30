import { SetMetadata } from "@nestjs/common";
import { API_KEY_ENV } from "./api-key.guard";

export const RequireApiKey = (environmentVariable: string) =>
  SetMetadata(API_KEY_ENV, environmentVariable);
