import {
  Action,
  ActionPanel,
  Icon,
  List,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { useState } from "react";
import { type Contact, contacts, transportLabel } from "./lib/contacts";
import { useViewAlive } from "./lib/player";
import { firstLine, mediaLabel, tgs, type SavedMessage } from "./lib/tgs";
import { sendTo } from "./lib/transports";

type Props = {
  messages: SavedMessage[];
  onDone?: (c: Contact) => void;
};

/**
 * Forward one or more saved messages: pick a contact from the sublist, ↵ sends.
 * Telegram targets get a native forward (media intact, "Forwarded from" header).
 * Other transports get the text, plus the original file re-uploaded for media rows.
 */
export default function ForwardList({ messages, onDone }: Props) {
  useViewAlive();
  const { pop } = useNavigation();
  const [busy, setBusy] = useState(false);
  const n = messages.length;
  const what =
    n === 1
      ? firstLine(messages[0].text, 50) ||
        mediaLabel(messages[0]) ||
        `#${messages[0].id}`
      : `${n} messages`;

  async function forwardTo(c: Contact) {
    if (c.to === "me") {
      await showToast({
        style: Toast.Style.Failure,
        title: "Already in Saved",
      });
      return;
    }
    setBusy(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Forwarding to ${c.label}…`,
    });
    try {
      if (c.transport === "tgs") {
        await tgs.forward(
          messages.map((m) => m.id),
          c.to,
        );
      } else {
        for (const m of messages) {
          if (m.media) {
            const r = await tgs.media(m.id);
            await sendTo(c, m.text, {
              file: r.path,
              voice: m.media_type === "voice",
            });
          } else await sendTo(c, m.text);
        }
      }
      toast.style = Toast.Style.Success;
      toast.title = `Forwarded to ${c.label} · ${transportLabel(c.transport)}`;
      toast.message = what;
      onDone?.(c);
      pop();
    } catch (e) {
      toast.style = Toast.Style.Failure;
      toast.title = "Forward failed";
      toast.message = (e as Error).message;
    } finally {
      setBusy(false);
    }
  }

  return (
    <List
      isLoading={busy}
      navigationTitle={`Forward: ${what}`}
      searchBarPlaceholder="who gets it? ↵ forwards"
    >
      {contacts()
        .filter((c) => c.to !== "me")
        .map((c) => (
          <List.Item
            key={c.key}
            icon={c.transport === "tgs" ? Icon.Airplane : Icon.Person}
            title={`@${c.key}`}
            subtitle={c.label}
            keywords={[c.label, transportLabel(c.transport)]}
            accessories={[
              {
                text: transportLabel(c.transport),
                tooltip:
                  c.transport === "tgs"
                    ? "native Telegram forward"
                    : "text + re-uploaded file",
              },
            ]}
            actions={
              <ActionPanel>
                <Action
                  title={`Forward to ${c.label}`}
                  icon={Icon.ArrowRight}
                  onAction={() => forwardTo(c)}
                />
              </ActionPanel>
            }
          />
        ))}
    </List>
  );
}
