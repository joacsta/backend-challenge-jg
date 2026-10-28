import { Injectable, LoggerService } from "@nestjs/common";

@Injectable()
export class StructuredLoggerService implements LoggerService {
  log(message: any, ...optionalParams: any[]) {
    this.write("info", message, optionalParams);
  }

  error(message: any, ...optionalParams: any[]) {
    this.write("error", message, optionalParams);
  }

  warn(message: any, ...optionalParams: any[]) {
    this.write("warn", message, optionalParams);
  }

  debug(message: any, ...optionalParams: any[]) {
    this.write("debug", message, optionalParams);
  }

  verbose(message: any, ...optionalParams: any[]) {
    this.write("verbose", message, optionalParams);
  }

  private write(level: string, message: any, optionalParams: any[]) {
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      message,
      details: optionalParams.length > 0 ? optionalParams : undefined,
    };

    console.log(JSON.stringify(payload));
  }
}
