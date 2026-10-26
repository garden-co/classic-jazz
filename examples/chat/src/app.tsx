import { apiKey } from "@/apiKey.ts";
import { getRandomUsername, inIframe, onChatLoad } from "@/util.ts";
import { useIframeHashRouter } from "hash-slash";
import { co } from "jazz-tools";
import { JazzInspector } from "jazz-tools/inspector";
import {
  JazzReactProvider,
  useLogOut,
  useSuspenseAccount,
} from "jazz-tools/react";
import { StrictMode, useId, useMemo } from "react";
import { createRoot } from "react-dom/client";
import Jazzicon from "react-jazzicon";
import { ChatScreen } from "./chatScreen.tsx";
import { Chat } from "./schema.ts";
import { ThemeProvider } from "./themeProvider.tsx";
import { AppContainer, TopBar } from "./ui.tsx";

function stringToSeed(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

const AccountWithProfile = co.account().resolved({
  profile: true,
});

export function App() {
  const me = useSuspenseAccount(AccountWithProfile);
  const logOut = useLogOut();
  const router = useIframeHashRouter();

  const inputId = useId();

  const avatarSeed = useMemo(() => {
    return stringToSeed(me.$jazz.id);
  }, [me.$jazz.id]);

  const createChat = () => {
    const chat = Chat.create([]);

    chat.$jazz.push({ text: "Hello world" });

    router.navigate("/#/chat/" + chat.$jazz.id);

    // for https://jazz.tools marketing site demo only
    onChatLoad(chat);

    return null;
  };

  const usernamePlaceholder = "Set username";

  return (
    <AppContainer>
      <TopBar>
        <label htmlFor={inputId} className="inline-flex">
          <Jazzicon diameter={28} seed={avatarSeed} />
          <span className="sr-only">Username</span>
        </label>
        <div className="relative">
          <span
            className="absolute invisible whitespace-pre text-lg"
            aria-hidden="true"
          >
            {usernamePlaceholder}
          </span>
          <input
            type="text"
            id={inputId}
            value={me.profile.name}
            style={{ width: `${me.profile.name.length}ch` }}
            className="bg-transparent text-lg outline-none min-w-0 max-w-full"
            onChange={(e) => {
              me.profile.$jazz.set("name", e.target.value);
            }}
            placeholder={usernamePlaceholder}
          />
        </div>
        {!inIframe && (
          <button
            type="button"
            className="cursor-pointer ml-auto"
            onClick={logOut}
          >
            Log out
          </button>
        )}
      </TopBar>
      {router.route({
        "/": () => createChat(),
        "/chat/:id": (id) => <ChatScreen chatID={id} />,
      })}
    </AppContainer>
  );
}

const url = new URL(window.location.href);
const defaultProfileName = url.searchParams.get("user") ?? getRandomUsername();

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <StrictMode>
      <JazzReactProvider
        authSecretStorageKey="examples/chat"
        sync={{
          peer: `${import.meta.env.VITE_JAZZ_SYNC_URL ?? "wss://cloud.jazz.tools"}/?key=${apiKey}`,
        }}
        defaultProfileName={defaultProfileName}
      >
        <App />
        {!inIframe && <JazzInspector />}
      </JazzReactProvider>
    </StrictMode>
  </ThemeProvider>,
);
