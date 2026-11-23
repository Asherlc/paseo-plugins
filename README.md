# Paseo plug-ins

A collection of independently installable [Paseo](https://paseo.sh) plug-ins.

## Packages

### Cheapskate

One selectable Paseo model backed by an ordered fallback chain. When a backend hits a quota or rate limit, Cheapskate continues in the same chat with the next model.

- Install from the registry with `paseo plugin install asherlc/cheapskate`.
- Install from Git with `paseo plugin install git:Asherlc/paseo-plugins:plugins/cheapskate`.
- [Cheapskate documentation](plugins/cheapskate/README.md)

### Devices

iOS simulators and Android emulators per workspace, with a live view and agent tools. Capture and annotate iOS simulator screenshots from the Device panel.

- Install from Git with `paseo plugin install git:Asherlc/paseo-plugins:plugins/devices`.
- [Devices documentation and upstream attribution](plugins/devices/README.md)

### Storybook

Run Storybook per workspace, select a story for review, and bring Canvas Comments into the conversation draft.

- Install from Git with `paseo plugin install git:Asherlc/paseo-plugins:plugins/storybook`.
- [Storybook documentation](plugins/storybook/README.md)

### Markdown annotations

Select a passage in a Markdown file and add the quote, line range, and your comment to an agent's draft.

- [Markdown annotations documentation](plugins/markdown-annotations/README.md)

## Development

Packages are installed and tested independently, each with its own lockfile and checks. Cheapskate releases and Devices marketplace submissions require changes in their own package directory or the repository-level `shared/` directory.

For Cheapskate:

```sh
cd plugins/cheapskate
npm ci
npm run typecheck
npm test
```

For Devices:

```sh
cd plugins/devices
npm ci
npm run typecheck
npm test
```

Cheapskate, Devices, and Storybook have independent CI workflows. Cheapskate's workflow also publishes its patch releases. [Cheapskate workflow](.github/workflows/release.yml) · [Devices workflow](.github/workflows/devices.yml) · [Storybook workflow](.github/workflows/storybook.yml)
