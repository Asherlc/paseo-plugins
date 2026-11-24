# Cheapskate for Paseo

Select **Cheapskate** as your provider and model, or use `cheapskate/cheapskate` in the CLI. The chat stays on that model while Cheapskate uses your existing Paseo providers in the order you configure.

## Install and configure

Requires Paseo 0.16.1 or newer. Enable plugins in Paseo, then install on your daemon host from the registry:

```sh
paseo plugin install asherlc/cheapskate
```

To install directly from the repository instead, point at this package's directory in the `paseo-plugins` monorepo:

```sh
paseo plugin install git:Asherlc/paseo-plugins:plugins/cheapskate
```

If you installed Cheapskate from a local directory or directly from the former `Asherlc/cheapskate` Git repository, repoint it to the new source above. Back up your saved chains before removing or reinstalling the plugin, because removing it discards those settings.

Open **Settings → Plugins → Cheapskate** on that host. Select **Add backend**, choose a provider and a model, then arrange the entries in the order Cheapskate should try them. Save to apply the chain. The pickers use that host’s catalog. If a saved provider or model becomes unavailable, its entry stays in the chain until you replace or remove it.

Use **Check chain** to see which models are listed and how the selected source backend’s permission mode maps to each fallback. The check uses provider defaults and makes no model requests. Account access and remaining quota are determined when a backend runs a turn.

Choose a **Source backend** and **Source permission mode** in the check results, then set **Explicit mode** on a fallback. Cheapskate uses that mapping when it cannot find a safe automatic match. The destination uses its own provider defaults. Choose a mode with appropriate restrictions for that backend and click **Save**. Select **Automatic** to clear a mapping. If a saved mode becomes unavailable, choose a mode the provider still offers. Removing a backend clears its mappings when you save.

Use **Add chain** to give another route its own name, backends, and routing policy. Saved chains appear as separate models under the Cheapskate provider. Each named chain keeps its CLI model ID when renamed. The settings screen shows that ID beside its name. If a chain’s first eligible backend uses different permission modes, the draft offers a picker for that chain’s modes.

## Composer controls

Cheapskate shows the primary backend's thinking levels, permission modes, and provider controls in a draft. A running chat shows the controls of its active backend. Changes apply to the next turn. If changing a setting requires a new backing session, Cheapskate passes it the recent context and continues in the same chat.

Select the backend name next to the composer to see the reason for the latest switch. **Try primary again** queues the first choice for the next message. Cheapskate checks permission compatibility and runs the ordinary fallback chain if that backend still hits a limit.

On failover, Cheapskate uses the nearest available thinking level and a known equivalent or stricter permission mode. It skips a backend whose policy cannot preserve the selected restrictions. The timeline shows the backend and settings selected for the attempt. After a plugin reload, opening a Cheapskate draft populates the catalog used by CLI commands that specify a mode.

## What happens when a model fails

Cheapskate switches on quota and rate-limit failures and when a backend rejects a request because its tool-call grammar is too large. You can opt in to switching on provider overload. Ordinary errors stop the turn and surface in the chat. Each backend is tried once in a turn. A successful backend handles subsequent turns until it fails or is removed from the chain. Settings changes take effect on the next turn.

If a failure includes an explicit retry delay or time with a timezone, Cheapskate records it for that backend in the chat and shows it in the routing details. It skips that backend until the reported time. Turn on **Return after quota reset** to try an earlier eligible backend on the first new message after its known reset. Cheapskate makes no background probes. A manual retry also honors a reported wait.

Set **Billing policy** per chain. **Ask before paid or unclassified** presents a **Use once** or **Skip backend** choice in the chat before sending the message to a backend that may charge. **Free only** uses only backends you’ve marked **Free**. Billing classifications apply to the account configured on this host. Existing chains keep **Allow configured backends**, and new chains default to **Ask**. The approval applies to one backend attempt on one message. Tool permissions still follow the selected backend mode.

Open a turn’s **Routing receipt** to see which backend answered, which were skipped and why, any reported reset time, and token and cost totals when Paseo makes them available for that turn.

When Cheapskate starts a new backend mid-conversation, it passes along the latest message (including any attachments) and a bounded excerpt of recent user and assistant text and tool names. Cheapskate masks common access tokens and private-key blocks in historical text. The latest message and its attachments are forwarded normally. The backend starts its own native session in the same workspace and can inspect edits already made there. Credentials, billing, and tool approvals follow the configured backend. Provider-specific slash commands, steering, and rewind are outside the shared model interface.

Cheapskate saves up to 300 recent timeline items and the backing agent ID in `plugin-data/cheapskate` under the daemon's Paseo home. Chat excerpts can contain sensitive information. Configure only backends that may receive that context.

## Usage totals

Use **Settings → Plugins → Cheapskate → View usage** for all-time token totals on the current host. Rows group by provider ID and canonical model ID. Each row shows input, cached input, and output sums with completed turn and missing token counts. A dash marks a field that was never reported. Each completed backend turn is counted once, even when the chat turn is canceled afterward. Skipped and failed attempts are not counted. An unchanged usage snapshot without a turn usage report counts as missing because it may belong to a previous turn.

Totals cover new turns from when usage tracking began. Earlier turns are not included. The data lives in `plugin-data/cheapskate/usage.sqlite` under the daemon's Paseo home, separate from routing settings, chat data, and archives. Each host keeps its own totals. Use **Refresh** in the dialog to reload.

## Development

```sh
npm ci
npm run typecheck
npm test
paseo plugin reload cheapskate
```

## CI and releases

GitHub Actions runs typechecking, tests, and a package dry run on pull requests and
pushes to `main` that change Cheapskate or its release workflow. Each passing push of those changes automatically increments the patch
version in `package.json` and `package-lock.json`, pushes a `v` tag, and publishes
a GitHub release with generated notes. The version commit uses `[skip ci]` to
avoid starting another release. Do not bump the version manually for patch releases.

After releasing, CI opens a version-specific submission issue in
[`getpaseo/plugins`](https://github.com/getpaseo/plugins), pinned to the release
commit. Marketplace publication still requires Paseo's review and approval.
This keeps the existing Git distribution; no npm publishing credential is needed.

Set the **`MARKETPLACE_TOKEN`** Actions secret in this repository before the first
release. Use a dedicated classic GitHub personal access token with only
`public_repo` scope, owned by the listing author, so it can open issues in the
public registry repository. The built-in `GITHUB_TOKEN` is restricted to this
repository and cannot submit there. Registry intake recognizes the issue's
`Source` section and applies the submission label, so the token does not need
collaborator access to the registry.

If submission fails, fix the credential or service error and choose **Re-run failed
jobs** in Actions. The marketplace job reuses the completed release and skips an
issue with the same title, including closed issues. Re-running all jobs also
reuses the tag when it belongs to the original source revision. The workflow can
be started manually on `main` to make a new patch release without another source
change. If `main` moves while a release runs, its atomic push fails; the next
push's run checks and releases the newer revision.
