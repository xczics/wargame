// Vite's `import.meta.glob` (bundled at build time), used to find extensions (extensions/*/server.ts).
interface ImportMeta {
	glob<T = unknown>(pattern: string, options: { eager: true }): Record<string, T>;
}
