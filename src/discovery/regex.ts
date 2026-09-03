/** Case-insensitive regex scorer: catalog order, invalid patterns yield no matches. */
export function regexSearch(
	documents: readonly { readonly id: string; readonly text: string }[],
	pattern: string,
	limit: number,
): readonly string[] {
	let expression: RegExp;
	try {
		expression = new RegExp(pattern, "iu");
	} catch {
		return [];
	}
	const matches: string[] = [];
	for (const document of documents) {
		if (matches.length >= limit) break;
		if (expression.test(document.text)) matches.push(document.id);
	}
	return matches;
}
