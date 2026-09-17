# @ccc/plugin -- Claude Command Center (Obsidian plugin)

The Obsidian-side half of Claude Command Center: one command-center view
(`claude-command-center-view`), reachable from the command palette and the
ribbon, that talks to the local companion service over the authenticated
Unix domain socket client in `@ccc/service-api-client`. Structural markup
only in this phase -- Phase 3 selects the visual direction from real
prototypes.

## Development loop (REPO-08: rebuild and hot-reload without restarting Obsidian)

Obsidian loads a plugin from a directory inside a vault's
`.obsidian/plugins/` folder, so the fastest loop is: symlink this package
into a real (throwaway, development-only) vault, run the watch build, and
let the community `hot-reload` plugin pick up every rebuild automatically.

1. **Pick or create a development vault.** Any Obsidian vault works, as
   long as it isn't one you care about losing to an in-progress bug --
   `~/Obsidian/ccc-dev` (or any path you choose) is fine.

2. **Symlink this package into that vault's plugins folder:**

   ```sh
   mkdir -p "<development vault>/.obsidian/plugins"
   ln -s "$(pwd)" "<development vault>/.obsidian/plugins/claude-command-center"
   ```

   Replace `<development vault>` with your own vault's path (for example
   `~/Obsidian/ccc-dev`) -- do not commit a real path anywhere in this
   repository.

3. **Install the [`hot-reload`](https://github.com/pjeby/hot-reload)
   community plugin into the same development vault.** It watches any
   plugin directory containing a `.hotreload` marker file (this package
   tracks one at `packages/plugin/.hotreload`) and disables/re-enables the
   plugin roughly three quarters of a second after `main.js`/`styles.css`
   change and settle -- that's what makes a rebuild visible without
   restarting the editor.

4. **Run the watch build** from the repository root:

   ```sh
   pnpm --filter @ccc/plugin dev
   ```

   Every save under `packages/plugin/src/` rebuilds `main.js` and
   `styles.css` at the plugin root. Both files are build artifacts and are
   git-ignored -- only the TypeScript/CSS sources under `src/` and the
   `.hotreload` marker are tracked.

5. **One-time step:** open the development vault in Obsidian, go to
   Settings -> Community plugins, and enable both `hot-reload` and
   `Claude command center`.

6. **Confirm the loop works:** with the watch task running and `hot-reload`
   enabled, edit a visible string in `src/view/shell.tsx` (for example a
   destination label) and save. The running Obsidian instance should show
   the new string within about a second, with no manual reload and no
   editor restart.

## Build

```sh
pnpm --filter @ccc/plugin build
```

Produces `main.js` and `styles.css` at the plugin root from
`src/main.ts`/`src/styles.css` via `esbuild.config.mjs` (`outbase: "src"`,
`outdir: "."`). Both outputs are git-ignored; `manifest.json`'s `version`
is kept identical to this package's `package.json` `version`, since
Obsidian's loader and the release convention both require them to agree.
