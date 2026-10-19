// Vite's `import.meta.glob` (bundled at build time), used to find extensions (extensions/*/server.ts) and, in tests, the site's static files.
interface ImportMeta {
	glob<T = unknown>(pattern: string, options: { eager: true; query?: string; import?: string }): Record<string, T>;
}
