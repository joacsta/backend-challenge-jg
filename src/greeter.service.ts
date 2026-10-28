import { Injectable } from "@nestjs/common";

@Injectable()
export class GretterService {
  hello() {
    return "hello from the service";
  }
}
