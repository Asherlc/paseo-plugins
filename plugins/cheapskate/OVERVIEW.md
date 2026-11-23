Cheapskate adds a model to Paseo's regular picker. The model runs on an ordered chain of models from your existing Paseo providers. If a backend hits a quota, rate limit, or tool-call grammar limit, Cheapskate continues in the same chat and workspace using the next entry.

## Setup

Requires Paseo 0.16.1 or later. Open Settings → Plugins → Cheapskate and choose a provider and model for each entry in your fallback chain. Each backend uses the accounts and defaults already configured for that provider. Check chain shows which models are listed and how the first choice’s permission mode maps to the fallbacks, without sending a model request. You can opt in to switching on provider overload.

Each named chain has its own model entry in Paseo’s picker. Set its billing policy to allow configured backends, ask before sending a message to a paid or unclassified backend, or run only on backends you have marked free. Confirm that the billing labels match the accounts configured on the host.

## Routing and chat history

The successful backend stays active for follow-up turns and supplies the chat's thinking levels, permission modes, and provider controls. On fallback, Cheapskate chooses the nearest available thinking level and skips backends that cannot preserve the selected permission restrictions. After a switch, the new backend receives your current message and a bounded excerpt of recent conversation and tool activity names. Cheapskate masks common credential formats in historical text. The new backend can inspect files in the same workspace. Choose backends you are comfortable sharing that context with. Permission requests are relayed to the Cheapskate chat.

The composer shows the current backend. Open its routing details to see why it switched or queue the first choice for the next message.

When a provider supplies an explicit reset time or retry delay, Cheapskate shows it and skips that backend during the wait. You can opt in to trying an earlier backend after its reported reset on a new message. Each turn has a routing receipt with the outcome, skipped backends, and usage reported for that turn when available.

Paseo launches the backends as background agents. Cheapskate saves recent chat history and the active backend locally on the daemon so that a chat can recover after a runtime reload. It stores the last switch and any queued retry in the chat’s Paseo metadata.
