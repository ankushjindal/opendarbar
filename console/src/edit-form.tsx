import {
  Action,
  ActionPanel,
  Form,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useState } from "react";
import { useViewAlive } from "./lib/player";
import { tgs, TgsError, type SavedMessage } from "./lib/tgs";

type Props =
  | { mode: "edit"; message: SavedMessage; onDone: (m: SavedMessage) => void }
  | { mode: "add"; initial?: string; onDone: (m: SavedMessage) => void };

/** One form for both add and edit. Enter in the textarea inserts a newline; ⌘↵ submits. */
export default function EditForm(props: Props) {
  useViewAlive();
  const { pop } = useNavigation();
  const [busy, setBusy] = useState(false);
  const isEdit = props.mode === "edit";
  const initial = isEdit ? props.message.text : (props.initial ?? "");

  async function submit(values: { text: string }) {
    const text = values.text.replace(/\s+$/, "");
    if (!text.trim()) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Empty — nothing saved",
      });
      return;
    }
    if (isEdit && text === props.message.text) {
      pop();
      return;
    }
    setBusy(true);
    try {
      const m = isEdit
        ? await tgs.edit(props.message.id, text)
        : await tgs.add(text);
      await showToast({
        style: Toast.Style.Success,
        title: isEdit ? `Edited ${m.id}` : `Saved ${m.id}`,
      });
      props.onDone(m);
      pop();
    } catch (e) {
      const err = e as TgsError;
      await showToast({
        style: Toast.Style.Failure,
        title: isEdit ? "Edit failed" : "Save failed",
        message: err.message,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Form
      isLoading={busy}
      navigationTitle={
        isEdit ? `Edit ${props.message.id}` : "New saved message"
      }
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={isEdit ? "Save Edit" : "Save to Telegram"}
            onSubmit={submit}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="text"
        title=""
        placeholder="Note to self…"
        defaultValue={initial}
        autoFocus
        enableMarkdown={false}
      />
      {isEdit && (
        <Form.Description
          text={`#${props.message.id} · ${props.message.date}${props.message.edited ? " · edited" : ""}`}
        />
      )}
    </Form>
  );
}
