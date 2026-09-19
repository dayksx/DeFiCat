# CI/CD and infrastructure as code

How a change is **verified** (CI) and how it may later **reach a machine** (CD). Hexagon, security
and tests are not restated here — they still apply:

| Concern | Document |
|---------|----------|
| Layers, ports | [HEXAGONAL.md](./HEXAGONAL.md) |
| Packages, pnpm, lockfile | [MONOREPO.md](./MONOREPO.md) |
| Secrets, images, `npm ci` | [SECURITY.md](./SECURITY.md) §9–10 |
| Shutdown on replace | [ERRORS.md](./ERRORS.md) §6 |
| Specs stay offline | [TESTING.md](./TESTING.md) |
| Telegram replica limit | [DEBT.md](../DEBT.md) `T-02`, [DECISIONS.md](../DECISIONS.md) Open questions |
| Branches, PR gates | [CONTRIBUTING.md](./CONTRIBUTING.md) |

**Status today:** CI exists. CD and a cloud account do **not**. The host (Hetzner or otherwise) is
an open product question, not a decision. This file is the contract so the first deploy PR does not
invent a parallel pipeline or a second secret store.

---

## Quick start

| Question | Answer |
|----------|--------|
| What runs on every PR? | `.github/workflows/ci.yml` — typecheck, lint, import matrix, tests |
| What deploys today? | Nothing. Do not add a deploy job until a host is named in [DECISIONS.md](../DECISIONS.md) |
| Where would machines live in git? | Root `infra/` — OpenTofu/Terraform, not `agents/src/` |
| How many `agents` processes? | **One** while Telegram is long polling. A second replica steals `getUpdates` (`T-02`) |
| Where do production secrets live? | GitHub Environments / a secret manager — never the repo, never `NEXT_PUBLIC_*` |

---

## 1. Words

**CI** (continuous integration) answers: “is this tree shippable?” It runs on a GitHub-hosted
runner. It must not need Telegram, LiteLLM, Hetzner, or a wallet. That is the same rule as unit
tests: no network, no live keys.

**CD** (continuous delivery / deployment) answers: “put this shippable artefact on a machine and
run it.” It is a **second** workflow (or a second job with `needs: check`), not a step stuffed into
the PR job.

**Infrastructure as code (IaC)** is the machine, network and firewall **declared in git** so a
reviewer can see “what will exist in the cloud” the same way they see application code. Clicking a
VM together in a console is not a substitute: it cannot be PR-reviewed and it drifts.

**GitHub Actions** is the runner. A workflow is YAML under `.github/workflows/`. Events (`push`,
`pull_request`) start jobs; jobs are sequences of steps. Secrets are injected as env vars on the
runner — they are not files in the repo.

These three are independent. You can have CI without CD (this repo). You can have IaC without
auto-deploy (apply from a laptop). You should not have CD without CI: a red `check` job never
reaches production.

---

## 2. What CI already does

`.github/workflows/ci.yml` runs on every pull request and on every push to `main`:

1. Checkout
2. pnpm + Node 22 (matches `.nvmrc`)
3. `pnpm install --frozen-lockfile` (pnpm’s equivalent of `npm ci` — [SECURITY.md](./SECURITY.md) §10)
4. `pnpm typecheck` / `lint` / `lint:boundaries` / `test`

That is the merge gate. Do not weaken it to “make CD green”. Do not add `TELEGRAM_BOT_TOKEN` to the
CI job so a spec can hit the network — that is a new e2e suite (`*.e2e-spec.ts`), not CI.

`agents` has a `deploy` npm script that calls `nest deploy`. That is Nest’s cloud helper, not this
product’s CD. Do not wire GitHub Actions to it.

---

## 3. Pipeline law (when CD exists)

1. **PRs never deploy.** `pull_request` may build an image and run CI. Only `main` (or a tagged
   release) may mutate cloud state or SSH to a host.
2. **CD `needs` a green CI job** on the same commit. Do not “deploy anyway”.
3. **One replica** of `@kyodai/agents` until Telegram is on a webhook and history is out of
   process (`T-02`). CD must not scale the service to 2.
4. **Replace, do not overlap.** Rolling two Nest processes against the same bot token is a
   production incident. Drain with `enableShutdownHooks()` ([ERRORS.md](./ERRORS.md) §6), stop the
   old process, start the new one.
5. **Restart wipes conversation memory** (`MemorySaver`, `D-05`). That is accepted until
   persistence exists. Do not “fix” it with sticky sessions or two replicas.
6. **Secrets enter only `bootstrap/`** on the host, the same as locally. The image, the compose
   file and the Actions log must not print tokens, `AGENT_PRIVATE_KEY`, or model keys (`T-13`).
7. **IaC owns the box; the app image owns the process.** Terraform/OpenTofu does not `pnpm install`
   on the server by curling `main`. The pipeline builds an artefact (container image) from a
   lockfile, then the host runs that digest.
8. **`/healthz` is the probe**, not “the Telegram bot answered”. CD may wait on
   `GET`/`HEAD /healthz` after start. It must not wait on a real chat.

---

## 4. GitHub Actions shape (target, not present)

Two workflow files, two intents:

| File | When | Allowed to |
|------|------|------------|
| `ci.yml` | PR + `main` | Install, lint, test, optionally `docker build` |
| `deploy.yml` (future) | `push` to `main` after CI, or `workflow_run` / `workflow_dispatch` | Push the image, apply IaC, restart **one** unit |

`deploy.yml` uses a GitHub **Environment** (`production`) with required reviewers if more than one
human can merge. Secrets hang on that environment, not on the repo-wide bag, so a fork PR cannot
see them.

Prefer **OIDC** (`permissions: id-token: write`) when the cloud speaks it. Hetzner Cloud today is
an **API token**: store `HCLOUD_TOKEN` as an Actions secret, least privilege, rotate if logged.
Never commit `terraform.tfvars` with the token. SSH private keys, if used, are secrets too — prefer
a deploy user with a single command (`systemctl restart kyodai-agents`) over root and `git pull`.

Minimal sketch — do not copy into the repo until the host is decided:

```yaml
# .github/workflows/deploy.yml — illustrative
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    needs: check          # or workflow_run on CI success
    environment: production
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # build + push image from the same commit CI tested
      # tofu apply or ssh restart of the single unit
```

Concurrency: `concurrency: { group: production-agents, cancel-in-progress: false }` so two merges
do not restart the bot at the same time.

---

## 5. Infrastructure as code

Declare **resources**, not click-ops:

- One VM (or one container host) in a region you accept
- Firewall: inbound **only** what you need. Long polling needs **egress** to `api.telegram.org` and
  the LLM gateway; it does **not** need port 80/443 open to the world until there is a webhook or a
  public HTTP API
- SSH from your IP / a bastion, not `0.0.0.0/0` on port 22
- Optional: floating IP, snapshots, object storage for images

**Tooling.** [OpenTofu](https://opentofu.org/) or Terraform + the Hetzner `hcloud` provider is the
usual pair for Hetzner Cloud. State belongs in a **remote backend** (encrypted bucket or Terraform
Cloud), not a laptop `terraform.tfstate` that contains IPs and token fingerprints. State files are
secrets.

**Layout** (when it exists):

```text
infra/                 # not a pnpm workspace member
  README.md            # how to plan/apply, which backend
  versions.tf
  providers.tf
  server.tf            # the one agents host
  firewall.tf
  variables.tf         # no secret defaults
```

`infra/` may import nothing from `agents/src`. `domain/` and `app/` must never import `infra/`.
Applying IaC is a bootstrap/ops concern, like `AppModule` wiring — it is not a use case.

A first Hetzner slice is a **CX cloud server + firewall + Docker (or podman) composing one
`agents` container**. Kubernetes, a load balancer and autoscaling wait until webhook + persistence
make `replicas > 1` legal.

Local `hcloud` CLI is fine to explore. Production changes go through `tofu plan` in a PR (or an
Actions plan comment) and `tofu apply` only from `main` / a human with the backend credentials.

---

## 6. The artefact

No Dockerfile exists yet. When one does:

- Multi-stage build, **Node 22**, `pnpm install --frozen-lockfile` (or `pnpm deploy` into a
  pruned tree). Never `npm install` in the image ([SECURITY.md](./SECURITY.md) §16)
- `CMD` is `node dist/bootstrap/bot/bot.js` (`start:prod`), not `nest start --watch`
- Env from the orchestrator / systemd `EnvironmentFile=` that is **not** in git. Same keys as
  `agents/.env.example`
- Do not bake `TELEGRAM_BOT_TOKEN` into a layer
- Tag the image with the **git SHA**. CD pulls that digest, not `:latest`

Compose (or a systemd unit) sets `restart=on-failure` and **replicas: 1**. Healthcheck hits
`/healthz` on the loopback port Nest actually binds.

---

## 7. Secrets on the host

Same rules as [SECURITY.md](./SECURITY.md) §9 and `T-13`:

- GitHub Secrets → runner → host env or a file mode `0600` owned by the service user
- Rotate on leak; treat an Actions log that printed a token as a leak
- Production signer keys, if they ever exist, come from a secret manager, not an env file copied
  from a laptop
- `git check-ignore` still applies: never `scp` a developer `.env` that holds a funded key

---

## 8. Recipe — first production (when a human picks a host)

Do this as **one** decision (`D-xx`: host + process model) plus stacked PRs. Do not mix a hexagon
refactor with “also Hetzner”.

1. Record the host in [DECISIONS.md](../DECISIONS.md). Keep `replicas: 1` until `T-02` is paid.
2. Add `infra/` with remote state, firewall, one VM. Empty apply in a docs/chore PR is fine.
3. Add a Dockerfile + image registry. CI may `docker build` on PRs; only `main` pushes.
4. Add `deploy.yml` with `environment: production`, `needs: check`, concurrency group.
5. Wire secrets that `agents/.env.example` lists. Delete unused keys (`T-10`) before they become
   production ghosts.
6. Prove `/healthz` then a real Telegram message. Expect empty history after the first restart.
7. Add a row to [DEBT.md](../DEBT.md) if you skip remote state, a firewall, or image pinning.

**Stop the line** — refuse to generate or merge:

- Deploy from a `pull_request` event
- Second replica / load balancer in front of long polling
- `npm install` or unlocked `pnpm install` in CI or Docker
- Cloud tokens, SSH keys or `.tfstate` in git
- `process.env` reads outside `bootstrap/` to “make deploy easier”
- `nest deploy` as the production path
- IaC or Docker that encodes business rules (limits, pricing, eligibility)

---

## Adding to this file

When the host is chosen, add the decision id at the top **Status** line and replace “illustrative”
YAML with the real workflow names. Do not keep two deploy stories.
