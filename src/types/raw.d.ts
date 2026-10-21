// Data files bundled as text (Vite `?raw` imports), e.g. a plugin's CSV tables.
declare module '*.csv?raw' {
	const text: string;
	export default text;
}
// The page itself, read by tests (which icons it links).
declare module '*.html?raw' {
	const text: string;
	export default text;
}
// A migration's SQL, read by tests that run it on rows of their own.
declare module '*.sql?raw' {
	const text: string;
	export default text;
}
