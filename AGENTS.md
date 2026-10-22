# Custom BB plugins

This is an npm workspace containing independent BB plugins in `plugins/`.
The root package is private; each plugin's `package.json` is its BB manifest.

- Use the `bb-plugin-authoring` skill and installed SDK declarations for APIs.
- Scaffold new plugins with `bb plugin new <name>` from `plugins/`.
- Register each plugin in `.bb/plugins.json`; give it a unique package name,
  CLI command, human-facing name, and skill documentation.
- Add `build`, `typecheck`, and `sdk:check` scripts following the starter.
- Keep SDK and host-shimmed packages in devDependencies; other runtime
  imports belong in dependencies. Use `bb plugin types` after BB upgrades.
- Keep secrets out of source and frontend code. Dispose listeners, services,
  timers, and other resources on unload.
- Run `npm run check` from the root. Add behavioral tests when the plugin's
  functionality needs them; building alone does not verify live behavior.
- Document plugin commands and operating constraints in its `skills/`.
- Keep `node_modules/`, `dist/`, and environment files out of Git. Use the
  root lockfile for reproducible workspace installs.

See README.md for local installation and the watch/reload loop.
