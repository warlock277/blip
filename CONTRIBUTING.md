# Contributing to Blip

Thanks for your interest in making Blip better! 🎉 Whether it's a typo, a new
notification channel, or a whole feature, contributions are welcome.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating, you agree to uphold it. Please report unacceptable behavior to the
maintainers.

## Ways to contribute

- 🐛 **Report bugs** — use the [bug report form](.github/ISSUE_TEMPLATE/bug_report.yml).
- ✨ **Request features** — use the [feature request form](.github/ISSUE_TEMPLATE/feature_request.yml).
- 📖 **Improve docs** — anything under [`docs/`](docs/), the README, or example configs.
- 🧑‍💻 **Submit code** — bug fixes, new check types, new channels, UI polish.

For anything non-trivial, please open an issue or
[discussion](https://github.com/warlock277/blip/discussions) first so we can align on
the approach before you invest time.

## Project layout

Blip is an npm-workspaces monorepo (Node 20+, Node 22 in CI per `.nvmrc`):

```
packages/
  shared/      @blip/shared    — TypeScript types + helpers (the contract)
  worker/      @blip/worker    — Cloudflare Worker: probes, D1 store, serves the API + SPA
  dashboard/   @blip/dashboard — React + Vite SPA, reads /data/*.json
scripts/       setup.mjs, seed-demo.mjs, deploy.mjs, test-notify.mjs
config/        example config + permissions
docs/          documentation
data/          seeded demo output for local preview (generated; not edited by hand)
```

`packages/shared/src/types.ts` is the **single source of truth** for every data
shape. If you change the data the Worker writes or the dashboard reads, update the
types there first, then the example config and docs.

## Development setup

```bash
git clone https://github.com/<you>/blip.git
cd blip
npm install

npm run setup           # generate a local blip.config.yaml (optional)
npm run seed            # realistic demo data into /data
npm run dev             # dashboard at http://localhost:5173
```

## Before you open a PR

Run what CI runs — all three must pass:

```bash
npm run typecheck
npm test
npm run build
```

(CI also runs these on every PR via [`.github/workflows/ci.yml`](.github/workflows/ci.yml).)

## Pull request guidelines

- **One logical change per PR.** Smaller PRs get reviewed faster.
- **Fill in the [PR template](.github/pull_request_template.md)** and link the
  related issue (`Closes #123`).
- **Update docs** when behavior or config changes (`docs/`, README, and
  `config/blip.config.example.yaml`).
- **Keep types in sync** — new/changed config fields must appear in
  `packages/shared/src/types.ts` and the example config.
- **Never commit secrets.** No tokens, chat ids, webhook URLs, or `.env` files.
  The `/data` directory is seed-generated for local preview — don't hand-edit it.
- **Conventional Commits** for messages are appreciated (e.g.
  `feat(worker): add tcp keyword check`, `fix(dashboard): …`, `docs: …`,
  `chore(deps): …`).

## Commit / branch conventions

- Branch off `main`: `feat/…`, `fix/…`, `docs/…`, `chore/…`.
- Rebase or merge `main` before requesting review if your branch has drifted.

## Adding things

- **A new notification channel?** Add its type to `ChannelConfig` in
  `packages/shared/src/types.ts`, wire it into the Worker's notifier
  (`packages/worker/src/notify.ts`), document it in `docs/notifications.md` +
  `docs/configuration.md`, and add it to the setup wizard and example config.
- **A new check type or assertion?** Update `SiteConfig`/`CheckType`, the Worker
  checks (`packages/worker/src/checks.ts`), the config docs, and the example config.

## Questions?

Open a [discussion](https://github.com/warlock277/blip/discussions) — happy to help.
Thanks for contributing! 💚
