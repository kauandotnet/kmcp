/**
 * Local runner for `pnpm run conformance:server`.
 *
 * Boots the everything-server fixture over HTTP straight from TypeScript source (Node's own type
 * stripping — no build, no dev dependency), waits for its readiness line, then runs the official
 * MCP conformance suite against it twice:
 *   1. the default `active` suite (every non-pending server scenario), and
 *   2. the same suite filtered to the newest revision via `--spec-version draft`.
 *
 * The committed baseline (`conformance-baseline.yml`) is applied so known failures pass while new
 * regressions fail — and a baselined scenario that starts passing fails too, so the list cannot
 * rot. The tool version is pinned for reproducibility; the nightly workflow overrides all three
 * knobs below to run the tool's git main over the `all` suite against
 * `conformance-baseline-main.yml`.
 *
 * Environment overrides:
 *   CONFORMANCE_FIXTURE   fixture path, repo-relative   (default test/conformance/server-fixture.ts;
 *                         `pnpm run conformance:gateway` points it at gateway-fixture.ts)
 *   CONFORMANCE_PACKAGE   npx spec of the tool          (default @modelcontextprotocol/conformance@0.1.16)
 *   CONFORMANCE_SUITE     active | all | pending        (default active)
 *   CONFORMANCE_BASELINE  baseline path, repo-relative  (default conformance-baseline.yml)
 *   PORT                  fixture port                  (default 39750)
 *
 * Notes on the `draft` filter (verified against @modelcontextprotocol/conformance 0.1.16):
 * `--spec-version 2026-07-28` is rejected ("Unknown spec version"; valid: 2025-03-26, 2025-06-18,
 * 2025-11-25, draft, extension), so `draft` is the selector for the newest revision. In 0.1.16 no
 * *server* scenario is draft- or extension-tagged, so run #2 executes 0 scenarios today. It is
 * wired now so 2026-07-28 server scenarios are picked up automatically when the tool ships them
 * (or when the pin is bumped).
 *
 * Dependency-free Node. Exits non-zero if either pass fails, and always kills the fixture.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFORMANCE = process.env.CONFORMANCE_PACKAGE ?? "@modelcontextprotocol/conformance@0.1.16";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const fixture = join(
	repoRoot,
	process.env.CONFORMANCE_FIXTURE ?? join("test", "conformance", "server-fixture.ts"),
);
const baseline = join(repoRoot, process.env.CONFORMANCE_BASELINE ?? "conformance-baseline.yml");
const suite = process.env.CONFORMANCE_SUITE ?? "active";
const PORT = process.env.PORT ?? "39750";
const url = `http://127.0.0.1:${PORT}/mcp`;
const BOOT_TIMEOUT_MS = 60_000;

const baselineArgs = existsSync(baseline) ? ["--expected-failures", baseline] : [];

/** Runs one conformance invocation; resolves `true` when it exits non-zero. */
function runConformance(args) {
	return new Promise((resolve) => {
		console.log(`\n> npx --yes ${CONFORMANCE} ${args.join(" ")}\n`);
		const child = spawn("npx", ["--yes", CONFORMANCE, ...args], { stdio: "inherit" });
		child.on("error", (error) => {
			console.error(`✗ could not run npx: ${error.message}`);
			resolve(true);
		});
		child.on("exit", (code) => resolve(code !== 0));
	});
}

/** Boots the fixture and resolves once it prints its readiness line. */
function bootFixture() {
	const child = spawn(process.execPath, ["--experimental-strip-types", fixture], {
		cwd: repoRoot,
		env: { ...process.env, PORT },
		stdio: ["ignore", "pipe", "inherit"],
		detached: true,
	});
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			// Reap the detached child here: the caller's `finally` cannot, because `server` was
			// never assigned when boot times out.
			stopFixture(child);
			reject(new Error(`fixture did not become ready within ${BOOT_TIMEOUT_MS / 1000}s`));
		}, BOOT_TIMEOUT_MS);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			process.stdout.write(chunk);
			if (chunk.includes("listening on")) {
				clearTimeout(timer);
				resolve(child);
			}
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`fixture exited before readiness (code ${code})`));
		});
	});
}

/** Kills the fixture process group started with `detached: true`. */
function stopFixture(child) {
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		// already gone
	}
}

let server;
let anyFailed = false;
try {
	server = await bootFixture();
	const common = ["server", "--url", url, "--suite", suite, ...baselineArgs];
	anyFailed = (await runConformance(common)) || anyFailed;
	anyFailed = (await runConformance([...common, "--spec-version", "draft"])) || anyFailed;
} catch (error) {
	console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
	anyFailed = true;
} finally {
	if (server) stopFixture(server);
}

process.exit(anyFailed ? 1 : 0);
