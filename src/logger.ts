import color from "cli-color";

import { config } from "./config.ts";

export interface LogFields {
  [key: string]: string | number | boolean | Error | null | undefined;
}

const logLevels = ["trace", "debug", "verbose", "info", "warn", "error"];
const currentLogLevelIndex = logLevels.indexOf(config.logLevel);
const orange = color.xterm(208);
const honeyDew = color.xterm(194);

if (config.logDisableColors || !Deno.stdout.isTerminal()) {
  ((color as unknown) as { enabled: boolean }).enabled = false;
}

const logfmt = (level: string, message: string, fields: LogFields = {}) => {
  let logEntry = `level=${level} msg="${
    message
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r?\n/g, "\\n")
  }"`;
  logEntry += ` ts=${new Date().toISOString()}`;
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") {
      logEntry += ` ${key}="${
        value
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\r?\n/g, "\\n")
      }"`;
    } else if (value instanceof Error) {
      logEntry += ` ${key}="${
        value.message
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"')
          .replace(/\r?\n/g, "\\n")
      }"`;
      if (value.stack) {
        logEntry += ` ${key}_stack="${
          value.stack
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\r?\n/g, "\\n")
        }"`;
      }
    } else if (value === null || value === undefined) {
      logEntry += ` ${key}=null`;
    } else {
      logEntry += ` ${key}=${value}`;
    }
  }
  return logEntry;
};

export const logger = {
  trace: (message: string, fields: LogFields = {}) => {
    if (currentLogLevelIndex <= logLevels.indexOf("trace")) {
      console.debug(honeyDew(logfmt("trace", message, fields)));
    }
  },
  debug: (message: string, fields: LogFields = {}) => {
    if (currentLogLevelIndex <= logLevels.indexOf("debug")) {
      console.debug(color.magentaBright(logfmt("debug", message, fields)));
    }
  },
  info: (message: string, fields: LogFields = {}) => {
    if (currentLogLevelIndex <= logLevels.indexOf("info")) {
      console.log(color.blueBright(logfmt("info", message, fields)));
    }
  },
  warn: (message: string, fields: LogFields = {}) => {
    if (currentLogLevelIndex <= logLevels.indexOf("warn")) {
      console.warn(orange(logfmt("warn", message, fields)));
    }
  },
  error: (message: string, fields: LogFields = {}) => {
    if (currentLogLevelIndex <= logLevels.indexOf("error")) {
      console.error(color.redBright(logfmt("error", message, fields)));
    }
  },
};
