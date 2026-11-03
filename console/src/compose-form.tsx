import {
  Action,
  ActionPanel,
  Form,
  Icon,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useState } from "react";
import { type Contact, transportLabel } from "./lib/contacts";
import { useViewAlive } from "./lib/player";

type Props = {
  /** Who gets it. null = a note to Saved Messages. Fixed: the form never changes the target. */
  target: Contact | null;
  /** Whatever was already typed in the bar (after `@name ` for a send). */
  initial?: string;
  /**
   * The bar's own send / save path, so the form gets the same transport code, errors and toasts.
   * Resolves true on success; the form pops only then, so a failed send keeps the text.
   */
  onSubmit: (text: string) => Promise<boolean>;
};

/**
 * Long, multi-line version of the bar. ↵ is a newline in the text area, ⌘↵ sends / saves.
 * Reached with ⌘⇧↵ from the Saved bar: `@name …` composes a message, anything else a note.
 */
export default function ComposeForm({ target, initial = "", onSubmit }: Props) {
  useViewAlive();
  const { pop } = useNavigation();
  const [busy, setBusy] = useState(false);

  async function submit(values: { text: string }) {
    const text = values.text.replace(/\s+$/, "");
    if (!text.trim()) {
      await showToast({
        style: Toast.Style.Failure,
        title: target ? "Nothing to send" : "Nothing to save",
      });
      return;
    }
    setBusy(true);
    try {
      if (await onSubmit(text)) pop();
    } finally {
      setBusy(false);
    }
  }

  const to = target
    ? `@${target.key} · ${target.label} · ${transportLabel(target.transport)}`
    : "Saved Messages · Telegram (note to self)";

  return (
    <Form
      isLoading={busy}
      navigationTitle={
        target ? `Compose to ${target.label}` : "Compose long note"
      }
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={
              target
                ? `Send to ${target.label} · ${transportLabel(target.transport)}`
                : "Save to Telegram"
            }
            icon={target ? Icon.Airplane : Icon.Upload}
            onSubmit={submit}
          />
        </ActionPanel>
      }
    >
      <Form.Description title="To" text={to} />
      <Form.TextArea
        id="text"
        title={target ? "Message" : "Note"}
        placeholder={
          target
            ? "↵ new line · ⌘↵ sends"
            : "Note to self · ↵ new line · ⌘↵ saves"
        }
        defaultValue={initial}
        autoFocus
        enableMarkdown={false}
      />
    </Form>
  );
}
