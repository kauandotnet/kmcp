import type { ReadResourceResult, Resource } from "@modelcontextprotocol/client";

import { KMCP_ERROR_CODES, KmcpError } from "../errors.ts";

/**
 * The experimental MCP skills extension (SEP-2640, `io.modelcontextprotocol/skills`).
 *
 * Skills are a URI convention over the resources primitive: each skill lives at
 * `skill://<path>/SKILL.md` (markdown with YAML front matter), servers MAY publish a discovery
 * index at `skill://index.json`, and MAY advertise the extension under
 * `capabilities.extensions["io.modelcontextprotocol/skills"]`. Everything here is sugar over
 * `resources/read` and `resources/list`, so it works against any compliant server.
 */

export const MCP_SKILLS_INDEX_URI = "skill://index.json";
export const MCP_SKILLS_EXTENSION_KEY = "io.modelcontextprotocol/skills";

export type McpSkillType = "skill-md" | "archive" | "mcp-resource-template";

export interface McpSkill {
	readonly name: string;
	readonly description: string;
	readonly type: McpSkillType;
	/** The `SKILL.md` resource URI, or an RFC 6570 template for `mcp-resource-template` entries. */
	readonly url: string;
}

/** The two resource verbs skill discovery needs; the manager binds them to one connection. */
export interface McpSkillReader {
	readResource(uri: string): Promise<ReadResourceResult>;
	listResources(): Promise<{ readonly resources: readonly Resource[] }>;
}

const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_SKILLS = 10_000;
const SKILL_MD_PATTERN = /^skill:\/\/((?:[^/]+\/)*[^/]+)\/SKILL\.md$/;

/** The first text content item of a read result, or `undefined` when every item is a blob. */
export function skillTextContent(result: ReadResourceResult): string | undefined {
	for (const item of result.contents) {
		if ("text" in item && typeof item.text === "string") return item.text;
	}
	return undefined;
}

/**
 * Parses a `skill://index.json` document. Malformed entries are dropped rather than failing the
 * whole index (the specification tells hosts to be permissive); a document that is not a JSON
 * object at all is an error.
 */
export function parseSkillsIndex(text: string): readonly McpSkill[] {
	if (text.length > MAX_INDEX_BYTES) {
		throw new KmcpError(
			KMCP_ERROR_CODES.RESULT_TOO_LARGE,
			`The skills index at ${MCP_SKILLS_INDEX_URI} exceeds ${MAX_INDEX_BYTES} bytes.`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new KmcpError(
			KMCP_ERROR_CODES.OPERATION_FAILED,
			`The skills index at ${MCP_SKILLS_INDEX_URI} is not valid JSON.`,
			{ cause: error },
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new KmcpError(
			KMCP_ERROR_CODES.OPERATION_FAILED,
			`The skills index at ${MCP_SKILLS_INDEX_URI} is not a JSON object.`,
		);
	}
	const raw = (parsed as { readonly skills?: unknown }).skills;
	if (!Array.isArray(raw)) return Object.freeze([]);
	const skills: McpSkill[] = [];
	for (const entry of raw.slice(0, MAX_SKILLS)) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (typeof record.url !== "string" || record.url.length === 0) continue;
		const type = typeof record.type === "string" ? record.type : "skill-md";
		if (type !== "skill-md" && type !== "archive" && type !== "mcp-resource-template") continue;
		let name: string;
		if (typeof record.name === "string" && record.name.length > 0) name = record.name;
		else if (type === "mcp-resource-template") name = displayNameFromUrl(record.url);
		else continue;
		skills.push(
			Object.freeze({
				name,
				description: typeof record.description === "string" ? record.description : "",
				type,
				url: record.url,
			}),
		);
	}
	return Object.freeze(skills);
}

/** Derives a display name from a template URL: the segment before `SKILL.md`, else the last segment. */
function displayNameFromUrl(url: string): string {
	const schemeEnd = url.indexOf("://");
	const path = schemeEnd >= 0 ? url.slice(schemeEnd + 3) : url;
	const parts = path.split("/").filter((part) => part.length > 0);
	if (parts.length === 0) return url;
	const last = parts[parts.length - 1] as string;
	if (last === "SKILL.md" && parts.length >= 2) return parts[parts.length - 2] as string;
	return last;
}

/** Fallback discovery: every listed resource whose URI is `skill://<path>/SKILL.md`. */
export function skillsFromResources(resources: readonly Resource[]): readonly McpSkill[] {
	const skills: McpSkill[] = [];
	for (const resource of resources) {
		const match = SKILL_MD_PATTERN.exec(resource.uri);
		const path = match?.[1];
		if (path === undefined) continue;
		const lastSlash = path.lastIndexOf("/");
		skills.push(
			Object.freeze({
				name: resource.name || (lastSlash >= 0 ? path.slice(lastSlash + 1) : path),
				description: resource.description ?? "",
				type: "skill-md" as const,
				url: resource.uri,
			}),
		);
	}
	return Object.freeze(skills);
}

/**
 * Discovers the skills a server exposes: the well-known index first, then a scan of the resource
 * list for `SKILL.md` URIs. The specification forbids treating an absent index as proof that a
 * server has no skills, hence the fallback.
 */
export async function discoverSkills(reader: McpSkillReader): Promise<readonly McpSkill[]> {
	let indexText: string | undefined;
	try {
		indexText = skillTextContent(await reader.readResource(MCP_SKILLS_INDEX_URI));
	} catch {
		indexText = undefined;
	}
	if (indexText !== undefined) return parseSkillsIndex(indexText);
	const listed = await reader.listResources();
	return skillsFromResources(listed.resources);
}

/**
 * Resolves a skill reference into a `SKILL.md` URI: a bare name (`git-workflow`), a nested path
 * (`acme/billing/refunds`), or a full `skill://` URI (a directory URI gets `/SKILL.md` appended).
 */
export function resolveSkillUri(reference: string): string {
	const trimmed = reference.trim();
	if (trimmed.length === 0) {
		throw new KmcpError(KMCP_ERROR_CODES.INVALID_DEFINITION, "A skill reference is required.");
	}
	if (trimmed.startsWith("skill://")) {
		const rest = trimmed.slice("skill://".length);
		const lastSegment = rest.slice(rest.lastIndexOf("/") + 1);
		if (lastSegment.includes(".")) return trimmed;
		return trimmed.endsWith("/") ? `${trimmed}SKILL.md` : `${trimmed}/SKILL.md`;
	}
	const path = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
	if (path.length === 0 || path.split("/").some((segment) => segment === "." || segment === "..")) {
		throw new KmcpError(
			KMCP_ERROR_CODES.INVALID_DEFINITION,
			`'${reference}' is not a valid skill reference.`,
		);
	}
	return `skill://${path}/SKILL.md`;
}
