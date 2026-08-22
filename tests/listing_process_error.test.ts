import { assert, assertEquals } from "std/assert/mod.ts";
import {
  ListingProcessError,
  ProcessExitCodes,
} from "../src/handlers/pipeline/types.ts";

Deno.test("ListingProcessError - keeps the historical message shape", () => {
  // The message is logged and emitted on `listing-error`; the frontend renders
  // it verbatim, so the shape is part of the contract.
  assertEquals(
    new ListingProcessError(1).message,
    "Process exited with code 1",
  );
  assertEquals(
    new ListingProcessError(1, "No video could be found in this tweet").message,
    "Process exited with code 1: No video could be found in this tweet",
  );
});

Deno.test("ListingProcessError - a cancellation is classified by exit code", () => {
  assert(new ListingProcessError(null).isDeliberateTermination);
  assert(
    new ListingProcessError(ProcessExitCodes.SIGTERM).isDeliberateTermination,
  );
});

Deno.test("ListingProcessError - a cancellation with stderr is still a cancellation", () => {
  // Q4: the old check compared `message` to two literals, so a SIGTERM that
  // happened to have stderr on it ("Process exited with code 143: <reason>")
  // failed both comparisons and surfaced to the user as a listing failure.
  const killed = new ListingProcessError(
    ProcessExitCodes.SIGTERM,
    "Interrupted by user",
  );
  assertEquals(
    killed.message,
    "Process exited with code 143: Interrupted by user",
  );
  assert(killed.isDeliberateTermination);

  const noCode = new ListingProcessError(null, "Interrupted by user");
  assert(noCode.isDeliberateTermination);
});

Deno.test("ListingProcessError - a genuine failure is not a cancellation", () => {
  assertEquals(
    new ListingProcessError(ProcessExitCodes.PARTIAL_ERROR)
      .isDeliberateTermination,
    false,
  );
  assertEquals(new ListingProcessError(2).isDeliberateTermination, false);
});

Deno.test("ListingProcessError - is an Error and is narrowable by instanceof", () => {
  const error: Error = new ListingProcessError(143, "reason");
  assert(error instanceof Error);
  assert(error instanceof ListingProcessError);
  assertEquals(error.name, "ListingProcessError");
  assertEquals((error as ListingProcessError).exitCode, 143);
  assertEquals((error as ListingProcessError).reason, "reason");
});
