// Data files bundled as text (Vite `?raw` imports), e.g. a plugin's CSV tables.
declare module '*.csv?raw' {
	const text: string;
	export default text;
}
