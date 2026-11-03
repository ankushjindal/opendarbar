import {
  Action,
  ActionPanel,
  Form,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useState } from "react";
import {
  type Contact,
  contacts,
  findContact,
  transportLabel,
} from "./lib/contacts";
import { useViewAlive } from "./lib/player";
import { SendError, sendTo } from "./lib/transports";

type Props = {
  to: Contact;
  initial?: string;
  onSent?: (c: Contact, text: string, id?: string) => void;
};

/** Multi-line message to one contact (Fleet ↵, or a long message from the bar). ⌘↵ sends. */
export default function SendForm({ to, initial = "", onSent }: Props) {
  useViewAlive();
  const { pop } = useNavigation();
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(to.key);
  const [file, setFile] = useState<string[]>([]);

  async function submit(values: { text: string; file?: string[] }) {
    const c = findContact(key) ?? to;
    const text = values.text.replace(/\s+$/, "");
    const path = values.file?.[0];
    if (!text.trim() && !path) {
      await showToast({ style: Toast.Style.Failure, title: "Nothing to send" });
      return;
    }
    setBusy(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Sending to ${c.label}…`,
    });
    try {
      const r = await sendTo(c, text, { file: path });
      toast.style = Toast.Style.Success;
      toast.title = `Sent to ${c.label} · ${transportLabel(c.transport)}`;
      onSent?.(c, text, r.id);
      pop();
    } catch (e) {
      toast.hide();
      await showToast({
        style: Toast.Style.Failure,
        title: "Send failed",
        message: (e as SendError).message,
      });
    } finally {
      setBusy(false);
    }
  }

  const current = findContact(key) ?? to;
  return (
    <Form
      isLoading={busy}
      navigationTitle={`Message ${current.label}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Send" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="to" title="To" value={key} onChange={setKey}>
        {contacts().map((c) => (
          <Form.Dropdown.Item
            key={c.key}
            value={c.key}
            title={`@${c.key} · ${c.label}`}
            keywords={[c.label, transportLabel(c.transport)]}
          />
        ))}
      </Form.Dropdown>
      <Form.TextArea
        id="text"
        title="Message"
        defaultValue={initial}
        placeholder={`${transportLabel(current.transport)} → ${current.to}`}
        autoFocus
      />
      {current.transport !== "gog" && (
        <Form.FilePicker
          id="file"
          title="Attach"
          allowMultipleSelection={false}
          canChooseDirectories={false}
          value={file}
          onChange={setFile}
        />
      )}
    </Form>
  );
}
