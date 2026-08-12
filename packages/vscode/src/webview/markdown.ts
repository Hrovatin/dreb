import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Render assistant Markdown to sanitized HTML for the answer pane. Model output
 * is untrusted, so every rendered string passes through DOMPurify before it
 * reaches the DOM.
 */
export function renderMarkdown(text: string): string {
	const html = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
	return DOMPurify.sanitize(html);
}
