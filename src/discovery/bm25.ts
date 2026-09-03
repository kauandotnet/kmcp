/** Hand-rolled Okapi BM25 over small in-memory catalogs (zero dependencies). */

export interface Bm25Document {
	readonly id: string;
	readonly text: string;
}

export function tokenize(text: string): readonly string[] {
	return (
		text
			.normalize("NFKC")
			.toLowerCase()
			.match(/[\p{L}\p{N}]{2,}/gu) ?? []
	);
}

const K1 = 1.5;
const B = 0.75;

export class Bm25Index {
	readonly #order: readonly string[];
	readonly #termFrequencies: ReadonlyMap<string, ReadonlyMap<string, number>>;
	readonly #documentLengths: ReadonlyMap<string, number>;
	readonly #documentFrequencies: ReadonlyMap<string, number>;
	readonly #averageLength: number;
	readonly #count: number;

	constructor(documents: readonly Bm25Document[]) {
		const order: string[] = [];
		const termFrequencies = new Map<string, Map<string, number>>();
		const documentLengths = new Map<string, number>();
		const documentFrequencies = new Map<string, number>();
		let totalLength = 0;
		for (const document of documents) {
			order.push(document.id);
			const tokens = tokenize(document.text);
			documentLengths.set(document.id, tokens.length);
			totalLength += tokens.length;
			const frequencies = new Map<string, number>();
			for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
			termFrequencies.set(document.id, frequencies);
			for (const token of frequencies.keys()) {
				documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
			}
		}
		this.#order = order;
		this.#termFrequencies = termFrequencies;
		this.#documentLengths = documentLengths;
		this.#documentFrequencies = documentFrequencies;
		this.#count = documents.length;
		this.#averageLength = this.#count === 0 ? 0 : totalLength / this.#count;
	}

	/** Document ids ranked best-first; zero-scoring documents are excluded. */
	search(query: string, limit: number): readonly string[] {
		const terms = [...new Set(tokenize(query))];
		if (terms.length === 0 || this.#count === 0) return [];
		const scores = new Map<string, number>();
		for (const term of terms) {
			const documentFrequency = this.#documentFrequencies.get(term);
			if (documentFrequency === undefined) continue;
			const idf = Math.log(1 + (this.#count - documentFrequency + 0.5) / (documentFrequency + 0.5));
			for (const id of this.#order) {
				const frequency = this.#termFrequencies.get(id)?.get(term) ?? 0;
				if (frequency === 0) continue;
				const length = this.#documentLengths.get(id) ?? 0;
				const denominator =
					frequency +
					K1 * (1 - B + (this.#averageLength === 0 ? 0 : B * (length / this.#averageLength)));
				scores.set(id, (scores.get(id) ?? 0) + idf * ((frequency * (K1 + 1)) / denominator));
			}
		}
		return [...scores.entries()]
			.filter(([, score]) => score > 0)
			.sort((left, right) => right[1] - left[1])
			.slice(0, limit)
			.map(([id]) => id);
	}
}
