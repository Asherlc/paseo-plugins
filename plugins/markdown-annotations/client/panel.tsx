import {
  type PluginClientContext,
  type PluginFilePanelProps,
  useFileText,
  usePaseo,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { Loading, Markdown, Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  formatAnnotation,
  lineLabel,
  linesPassage,
  type Passage,
  selectedPassage,
  type Selection,
  workspacePath,
} from "./passage";

type Colors = PluginFilePanelProps["theme"]["colors"];
type GetComposers = PluginClientContext["composers"];
type Target = { id: string; title: string };
type Annotation = { path: string; passage: Passage };

function Button({ label, onPress, colors, selected, primary, disabled }: {
  label: string;
  onPress: () => void;
  colors: Colors;
  selected?: boolean;
  primary?: boolean;
  disabled?: boolean;
}) {
  const accented = primary || selected;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: accented ? colors.accent : colors.surface2 },
        (pressed || disabled) && { opacity: 0.55 },
      ]}
    >
      <Text style={{ color: accented ? colors.accentForeground : colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

function CommentForm({
  annotation, colors, workspaceId, hostId, recentTarget, getComposers, onAdded,
}: {
  annotation: Annotation;
  colors: Colors;
  workspaceId: string;
  hostId: string;
  recentTarget: Target | undefined;
  getComposers: GetComposers;
  onAdded: (target: Target) => void;
}) {
  const paseo = usePaseo();
  const [comment, setComment] = useState("");
  const [chosenId, setChosenId] = useState(recentTarget?.id);
  const [error, setError] = useState<string>();
  const submitted = useRef(false);
  const agents = useQuery({
    queryKey: ["markdown-annotation-agents", hostId, workspaceId],
    queryFn: async ({ signal }) => {
      const targets: Target[] = [];
      let cursor: string | undefined;
      do {
        const { entries, pageInfo } = await paseo.agents.list({
          scope: "active",
          page: { limit: 200, cursor },
          signal,
        });
        for (const { agent } of entries) {
          if (agent.workspaceId === workspaceId && !agent.archivedAt) {
            targets.push({ id: agent.id, title: agent.title || `${agent.provider} (${agent.id.slice(0, 8)})` });
          }
        }
        cursor = pageInfo.nextCursor ?? undefined;
      } while (cursor);
      return targets;
    },
  });

  const targets = agents.data ?? [];
  const target = targets.length === 1 ? targets[0] : targets.find(({ id }) => id === chosenId);

  function addToChat() {
    if (submitted.current || !target || !comment.trim() || agents.isFetching || agents.isError) return;
    submitted.current = true;
    try {
      const [composer] = getComposers({ agentId: target.id });
      if (!composer) throw new Error("This conversation is unavailable. Choose another conversation.");
      const text = formatAnnotation(annotation.path, annotation.passage, comment);
      composer.setPrompt(composer.prompt ? `${composer.prompt}\n\n${text}` : text);
    } catch (failure) {
      submitted.current = false;
      setError(failure instanceof Error ? failure.message : "Could not add the annotation to the draft.");
      return;
    }
    onAdded(target);
  }

  return (
    <>
      <Text style={{ color: colors.foregroundMuted }}>
        {annotation.path} · {lineLabel(annotation.passage)}
      </Text>
      <Text
        numberOfLines={6}
        style={[styles.excerpt, styles.monospace, { color: colors.foreground, backgroundColor: colors.surface1 }]}
      >
        {annotation.passage.quote || "(Empty line)"}
      </Text>
      <TextInput
        accessibilityLabel="Comment"
        placeholder="Write a comment"
        placeholderTextColor={colors.foregroundMuted}
        value={comment}
        onChangeText={setComment}
        multiline
        style={[styles.input, styles.comment, { color: colors.foreground, borderColor: colors.border }]}
      />
      {agents.isPending ? (
        <Text style={{ color: colors.foregroundMuted }}>Loading conversations…</Text>
      ) : agents.isError ? (
        <View style={styles.stack}>
          <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>Could not load conversations.</Text>
          <Button colors={colors} label="Retry" onPress={() => void agents.refetch()} />
        </View>
      ) : targets.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted }}>Open an agent conversation in this workspace to add a comment.</Text>
      ) : targets.length === 1 ? (
        <Text style={{ color: colors.foregroundMuted }}>Conversation · {target?.title}</Text>
      ) : (
        <View style={styles.stack}>
          <Text style={{ color: colors.foregroundMuted }}>Choose a conversation</Text>
          <View style={styles.row}>
            {targets.map(({ id, title }) => (
              <Button
                key={id}
                colors={colors}
                label={title}
                selected={id === target?.id}
                onPress={() => { setChosenId(id); setError(undefined); }}
              />
            ))}
          </View>
        </View>
      )}
      {error && <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{error}</Text>}
      <Button
        colors={colors}
        label="Add to chat"
        primary
        disabled={!target || !comment.trim() || agents.isFetching || agents.isError}
        onPress={addToChat}
      />
    </>
  );
}

export function MarkdownPanel({
  file, theme: { colors }, layout, host, workspaceId, getComposers,
}: PluginFilePanelProps & { getComposers: GetComposers }) {
  const result = useFileText(file);
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const toast = useToast();
  const raw = result.status === "ready" ? result.text : "";
  const source = useMemo(() => raw.replace(/\r\n?/g, "\n"), [raw]);
  const lines = useMemo(() => source.split("\n"), [source]);
  const [preview, setPreview] = useState(false);
  const [selection, setSelection] = useState<{ source: string; range: Selection }>();
  const [lineRange, setLineRange] = useState("");
  const [annotation, setAnnotation] = useState<Annotation>();
  const [recentTarget, setRecentTarget] = useState<Target>();
  const padding = layout.compact ? 10 : 16;
  const hasRange = !!lineRange.trim();
  const explicitPassage = hasRange ? linesPassage(lines, lineRange) : undefined;
  const passage = hasRange ? explicitPassage :
    selection?.source === source ? selectedPassage(source, selection.range) : undefined;

  function startComment() {
    if (result.status !== "ready" || !passage) return;
    setAnnotation({ path: workspacePath(file.path, directory), passage });
  }

  async function openChat(target: Target) {
    try {
      const [composer] = getComposers({ agentId: target.id });
      if (!composer) throw new Error("This conversation is unavailable.");
      await composer.focus();
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "Could not open the conversation.", { variant: "error" });
    }
  }

  return (
    <View style={[styles.panel, { backgroundColor: colors.surface0 }]}>
      {result.status === "loading" ? <Loading /> : result.status === "error" ? (
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger, padding }}>{result.error.message}</Text>
      ) : !source ? (
        <Text style={{ color: colors.foregroundMuted, padding }}>This file is empty.</Text>
      ) : (
        <>
          <View style={[styles.stack, { padding, borderBottomWidth: 1, borderColor: colors.border }]}>
            <View style={styles.row}>
              <Button colors={colors} label="Source" selected={!preview} onPress={() => setPreview(false)} />
              <Button colors={colors} label="Preview" selected={preview} onPress={() => {
                setPreview(true);
                setSelection(undefined);
              }} />
              {recentTarget && <Button colors={colors} label="Open chat" onPress={() => void openChat(recentTarget)} />}
            </View>
            {!preview && (
              <>
                <View style={styles.row}>
                  <TextInput
                    accessibilityLabel="Line range"
                    accessibilityHint={`Enter a line or range between 1 and ${lines.length}`}
                    placeholder="Lines, e.g. 2–4"
                    placeholderTextColor={colors.foregroundMuted}
                    value={lineRange}
                    onChangeText={setLineRange}
                    onSubmitEditing={startComment}
                    autoCorrect={false}
                    style={[styles.input, styles.lineRange, { color: colors.foreground, borderColor: colors.border }]}
                  />
                  <Button
                    colors={colors}
                    label="Comment"
                    primary
                    disabled={!passage}
                    onPress={startComment}
                  />
                </View>
                <Text style={{ color: hasRange && !explicitPassage ? colors.statusDanger : colors.foregroundMuted }}>
                  {passage ? lineLabel(passage) : hasRange
                    ? `Enter a line or range from 1 to ${lines.length}.`
                    : `Select text or enter a line range. ${lines.length} ${lines.length === 1 ? "line" : "lines"}.`}
                </Text>
              </>
            )}
          </View>
          {preview ? (
            <ScrollView style={styles.content} contentContainerStyle={{ padding }}>
              <Markdown>{raw}</Markdown>
            </ScrollView>
          ) : (
            <TextInput
              accessibilityLabel="Markdown source"
              readOnly
              multiline
              value={source}
              onSelectionChange={({ nativeEvent }) => setSelection({ source, range: nativeEvent.selection })}
              style={[styles.content, styles.monospace, { color: colors.foreground, textAlignVertical: "top", padding }]}
            />
          )}
        </>
      )}
      {annotation && (
        <Modal title="Markdown comment" open onOpenChange={(open) => { if (!open) setAnnotation(undefined); }}>
          <Modal.Content>
            <CommentForm
              annotation={annotation}
              colors={colors}
              workspaceId={workspaceId}
              hostId={host.id}
              recentTarget={recentTarget}
              getComposers={getComposers}
              onAdded={(target) => {
                setRecentTarget(target);
                setAnnotation(undefined);
                setLineRange("");
                setSelection(undefined);
                toast.show(`Added to the draft in ${target.title}`, { variant: "success" });
              }}
            />
          </Modal.Content>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1 },
  content: { flex: 1, minHeight: 0 },
  stack: { gap: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  button: { alignSelf: "flex-start", borderRadius: 6, paddingHorizontal: 12, paddingVertical: 9 },
  input: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8 },
  lineRange: { width: 146 },
  comment: { minHeight: 96, textAlignVertical: "top" },
  excerpt: { padding: 10, borderRadius: 6 },
  monospace: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 13, lineHeight: 20 },
});
