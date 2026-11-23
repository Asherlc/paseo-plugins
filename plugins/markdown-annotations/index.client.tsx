import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MarkdownPanel } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  return client.addFilePanel({
    id: "review",
    title: "Markdown annotations",
    icon: "MessageSquareText",
    files: { extensions: ["md", "markdown", "mdown", "mkd"] },
    Component: (props) => (
      <MarkdownPanel key={props.file.path} {...props} getComposers={(selector) => client.composers(selector)} />
    ),
  });
}
