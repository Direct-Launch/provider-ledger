# Provider Ledger 0.4 — public readiness, spend types, local vs cloud

Status: planned with the maintainer 2026-11-26, after the 0.3.0 feature workshop.
Supersedes nothing; 0.3 spec still holds for the shipped features.

## 1. Why this release exists

0.3.0 works on one machine because it knows that machine: it hardcodes
a fixed vault path, treats a `Customers/<Name>` folder convention as the client key and calls
OpenChamber's own folders `Chats`. None of that belongs in an extension submitted to
openchamber.dev, where the first user's vault is not this one.

It also answers "what did it cost" but not "what was it for". Spend on image generation,
on OpenChamber's own classification and routing calls, on agentic exploration and on
plain coding is not the same money, and a local model costs electricity rather than
dollars.

## 2. Portability (public viability)

- **P-1** No source file shall contain a machine-specific path. The vault root, the
  `Customers/` convention and any other local rule become configuration.
- **P-2** The default project key shall be the **session directory's own folder name**,
  which is correct for a vault, a repo checkout and a client folder alike, with no setup.
- **P-3** The user may add **workspace roots** (one or more absolute paths) in the panel;
  a session under a root takes the first path segment below that root as its project key,
  so `…/Customers/Acme/notes` becomes `Acme` when `…/Customers` is a root.
- **P-4** A path under OpenChamber's own data directory (`…/.config/openchamber/chats/…`)
  shall be `Chats`, which is true on every machine.
- **P-5** A child project shall be collapsible to its parent in the Clients view, so a
  deep tree does not produce hundreds of one-session rows.
- **P-6** First run shall work with **no configuration at all**: the panel explains what
  happens, reads the history and shows spend before any setting is touched.

## 3. Spend types

The ledger shall record a **category** and a **scope** on every bucket.

- **C-1 Scope.** `local` when the provider is a local runtime, `cloud` otherwise. A model
  id ending `:cloud` is `cloud` even on a local runtime (Ollama's cloud models). The
  local provider ids default to `ollama`, `lmstudio`, `llamacpp`, `vllm`, `llama.cpp`
  and are editable in the panel.
- **C-2 Category.** Derived, in this order: **image** when the model id matches an image
  model (`gpt-image`, `dall-e`, `imagen`, `flux`, `seedream`, `recraft`, `ideogram`,
  `sdxl`, `stable-diffusion`); **embedding** for an embedding model; **utility** for a
  model the user lists as classification / routing / titling; **agentic** for replies
  from an agent whose id is not a coding agent; **coding** otherwise.
- **C-3 Agent attribution.** The agent in force for each reply comes from the session's
  `agent-switched` messages, so one session can split across coding and agentic. A
  session with no switch takes the session's own `agent`.
- **C-4 Honest gap.** Where the agent or the category cannot be known, the reply is
  `uncategorised`, and the view says how much of the period that is. A wrong label is
  worse than none.
- **C-5 Views.** A **Types** tab: spend by category and by scope for the selected period,
  a local-versus-cloud split with local shown in calls and tokens (never in dollars, since
  it costs none), and a per-category provider breakdown.
- **C-6 Settings.** The image-model patterns, the utility-model list, the local provider
  ids and the coding-agent ids are editable in the panel and stored in the ledger store;
  the shipped defaults are the patterns in C-1 and C-2.

## 4. More from a provider's configuration

The SDK decides what an extension may read: `contributes.quota.providers` is a **manifest
list, approved at install**, and only those credentials are handed over. There is no way
to read "whatever the user has configured".

- **V-1** The extension shall therefore ship readers for the providers it declares, and
  add more by manifest: a provider is supported only when a reader exists for it.
- **V-2** A generic reader shall cover **OpenAI-compatible** endpoints answering
  `/v1/usage` or `/v1/dashboard/billing/{subscription,usage}` with a bearer key, since
  that is most self-hosted relays and several providers.
- **V-3** Where a provider's balance cannot be read, the row shall say which providers
  are supported and link the provider's own console, never invent a number.
- **V-4** The static list is a product constraint, and the README shall say so plainly
  rather than implying a dynamic one.

## 5. Publishing (0.4.0 exit criteria)

- **U-1** Public repo `provider-ledger`, MIT, `package.json` at the root, semver
  `version`, `bunx openchamber-guest-check` in CI on every push.
- **U-2** README for a stranger: what it shows, the two roles it asks for and why, the
  store path, how to develop, the provider list, and the known limits (VS Code loads no
  extensions; balances refresh only when OpenChamber refreshes its Usage card; local
  models cost nothing in dollars).
- **U-3** No credentials, machine paths, client names or vault facts in the repo, the
  history or the built bundles.
- **U-4** A generic name and icon; nothing referring to this agency.
- **U-5** Directory submission drafted (category **Usage**) and left unsent for the maintainer to
  read and send to feedback@openchamber.dev.

## 6. Acceptance criteria

1. Given a fresh store and no settings, when the panel opens, then spend appears and the
   project column reads folder names, with no configuration.
2. Given a workspace root of `/x/Customers`, a session in `/x/Customers/Acme/sub` is keyed
   `Acme`; without the root it is `sub`.
3. Given a session that switches from `build` to `plan`, its replies split between
   `coding` and `agentic` in the Types tab in the same proportions as its messages.
4. Given an `ollama` reply to `deepseek-v4.1-flash:cloud`, the scope is `cloud`; to a
   local model, `local`, and local spend reads `$0.00` with its token count shown.
5. Given a search of the published repo for the author's own vault path, no source or built file matches.
6. Given the repo pushed, CI runs `openchamber-guest-check` and fails the build on a
   broken package.

## 7. Phasing

- **0.4.0** portability (P-1…P-6), scope and category (C-1…C-6), README, LICENSE, CI,
  repo created and pushed. Submission draft written, not sent.
- **0.5.0** the generic OpenAI-compatible reader (V-2) and one or two named providers,
  chosen by what the directory does not already cover.
