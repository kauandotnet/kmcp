import assert from "node:assert/strict";
import test from "node:test";

import { stdioConnection } from "../src/node.ts";

test("stdio definitions compare by command line, env names and cwd, never env values", () => {
	const build = (env: Record<string, string>, args = ["-y", "pkg"]) =>
		stdioConnection({ id: "s", stdio: { command: "npx", args, env, cwd: "/tmp" } });
	assert.equal(build({ TOKEN: "a" }).fingerprint, build({ TOKEN: "b" }).fingerprint);
	assert.notEqual(build({ TOKEN: "a" }).fingerprint, build({ OTHER: "a" }).fingerprint);
	assert.notEqual(build({}).fingerprint, build({}, ["-y", "other"]).fingerprint);
	assert.equal(
		stdioConnection({ id: "s", stdio: { command: "npx" }, fingerprint: "rev-1" }).fingerprint,
		"rev-1",
	);
});
