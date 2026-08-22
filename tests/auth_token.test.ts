import { assert, assertEquals } from "std/assert/mod.ts";
import jwt from "jsonwebtoken";
import { expiryOf } from "../src/middleware/auth.ts";
import { config } from "../src/config.ts";
import { UserAuthSchema } from "../src/middleware/validator.ts";

const SECRET = "test-secret";

Deno.test("token expiry - the default lifetime is a day, not a month", () => {
  // The finding: 31d existed so the app could skip renewal. It does not skip
  // renewal any more, so the month has to go with it.
  assertEquals(config.auth.tokenExpiry, "24h");
});

Deno.test("token expiry - expiryOf reads the exp claim back", () => {
  const before = Math.floor(Date.now() / 1000);
  const token = jwt.sign({ id: "u1" }, SECRET, { expiresIn: "24h" });
  const exp = expiryOf(token);

  assert(exp !== null);
  // A day out, give or take the second this test takes to run.
  const day = 24 * 60 * 60;
  assert(exp >= before + day - 5, `${exp} too early`);
  assert(exp <= before + day + 5, `${exp} too late`);
});

Deno.test("token expiry - expiryOf returns null rather than throwing on junk", () => {
  // The client schedules its renewal off this value; a throw here would take
  // down the login response, which is worse than not scheduling.
  assertEquals(expiryOf("not-a-jwt"), null);
  assertEquals(expiryOf(""), null);
  // A token with no exp claim is well-formed but unschedulable.
  assertEquals(expiryOf(jwt.sign({ id: "u1" }, SECRET)), null);
});

Deno.test("login schema - a client can no longer name its own token lifetime", () => {
  // expiry_time used to be an unbounded string the caller supplied, so a
  // caller could ask for a year and get it. The server decides now.
  const parsed = UserAuthSchema.safeParse({
    username: "alice",
    password: "hunter2",
    expiry_time: "3650d",
  });

  assert(parsed.success);
  assertEquals("expiry_time" in parsed.data, false);
  assertEquals(Object.keys(parsed.data).sort(), ["password", "username"]);
});

Deno.test("login schema - still requires both credentials", () => {
  assertEquals(UserAuthSchema.safeParse({ username: "alice" }).success, false);
  assertEquals(
    UserAuthSchema.safeParse({ password: "hunter2" }).success,
    false,
  );
});
