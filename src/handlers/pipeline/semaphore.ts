import { logger } from "../../logger.ts";

export class Semaphore {
  private maxConcurrent: number;
  private currentConcurrent: number = 0;
  private queue: Array<(value?: unknown) => void> = [];
  private name: string;

  constructor(maxConcurrent: number, name: string = "Semaphore") {
    this.maxConcurrent = maxConcurrent;
    this.name = name;
  }

  acquire(): Promise<unknown> {
    return new Promise((resolve) => {
      if (this.currentConcurrent < this.maxConcurrent) {
        this.currentConcurrent++;
        logger.debug(
          `${this.name} acquired, current concurrent: ${this.currentConcurrent}`,
        );
        resolve(undefined);
      } else {
        logger.debug(`${this.name} full, queuing request`);
        this.queue.push(resolve);
        logger.debug(`${this.name} queue length: ${this.queue.length}`);
      }
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      logger.debug(
        `${this.name} released, current concurrent: ${this.currentConcurrent}`,
      );
      if (next) next();
    } else {
      logger.debug(`${this.name} released`);
      this.currentConcurrent--;
    }
  }

  setMaxConcurrent(max: number): void {
    this.maxConcurrent = max;
    while (
      this.currentConcurrent < this.maxConcurrent && this.queue.length > 0
    ) {
      const next = this.queue.shift();
      this.currentConcurrent++;
      if (next) next();
    }
  }
}
