import type { Implementation, ServerOptions } from "@modelcontextprotocol/server";

import type { AnyMcpCapabilityDefinition, McpCapabilityKey } from "./capability.ts";
import { McpServerDefinition } from "./server-definition.ts";

export class McpServerBuilder<Keys extends string = never> {
	declare protected readonly keysInvariant: (keys: Keys) => Keys;

	readonly #serverInfo: Implementation;
	readonly #sdkOptions: ServerOptions | undefined;
	readonly #capabilities: readonly AnyMcpCapabilityDefinition[];

	private constructor(
		serverInfo: Implementation,
		sdkOptions: ServerOptions | undefined,
		capabilities: readonly AnyMcpCapabilityDefinition[],
	) {
		this.#serverInfo = serverInfo;
		this.#sdkOptions = sdkOptions;
		this.#capabilities = capabilities;
	}

	static create(serverInfo: Implementation, sdkOptions?: ServerOptions): McpServerBuilder {
		return new McpServerBuilder(serverInfo, sdkOptions, []);
	}

	add<const Capability extends AnyMcpCapabilityDefinition>(
		capability: McpCapabilityKey<Capability> extends Keys ? never : Capability,
	): McpServerBuilder<Keys | McpCapabilityKey<Capability>> {
		return new McpServerBuilder(this.#serverInfo, this.#sdkOptions, [
			...this.#capabilities,
			capability,
		]);
	}

	tool<const Definition extends AnyMcpCapabilityDefinition>(
		definition: Definition["kind"] extends "tool"
			? McpCapabilityKey<Definition> extends Keys
				? never
				: Definition
			: never,
	): McpServerBuilder<Keys | McpCapabilityKey<Definition>> {
		return new McpServerBuilder(this.#serverInfo, this.#sdkOptions, [
			...this.#capabilities,
			definition,
		]);
	}

	prompt<const Definition extends AnyMcpCapabilityDefinition>(
		definition: Definition["kind"] extends "prompt"
			? McpCapabilityKey<Definition> extends Keys
				? never
				: Definition
			: never,
	): McpServerBuilder<Keys | McpCapabilityKey<Definition>> {
		return new McpServerBuilder(this.#serverInfo, this.#sdkOptions, [
			...this.#capabilities,
			definition,
		]);
	}

	resource<const Definition extends AnyMcpCapabilityDefinition>(
		definition: Definition["kind"] extends "resource"
			? McpCapabilityKey<Definition> extends Keys
				? never
				: Definition
			: never,
	): McpServerBuilder<Keys | McpCapabilityKey<Definition>> {
		return new McpServerBuilder(this.#serverInfo, this.#sdkOptions, [
			...this.#capabilities,
			definition,
		]);
	}

	resourceTemplate<const Definition extends AnyMcpCapabilityDefinition>(
		definition: Definition["kind"] extends "resource-template"
			? McpCapabilityKey<Definition> extends Keys
				? never
				: Definition
			: never,
	): McpServerBuilder<Keys | McpCapabilityKey<Definition>> {
		return new McpServerBuilder(this.#serverInfo, this.#sdkOptions, [
			...this.#capabilities,
			definition,
		]);
	}

	build(): McpServerDefinition {
		return new McpServerDefinition(this.#serverInfo, {
			...(this.#sdkOptions === undefined ? {} : { sdk: this.#sdkOptions }),
			capabilities: this.#capabilities,
		});
	}
}
