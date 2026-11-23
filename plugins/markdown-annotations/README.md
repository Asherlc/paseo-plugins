# Markdown annotations

Quote and comment on Markdown passages in a Paseo conversation draft. Requires Paseo 0.16.2 or later.

## Use it

1. Open a Markdown file in Paseo and choose **Open with… → Markdown annotations**.
2. In **Source**, select text or enter a line range such as `8–12`, then choose **Comment**.
3. Write your comment and choose a conversation in the workspace. Choose **Add to chat**.
4. Add more comments, or choose **Open chat** to review and send the draft.

The draft includes the file path, inclusive line range, and source quote. **Preview** renders the Markdown while you read. The panel supports `.md`, `.markdown`, `.mdown`, and `.mkd` files.

## Local development

From this directory, run `npm ci`, `npm run typecheck`, and `npm test`. Install the checkout with `paseo plugin install "$PWD"` and load source edits with `paseo plugin reload markdown-annotations`.
