import { createAuthClient } from "better-auth/client";
import { jazzPluginClient } from "jazz-tools/better-auth/auth/client";

const authClient = createAuthClient({
  plugins: [jazzPluginClient()],
});

authClient.getSession;
authClient.jazz.setJazzContext;
authClient.jazz.setAuthSecretStorage;
authClient.useSession.get().data?.user.accountID;
