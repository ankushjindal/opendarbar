import {
  Action,
  ActionPanel,
  Form,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useState } from "react";
import { type Contact, transportLabel } from "./lib/contacts";
import { useViewAlive } from "./lib/player";
import { isAudioPath, tgs, TgsError, type SavedMessage } from "./lib/tgs";
import { SendError, sendTo } from "./lib/transports";

type Props = {
  initialCaption?: string;
  initialFile?: string;
  /** Send to this contact instead of Saved Messages (0.3 @ mode). */
  target?: Contact;
  onDone: (m: SavedMessage) => void;
  onSent?: (c: Contact, text: string, id?: string) => void;
};

/** Save a file (photo, PDF, audio, anything) to Saved Messages — or send it to a contact — with an optional caption. ⌘↵ submits. */
export default function AttachForm({
  initialCaption = "",
  initialFile,
  target,
  onDone,
  onSent,
}: Props) {
  useViewAlive();
  const { pop } = useNavigation();
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<string[]>(initialFile ? [initialFile] : []);
  const [asVoice, setAsVoice] = useState(
    initialFile ? isAudioPath(initialFile) : false,
  );
  const audio = file[0] ? isAudioPath(file[0]) : false;
  const toContact = target && target.to !== "me" ? target : undefined;
  const where = toContact
    ? `${toContact.label} · ${transportLabel(toContact.transport)}`
    : "Telegram";

  async function submit(values: {
    file: string[];
    caption: string;
    voice: boolean;
  }) {
    const path = values.file?.[0];
    if (!path) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Pick a file first",
      });
      return;
    }
    setBusy(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: values.voice
        ? "Converting + uploading voice note…"
        : `Sending to ${where}…`,
    });
    try {
      const caption = values.caption.trim();
      if (toContact) {
        const r = await sendTo(toContact, caption, {
          file: path,
          voice: values.voice,
        });
        toast.style = Toast.Style.Success;
        toast.title = `Sent to ${where}`;
        onSent?.(toContact, caption, r.id);
      } else {
        const m = values.voice
          ? await tgs.addVoice(path, caption || undefined)
          : await tgs.addFile(path, caption || undefined);
        toast.style = Toast.Style.Success;
        toast.title = `Saved #${m.id}`;
        onDone(m);
      }
      pop();
    } catch (e) {
      toast.hide();
      await showToast({
        style: Toast.Style.Failure,
        title: "Upload failed",
        message: (e as TgsError | SendError).message,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Form
      isLoading={busy}
      navigationTitle={`Send a file to ${where}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm title={`Send to ${where}`} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.FilePicker
        id="file"
        title="File"
        allowMultipleSelection={false}
        canChooseDirectories={false}
        value={file}
        onChange={(v) => {
          setFile(v);
          if (v[0]) setAsVoice(isAudioPath(v[0]));
        }}
      />
      {(!toContact || toContact.transport === "tgs") && (
        <Form.Checkbox
          id="voice"
          label="Send as voice note"
          value={asVoice}
          onChange={setAsVoice}
          info={
            audio
              ? "Round waveform bubble in Telegram. Converted to Opus/OGG if needed."
              : "Only for audio files (m4a, mp3, wav, ogg…)."
          }
        />
      )}
      <Form.TextArea
        id="caption"
        title="Caption"
        placeholder="optional"
        defaultValue={initialCaption}
      />
    </Form>
  );
}
