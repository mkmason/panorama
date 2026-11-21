/**
 * Parse the leading top-level JSON value from a string, ignoring any trailing bytes.
 *
 * `$.AsyncWebRequest` appends a stray trailing character (a NUL terminator) after the response body, which
 * trips a plain `JSON.parse`. This walks the string tracking brace/bracket depth (skipping string contents)
 * and parses just the first complete `{...}` / `[...]`, so the trailing NUL is dropped. Same technique the
 * Stats page uses inline (PANORAMA_NOTES 3); shared here for the web-fetching HUD elements.
 *
 * Returns `null` (never throws) if the text can't be parsed.
 */
export function parseLeadingJson<T = any>(txt: string): T | null {
	try {
		let depth = 0;
		let inStr = false;
		let esc = false;
		let end = -1;
		for (let i = 0; i < txt.length; i++) {
			const c = txt[i];
			if (inStr) {
				if (esc) esc = false;
				else if (c === '\\') esc = true;
				else if (c === '"') inStr = false;
			} else if (c === '"') inStr = true;
			else if (c === '{' || c === '[') depth++;
			else if (c === '}' || c === ']') {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		return JSON.parse(end >= 0 ? txt.slice(0, end + 1) : txt);
	} catch {
		return null;
	}
}
