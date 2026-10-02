# extensions/

Third-party plugins go here, one folder each: `extensions/<id>/server.ts` (the server plugin, default
export of `definePlugin`), optionally `client.ts` (a client plugin of its own, default export of
`defineClientPlugin`) with its `.vue` components, and `data/` for CSV tables and `i18n.csv`.

Both ends collect them at build time (`src/plugins.ts`, `web/plugins.ts`): no official file changes.
To try an example, copy it here: `cp -R examples/watchtower extensions/`.

See docs/plugin-guide.md (section 8, "扩展").
