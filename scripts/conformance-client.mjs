/**
 * Local runner for `pnpm run conformance:client`.
 *
 * Runs every client scenario the pinned `@modelcontextprotocol/conformance` tool offers against
 * `test/conformance/client-fixture.ts` (booted straight from TypeScript source through Node's own
 * type stripping), one invocation per scenario, with `conformance-baseline-client.yml` applied to
 * each so known failures pass while regressions — and stale baseline entries — fail.
 *
 * Environment overrides:
 *   CONFORMANCE_PACKAGE   npx spec of the tool           (default @modelcontextprotocol/conformance@0.1.16)
 *   CONFORMANCE_BASELINE  baseline path, repo-relative   (default conformance-baseline-client.yml)
 *   CONFORMANCE_SCENARIOS comma-separated subset to run  (default: everything `list --client` prints)
 *   CONFORMANCE_TIMEOUT   per-scenario client timeout ms (default 60000)
 *
 * Dependency-free Node. Exits non-zero if any scenario fails.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFORMANCE = process.env.CONFORMANCE_PACKAGE ?? "@modelcontextprotocol/conformance@0.1.16";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const fixture = join("test", "conformance", "client-fixture.ts");
const baseline = join(
	repoRoot,
	process.env.CONFORMANCE_BASELINE ?? "conformance-baseline-client.yml",
);
const timeout = process.env.CONFORMANCE_TIMEOUT ?? "60000";
const baselineArgs = existsSync(baseline) ? ["--expected-failures", baseline] : [];
const command = `${process.execPath} --experimental-strip-types ${fixture}`;

/** Scenario names listed under `client:` in the baseline file (a minimal YAML list parser). */
function baselinedScenarios() {
	if (!existsSync(baseline)) return new Set();
	const names = new Set();
	let inClient = false;
	for (const rawLine of readFileSync(baseline, "utf8").split("\n")) {
		const line = rawLine.replace(/#.*$/, "").trimEnd();
		if (/^client:\s*(\[\s*\])?$/.test(line)) {
			inClient = true;
			continue;
		}
		if (/^\S/.test(line) && line.length > 0) inClient = false;
		const item = inClient ? /^\s*-\s*(\S+)/.exec(line)?.[1] : undefined;
		if (item !== undefined) names.add(item);
	}
	return names;
}

/** Runs the tool once; resolves with `{ code, stdout }`. Output is echoed unless `capture` is set. */
function runTool(args, capture = false) {
	return new Promise((resolve) => {
		if (!capture) console.log(`\n> npx --yes ${CONFORMANCE} ${args.join(" ")}\n`);
		const child = spawn("npx", ["--yes", CONFORMANCE, ...args], {
			cwd: repoRoot,
			stdio: ["ignore", "pipe", capture ? "inherit" : "pipe"],
		});
		let stdout = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
			if (!capture) process.stdout.write(chunk);
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			stdout += chunk;
			process.stderr.write(chunk);
		});
		child.on("error", (error) => {
			console.error(`✗ could not run npx: ${error.message}`);
			resolve({ code: 1, stdout });
		});
		child.on("exit", (code) => resolve({ code: code ?? 1, stdout }));
	});
}

/** The scenario names `list --client` prints (`  - <name> [versions]`). */
async function listScenarios() {
	const { code, stdout } = await runTool(["list", "--client"], true);
	if (code !== 0) throw new Error("could not list client scenarios");
	return stdout
		.split("\n")
		.map((line) => /^\s*-\s+(\S+)/.exec(line)?.[1])
		.filter((name) => name !== undefined);
}

const requested = process.env.CONFORMANCE_SCENARIOS;
const scenarios =
	requested === undefined || requested.length === 0
		? await listScenarios()
		: requested
				.split(",")
				.map((name) => name.trim())
				.filter((name) => name.length > 0);

console.log(`Client scenarios (${scenarios.length}): ${scenarios.join(", ")}`);
const expectedFailures = baselinedScenarios();
const failed = [];
for (const scenario of scenarios) {
	const { code, stdout } = await runTool([
		"client",
		"--command",
		command,
		"--scenario",
		scenario,
		"--timeout",
		timeout,
		...baselineArgs,
	]);
	// The tool exits 0 under a baseline even when the CLIENT crashed or timed out, since a
	// crash records no failing check. Treat those as failures unless the scenario is baselined.
	const clientBroke = /CLIENT EXITED WITH ERROR|Client timed out after/.test(stdout);
	if (code !== 0 || (clientBroke && !expectedFailures.has(scenario))) failed.push(scenario);
}

if (failed.length > 0) {
	console.error(`\n✗ ${failed.length} client scenario(s) failed: ${failed.join(", ")}`);
	process.exit(1);
}
console.log(`\n✓ all ${scenarios.length} client scenarios passed (baseline applied)`);
