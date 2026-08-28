import test, { type TestContext } from "node:test";
import { PassThrough } from "node:stream";

import { Client, type ClientOptions } from "@modelcontextprotocol/client";
import type { AuthInfo, CreateMcpHandlerOptions } from "@modelcontextprotocol/server";

import { inProcessConnection, type McpInProcessServer } from "../../src/client/connection.ts";
import type { McpProtocolEra } from "../../src/internal/protocol.ts";

export const ERAS: readonly McpProtocolEra[] = ["modern", "legacy"];

export interface TestClient {
	readonly client: Client;
	readonly era: McpProtocolEra;
	close(): Promise<void>;
}

export interface TestClientOptions {
	readonly era: McpProtocolEra;
	readonly clientOptions?: ClientOptions;
	readonly mcp?: CreateMcpHandlerOptions;
	readonly authInfo?: AuthInfo;
}

/** Connects a raw official `Client` to a kmcp definition in-process, in the requested era. */
export async function createTestClient(
	definition: McpInProcessServer,
	options: TestClientOptions,
): Promise<TestClient> {
	const connection = inProcessConnection({
		id: "test",
		definition,
		era: options.era,
		...(options.mcp === undefined ? {} : { mcp: options.mcp }),
		...(options.authInfo === undefined ? {} : { authInfo: options.authInfo }),
		...(options.clientOptions === undefined ? {} : { clientOptions: options.clientOptions }),
	});
	const transport = await connection.openTransport();
	const client = new Client(connection.clientInfo, connection.clientOptions);
	try {
		await client.connect(transport, connection.connectOptions);
	} catch (error) {
		await transport.close().catch(() => undefined);
		throw error;
	}
	const negotiated = client.getProtocolEra();
	if (negotiated !== options.era) {
		await client.close().catch(() => undefined);
		throw new Error(`Expected to negotiate era '${options.era}' but got '${negotiated}'.`);
	}
	return { client, era: options.era, close: () => client.close() };
}

/** Registers one `node:test` case per protocol era. */
export function forEachEra(
	name: string,
	body: (era: McpProtocolEra, t: TestContext) => Promise<void> | void,
): void {
	for (const era of ERAS) {
		test(`${name} [${era}]`, (t) => body(era, t));
	}
}

/** Two cross-wired pipes forming an in-process stdio wire. */
export function stdioPipePair(): {
	readonly clientToServer: PassThrough;
	readonly serverToClient: PassThrough;
} {
	return { clientToServer: new PassThrough(), serverToClient: new PassThrough() };
}
